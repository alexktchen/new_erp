import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyJwtHs256 } from "../_shared/jwt.ts";
import webpush from "https://esm.sh/web-push@3.6.7";

// ─── helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function maskName(name: string | null): string | null {
  if (!name) return null;
  if (name.length <= 1) return name;
  return name[0] + "*".repeat(name.length - 1);
}

// ─── actions ─────────────────────────────────────────────────────────────────

async function claimPwaAuthCode(
  sb: any,
  code: string,
) {
  // 接受 6 碼人工驗證碼或 8–64 碼 pairing token（PWA → LIFF 自動配對用）
  if (!code || (code.length !== 6 && (code.length < 8 || code.length > 64))) {
    return json({ error: "invalid code format" }, 400);
  }
  const { data: row, error: fetchErr } = await sb
    .from("pwa_auth_codes")
    .select("*")
    .eq("code", code)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (fetchErr || !row) {
    return json({ error: "code invalid or expired" }, 404);
  }
  await sb.from("pwa_auth_codes").delete().eq("id", row.id);
  return json(row.session_data);
}

async function lookupByPhone(sb: any, tenantId: string, phone: string) {
  if (!phone.trim()) return json({ error: "phone required" }, 400);
  const hash = await sha256Hex(phone.trim());
  const { data, error } = await sb
    .from("members")
    .select("id, member_no, name, home_store_id")
    .eq("tenant_id", tenantId)
    .eq("phone_hash", hash)
    .not("status", "in", "(deleted,merged)")
    .limit(1);
  if (error) return json({ error: error.message }, 500);
  if (!data || data.length === 0) return json({ match: null });
  const row = data[0];
  let homeStoreName: string | null = null;
  if (row.home_store_id) {
    const { data: s } = await sb.from("stores").select("name").eq("id", row.home_store_id).single();
    homeStoreName = s?.name ?? null;
  }
  return json({
    match: {
      member_id: row.id,
      member_no: row.member_no,
      name_masked: maskName(row.name),
      home_store_name: homeStoreName,
    },
  });
}

async function registerAndBind(sb: any, p: any) {
  if (!p.phone.trim()) return json({ error: "phone required" }, 400);
  const { data: store } = await sb.from("stores").select("id").eq("id", p.storeId).eq("tenant_id", p.tenantId).single();
  if (!store) return json({ error: "store not in tenant" }, 400);
  const phoneHash = await sha256Hex(p.phone.trim());
  const { data: existing } = await sb.from("members").select("id").eq("tenant_id", p.tenantId).eq("phone_hash", phoneHash).not("status", "in", "(deleted,merged)").limit(1);
  let memberId: number;
  let isNewMember = false;
  if (existing && existing.length > 0) {
    memberId = existing[0].id;
  } else {
    if (!p.name.trim()) return json({ error: "name required" }, 400);
    if (!p.birthday.trim()) return json({ error: "birthday required" }, 400);
    const now = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const memberNo = `M${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(Math.floor(Math.random() * 1000), 3)}`;
    const { data: inserted, error: insertErr } = await sb.from("members").insert({
        tenant_id: p.tenantId,
        member_no: memberNo,
        phone_hash: phoneHash,
        phone: p.phone.trim(),
        name: p.name.trim(),
        birthday: p.birthday,
        birth_md: p.birthday.slice(5, 10),
        home_store_id: p.storeId,
        status: "active",
      }).select("id").single();
    if (insertErr || !inserted) return json({ error: "insert member failed", detail: insertErr?.message }, 500);
    memberId = inserted.id;
    isNewMember = true;
  }
  let wasBound = false;
  const { error: bindErr } = await sb.from("member_line_bindings").insert({
      tenant_id: p.tenantId,
      store_id: p.storeId,
      member_id: memberId,
      line_user_id: p.lineUserId,
    });
  if (bindErr && bindErr.code === "23505") wasBound = true;
  else if (bindErr) return json({ error: "insert binding failed", detail: bindErr.message }, 500);
  return json({ member_id: memberId, is_new_member: isNewMember, was_bound: wasBound });
}

async function getMe(sb: any, tenantId: string, memberId: number) {
  const { data, error } = await sb.from("members").select("id, member_no, name, phone, email, birthday, gender, home_store_id, avatar_url, status").eq("tenant_id", tenantId).eq("id", memberId).single();
  if (error) return json({ error: error.message }, 500);
  return json({
    ...data,
    member_id: data.id,
    phone: data.phone?.startsWith("line:") ? null : data.phone,
  });
}

