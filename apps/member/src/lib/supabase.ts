import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * 以 custom JWT 認證的 Supabase client（目前未使用，保留給未來讀取 RLS 保護的資料用）
 */
export function getSupabase(jwt: string | null): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: jwt
      ? { headers: { Authorization: `Bearer ${jwt}` } }
      : undefined,
  });
}

export function lineOauthStartUrl(storeId: string, pairCode?: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  const url = new URL(`${base}/functions/v1/line-oauth-start`);
  url.searchParams.set("store", storeId);
  if (pairCode) url.searchParams.set("pair", pairCode);
  return url.toString();
}

/**
 * 呼叫 liff-api Edge Function（所有會員端 DB 操作走這支，不直接打 PostgREST）。
 * 原因：我們簽的 HS256 JWT 過不了 Supabase PostgREST（已切 ECC P-256）。
 */
export async function callLiffApi<T = unknown>(
  jwt: string,
  body: Record<string, unknown>,
): Promise<T> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");

  const resp = await fetch(`${base}/functions/v1/liff-api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data as { error?: string; detail?: string }).error
      ?? `liff-api ${resp.status}`;
    const err = new Error(msg);
    (err as Error & { detail?: unknown }).detail = (data as { detail?: unknown }).detail;
    throw err;
  }
  return data as T;
}
