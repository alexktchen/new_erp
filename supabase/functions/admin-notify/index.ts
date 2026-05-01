import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyJwtHs256 } from "../_shared/jwt.ts";
import webpush from "https://esm.sh/web-push@3.6.7";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const auth = req.headers.get("authorization");
    if (!auth) return json({ error: "missing authorization" }, 401);
    
    const token = auth.replace(/^Bearer\s+/i, "");
    const jwtSecret = requireEnv("PROJECT_JWT_SECRET");
    let claims;
    try {
      claims = await verifyJwtHs256(token, jwtSecret);
    } catch (e) {
      return json({ error: "invalid token", detail: String(e) }, 401);
    }

    const tenantId = String(claims.tenant_id ?? "");
    if (!tenantId) return json({ error: "missing tenant_id in token" }, 401);

    // Optional: Check role if implemented, for now we assume anyone with tenant_id in admin app is authorized
    // const role = claims.role;

    const body = await req.json();
    const { member_id, title, message, url } = body;

    if (!member_id) return json({ error: "member_id is required" }, 400);

    const sb = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    // Get subscriptions for this member
    const { data: subs, error: subErr } = await sb
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("tenant_id", tenantId)
      .eq("member_id", member_id);

    if (subErr) return json({ error: subErr.message }, 500);
    if (!subs || subs.length === 0) {
      return json({ ok: false, message: "No active PWA subscriptions found for this member" });
    }

    webpush.setVapidDetails(
      "mailto:admin@new-erp.com",
      requireEnv("VAPID_PUBLIC_KEY"),
      requireEnv("VAPID_PRIVATE_KEY")
    );

    const results = await Promise.allSettled(
      subs.map((s: any) =>
        webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          JSON.stringify({
            title: title || "測試通知",
            body: message || "這是一則來自管理員的測試通知。",
            url: url || "/",
          })
        )
      )
    );

    const successCount = results.filter((r) => r.status === "fulfilled").length;
    const failCount = results.filter((r) => r.status === "rejected").length;

    // Optional: Cleanup failed subscriptions (e.g. 410 Gone)
    // For a test button, we might just report back.

    return json({
      ok: true,
      sent: successCount,
      failed: failCount,
      details: results.map((r, i) => ({
        endpoint: subs[i].endpoint,
        status: r.status,
        error: r.status === "rejected" ? (r as PromiseRejectedResult).reason : undefined,
      })),
    });
  } catch (e) {
    console.error("admin-notify error:", e);
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