async function updateMe(sb: any, tenantId: string, memberId: number, p: any) {
  const patch: any = {};
  if (p.name !== undefined) {
    const n = p.name.trim();
    if (!n) return json({ error: "name cannot be empty" }, 400);
    patch.name = n;
  }
  if (p.phone !== undefined) {
    const ph = p.phone.trim();
    if (ph) {
      if (!/^09\d{8}$/.test(ph)) return json({ error: "phone format invalid" }, 400);
      const newHash = await sha256Hex(ph);
      const { data: conflict } = await sb.from("members").select("id").eq("tenant_id", tenantId).eq("phone_hash", newHash).neq("id", memberId).limit(1);
      if (conflict && conflict.length > 0) return json({ error: "此手機號已被其他會員使用" }, 409);
      patch.phone = ph;
      patch.phone_hash = newHash;
    }
  }
  if (p.birthday !== undefined) {
    const b = p.birthday.trim();
    if (b) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b)) return json({ error: "birthday format invalid" }, 400);
      patch.birthday = b;
      patch.birth_md = b.slice(5, 10);
    }
  }
  if (p.email !== undefined) {
    const em = p.email.trim();
    if (em) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return json({ error: "email format invalid" }, 400);
      patch.email = em;
      patch.email_hash = await sha256Hex(em.toLowerCase());
    } else {
      patch.email = null;
      patch.email_hash = null;
    }
  }
  if (Object.keys(patch).length === 0) return json({ error: "nothing to update" }, 400);
  patch.updated_at = new Date().toISOString();
  const { error } = await sb.from("members").update(patch).eq("tenant_id", tenantId).eq("id", memberId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function getOverview(sb: any, tenantId: string, storeId: number, memberId: number) {
  const { data: storeRow, error: sErr } = await sb.from("stores").select("id, code, name, banner_url, description, payment_methods_text, shipping_methods_text").eq("tenant_id", tenantId).eq("id", storeId).single();
  if (sErr || !storeRow) return json({ error: "store not found" }, 404);
  const { data: unpaidRows } = await sb.from("v_customer_order_summary").select("payable_amount").eq("tenant_id", tenantId).eq("member_id", memberId).eq("store_id", storeId).eq("payment_status", "unpaid").not("status", "in", "(cancelled,expired)");
  const receivable = (unpaidRows ?? []).reduce((s: number, r: any) => s + Number(r.payable_amount ?? 0), 0);
  const { count: activeCount } = await sb.from("v_customer_order_summary").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("member_id", memberId).eq("store_id", storeId).not("status", "in", "(completed,cancelled,expired)");
  return json({ store: storeRow, receivable_amount: receivable, active_orders_count: activeCount ?? 0 });
}

async function listMyOrders(sb: any, tenantId: string, storeId: number, memberId: number, tab: string) {
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 6);
  let q = sb.from("v_customer_order_summary").select("*").eq("tenant_id", tenantId).eq("member_id", memberId).eq("store_id", storeId).gte("created_at", cutoff.toISOString()).order("created_at", { ascending: false }).limit(100);
  if (tab === "active") q = q.not("status", "in", "(completed,cancelled,expired)");
  else q = q.eq("status", "completed");
  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ orders: data ?? [] });
}

async function listMySettlements(sb: any, tenantId: string, storeId: number, memberId: number, tab: string) {
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 6);
  let q = sb.from("v_customer_order_summary").select("*").eq("tenant_id", tenantId).eq("member_id", memberId).eq("store_id", storeId).gte("created_at", cutoff.toISOString()).order("created_at", { ascending: false }).limit(100);
  if (tab === "unpaid") q = q.eq("payment_status", "unpaid").not("status", "in", "(cancelled,expired)");
  else q = q.in("status", ["shipping", "completed"]);
  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ settlements: data ?? [] });
}

async function upsertPushSubscription(sb: any, tenantId: string, memberId: number, p: any) {
  if (!p.endpoint) return json({ error: "endpoint required" }, 400);
  
  const rpcParams = {
    p_endpoint: p.endpoint,
    p_p256dh: p.p256dh,
    p_auth: p.auth,
    p_user_agent: p.user_agent || p.userAgent, 
    p_member_id: memberId,
    p_tenant_id: tenantId,
  };

  const { data: insertedId, error } = await sb.rpc("rpc_upsert_push_subscription", rpcParams);
  
  if (error) {
    console.error("rpc_upsert_push_subscription error:", error);
    return json({ error: error.message, details: error }, 500);
  }
  
  return json({ ok: true, id: insertedId, debug: rpcParams });
}

// ─── main ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const sb = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });

    // ── [NEW] 特殊 action：領取 PWA 驗證碼 (完全不需要 Token) ──
    if (action === "claim_pwa_auth_code") return await claimPwaAuthCode(sb, String(body.code ?? ""));

    const auth = req.headers.get("authorization");
    if (!auth) return json({ error: "missing authorization" }, 401);
    const token = auth.replace(/^Bearer\s+/i, "");
    const jwtSecret = requireEnv("PROJECT_JWT_SECRET");
    let claims;
    try { claims = await verifyJwtHs256(token, jwtSecret); } catch (e) { return json({ error: "invalid token", detail: String(e) }, 401); }

    const tenantId = String(claims.tenant_id ?? "");
    const storeId = Number(claims.store_id ?? 0);
    const lineUserId = String(claims.line_user_id ?? "");
    const memberId = claims.member_id ? Number(claims.member_id) : null;
    if (!tenantId || !storeId || !lineUserId) return json({ error: "missing claims in token" }, 401);

    switch (action) {
      case "lookup_by_phone": return await lookupByPhone(sb, tenantId, String(body.phone ?? ""));
      case "register_and_bind": return await registerAndBind(sb, { tenantId, storeId, lineUserId, phone: String(body.phone ?? ""), name: String(body.name ?? ""), birthday: String(body.birthday ?? "") });
      case "get_me": if (!memberId) return json({ error: "no member_id" }, 401); return await getMe(sb, tenantId, memberId);
      case "update_me": if (!memberId) return json({ error: "no member_id" }, 401); return await updateMe(sb, tenantId, memberId, body);
      case "get_overview": if (!memberId) return json({ error: "no member_id" }, 401); return await getOverview(sb, tenantId, storeId, memberId);
      case "list_my_orders": if (!memberId) return json({ error: "no member_id" }, 401); return await listMyOrders(sb, tenantId, storeId, memberId, String(body.tab ?? ""));
      case "list_my_settlements": if (!memberId) return json({ error: "no member_id" }, 401); return await listMySettlements(sb, tenantId, storeId, memberId, String(body.tab ?? ""));
      case "upsert_push_subscription": if (!memberId) return json({ error: "no member_id" }, 401); return await upsertPushSubscription(sb, tenantId, memberId, body);
      default: return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error("liff-api error:", e);
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
