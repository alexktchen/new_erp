// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: line-oauth-callback
// 登記在 LINE Login Callback URL；GET /functions/v1/line-oauth-callback?code=...&state=...
//
// 流程：
//   1. 驗 state → 取出 store_id
//   2. code → exchange → id_token
//   3. verify id_token → line_user_id (sub)
//   4. 查 member_line_bindings (tenant, store, line_user_id)
//      - 已綁 → 簽 member JWT（role=authenticated + member_id）
//      - 未綁 → 簽 pending JWT（role=authenticated + line_user_id + store_id，無 member_id）
//   5. 302 redirect 回前端 /auth/complete#token=...&bound=0|1&member_id=...
// ─────────────────────────────────────────────────────────────────────────────

import { corsHeaders } from "../_shared/cors.ts";
import { signJwtHs256, verifyStateToken } from "../_shared/jwt.ts";
import { exchangeCode, verifyIdToken } from "../_shared/line.ts";

const SESSION_TTL_SEC = 60 * 60; // 1h

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const code   = url.searchParams.get("code");
    const state  = url.searchParams.get("state");
    const error  = url.searchParams.get("error");

    if (error) return redirectFront("/", { error });
    if (!code || !state) {
      return redirectFront("/", { error: "missing_code_or_state" });
    }

    // env
    const channelId     = requireEnv("LINE_CHANNEL_ID");
    const channelSecret = requireEnv("LINE_CHANNEL_SECRET");
    const callbackUrl   = requireEnv("LINE_CALLBACK_URL");
    const stateSecret   = requireEnv("LINE_STATE_SECRET");
    const jwtSecret     = requireEnv("PROJECT_JWT_SECRET");
    const supabaseUrl   = requireEnv("SUPABASE_URL");
    const serviceKey    = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const tenantId      = requireEnv("DEFAULT_TENANT_ID"); // v1 單 tenant

    // 1) state
    const { store_id: storeId } = await verifyStateToken(state, stateSecret);

    // 2) code → token
    const tokens = await exchangeCode({
      code,
      redirectUri: callbackUrl,
      channelId,
      channelSecret,
    });

    // 3) verify id_token
    const payload = await verifyIdToken({
      idToken: tokens.id_token,
      channelId,
    });
    const lineUserId = payload.sub;

    // 4) lookup binding via REST (service role)
    const bindingUrl =
      `${supabaseUrl}/rest/v1/member_line_bindings` +
      `?select=member_id&tenant_id=eq.${tenantId}` +
      `&store_id=eq.${storeId}&line_user_id=eq.${lineUserId}` +
      `&unbound_at=is.null&limit=1`;

    const resp = await fetch(bindingUrl, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`binding lookup failed ${resp.status}: ${t}`);
    }
    const rows = await resp.json() as Array<{ member_id: number }>;
    let memberId: number | null = rows.length > 0 ? rows[0].member_id : null;

    // 5) 未綁 → auto-register：用 LINE 個資建會員 + 綁定（省略註冊表單）
    //    placeholder phone 用 "line:<uid>"（保證唯一、不會撞真實手機）
    //    之後使用者可在設定頁補填真實 phone / 生日
    if (!memberId) {
      memberId = await autoRegister({
        supabaseUrl,
        serviceKey,
        tenantId,
        storeId,
        lineUserId,
        lineName: payload.name ?? null,
        linePicture: payload.picture ?? null,
      });
    }

    // 6) sign session JWT（memberId 保證有值）
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwtHs256(
      {
        iss: "supabase",
        role: "authenticated",
        aud: "authenticated",
        exp: now + SESSION_TTL_SEC,
        tenant_id: tenantId,
        store_id: storeId,
        line_user_id: lineUserId,
        sub: String(memberId),
        member_id: memberId,
      },
      jwtSecret,
    );

    // 7) redirect 回前端 /me（token 放 fragment 不進 log）
    const params = new URLSearchParams({
      bound: "1",
      store: storeId,
      member_id: String(memberId),
    });
    if (payload.name) params.set("line_name", payload.name);
    if (payload.picture) params.set("line_picture", payload.picture);
    params.set("line_user_id", lineUserId);
    return redirectFrontWithFragment(
      "/me",
      params.toString() + `&token=${encodeURIComponent(jwt)}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("oauth callback error:", msg);
    return redirectFront("/", { error: "oauth_failed", detail: msg });
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function frontBase(): string {
  return Deno.env.get("MEMBER_FRONT_BASE_URL") ?? "http://localhost:3001";
}

function redirectFront(path: string, qs: Record<string, string>): Response {
  const url = new URL(path, frontBase());
  for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}

function redirectFrontWithFragment(path: string, fragment: string): Response {
  const url = new URL(path, frontBase());
  return Response.redirect(`${url.toString()}#${fragment}`, 302);
}

// ─── auto-register ───────────────────────────────────────────────────────────

