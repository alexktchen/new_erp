// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: storage-purge
//
// 把 storage_purge_queue 裡排好的檔案真的從 Storage 刪掉。
// pg_cron 每天跑 _storage_purge_tick()（20261028000000）：先用 SQL 決定要刪哪些圖
// （關團超過 3 個月的商品圖／開團封面），從商品／團身上拿掉並排進佇列，再打這支刪檔。
//
// 為什麼要另外一支函式：storage.objects 有 protect_objects_delete，SQL 刪不了；
// 就算繞過也只刪掉那一列、底層檔案還在。只能走 Storage API。
//
// 不驗身分（verify_jwt=false）：這支只刪佇列裡的路徑，而佇列只有 SQL 函式寫得進去
// （RLS 開著、沒有 policy、anon/authenticated 沒權限）。任何人打它，最多就是把
// 今天本來就要刪的提早刪掉。
//
// secrets：內建 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY。
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";
import { corsHeaders } from "../_shared/cors.ts";

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

// 一次刪幾個（Storage API 一次上限 1000，取小一點，失敗時影響範圍也小）
const BATCH = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // 截止時間在 handler 裡算：模組層級只在 isolate 啟動時求值一次（見 CLAUDE.md #970）。
  // 沒刪完的留在佇列，明天再撿。
  const deadline = Date.now() + 100_000;
  const sb = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  let deleted = 0;
  while (Date.now() < deadline) {
    const { data: rows, error } = await sb.rpc("rpc_storage_purge_claim", { p_limit: BATCH });
    if (error) return json({ error: error.message, deleted }, 500);
    if (!rows || rows.length === 0) break;

    const byBucket = new Map<string, string[]>();
    for (const r of rows as { bucket: string; path: string }[]) {
      const list = byBucket.get(r.bucket) ?? [];
      list.push(r.path);
      byBucket.set(r.bucket, list);
    }

    for (const [bucket, paths] of byBucket) {
      const { error: rmErr } = await sb.storage.from(bucket).remove(paths);
      const { error: doneErr } = await sb.rpc("rpc_storage_purge_done", {
        p_bucket: bucket,
        p_paths: paths,
        p_error: rmErr ? rmErr.message : null,
      });
      if (doneErr) return json({ error: doneErr.message, deleted }, 500);
      // 刪檔失敗就停：已記 attempts，明天再試；滿 5 次不再撿
      if (rmErr) return json({ error: rmErr.message, deleted }, 502);
      deleted += paths.length;
    }
  }

  return json({ deleted });
});