/**
 * 第一次登入的使用者：用 LINE 個資自動建會員 + 綁定，省略註冊表單。
 * 同時把 LINE 大頭照下載、存進 Supabase Storage。
 * phone 先用 "line:<uid>" placeholder（使用者之後可在設定頁改真實 phone）。
 */
async function autoRegister(p: {
  supabaseUrl: string;
  serviceKey: string;
  tenantId: string;
  storeId: string;
  lineUserId: string;
  lineName: string | null;
  linePicture?: string | null;
}): Promise<number> {
  const authHeaders = {
    apikey: p.serviceKey,
    Authorization: `Bearer ${p.serviceKey}`,
  };

  // phone placeholder — hash("line:<uid>")
  const placeholderPhone = `line:${p.lineUserId}`;
  const phoneHash = await sha256Hex(placeholderPhone);

  // 檢查 phone_hash 是否已存在（避免重入時撞 UNIQUE）
  const existingUrl =
    `${p.supabaseUrl}/rest/v1/members?select=id&tenant_id=eq.${p.tenantId}` +
    `&phone_hash=eq.${phoneHash}&limit=1`;
  const existingResp = await fetch(existingUrl, { headers: authHeaders });
  const existing = await existingResp.json() as Array<{ id: number }>;
  let memberId: number;

  if (existing.length > 0) {
    memberId = existing[0].id;
  } else {
    // 產 member_no
    const now = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const memberNo = `M${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(Math.floor(Math.random() * 1000), 3)}`;

    // 先 insert 拿到 id（avatar_url 稍後 update）
    const insertResp = await fetch(`${p.supabaseUrl}/rest/v1/members`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        tenant_id: p.tenantId,
        member_no: memberNo,
        phone_hash: phoneHash,
        phone: placeholderPhone,
        name: p.lineName ?? "(未提供)",
        home_store_id: Number(p.storeId),
        status: "active",
      }),
    });
    if (!insertResp.ok) {
      throw new Error(`insert member failed ${insertResp.status}: ${await insertResp.text()}`);
    }
    const inserted = await insertResp.json() as Array<{ id: number }>;
    memberId = inserted[0].id;
  }

  // 下載 LINE 頭像、存 Supabase Storage（失敗不擋註冊）
  if (p.linePicture) {
    try {
      await uploadAvatar({
        supabaseUrl: p.supabaseUrl,
        serviceKey: p.serviceKey,
        memberId,
        lineUserId: p.lineUserId,
        pictureUrl: p.linePicture,
        authHeaders,
      });
    } catch (e) {
      console.warn("avatar upload failed (non-fatal):", e);
    }
  }

  // INSERT binding（衝突 = 已綁、視為 idempotent）
  const bindResp = await fetch(`${p.supabaseUrl}/rest/v1/member_line_bindings`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({
      tenant_id: p.tenantId,
      store_id: Number(p.storeId),
      member_id: memberId,
      line_user_id: p.lineUserId,
    }),
  });
  if (!bindResp.ok && bindResp.status !== 409) {
    throw new Error(`insert binding failed ${bindResp.status}: ${await bindResp.text()}`);
  }

  return memberId;
}

async function uploadAvatar(p: {
  supabaseUrl: string;
  serviceKey: string;
  memberId: number;
  lineUserId: string;
  pictureUrl: string;
  authHeaders: Record<string, string>;
}) {
  // 下載 LINE 頭像
  const imgResp = await fetch(p.pictureUrl);
  if (!imgResp.ok) throw new Error(`download avatar ${imgResp.status}`);
  const contentType = imgResp.headers.get("content-type") ?? "image/jpeg";
  const ext = contentType.includes("png") ? "png" :
              contentType.includes("webp") ? "webp" : "jpg";
  const blob = await imgResp.arrayBuffer();

  // 上傳 Supabase Storage（以 line_user_id 當檔名、可 upsert）
  const path = `line-${p.lineUserId}.${ext}`;
  const uploadResp = await fetch(
    `${p.supabaseUrl}/storage/v1/object/member-avatars/${path}`,
    {
      method: "POST",
      headers: {
        ...p.authHeaders,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body: blob,
    },
  );
  if (!uploadResp.ok) {
    throw new Error(`upload avatar ${uploadResp.status}: ${await uploadResp.text()}`);
  }

  // 公開 URL
  const publicUrl = `${p.supabaseUrl}/storage/v1/object/public/member-avatars/${path}`;

  // 更新 members.avatar_url
  const updateResp = await fetch(
    `${p.supabaseUrl}/rest/v1/members?id=eq.${p.memberId}`,
    {
      method: "PATCH",
      headers: {
        ...p.authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ avatar_url: publicUrl }),
    },
  );
  if (!updateResp.ok) {
    throw new Error(`update avatar_url ${updateResp.status}: ${await updateResp.text()}`);
  }
}

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
