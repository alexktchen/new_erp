"use client";

import { useEffect, useState } from "react";
import { lineOauthStartUrl, callLiffApi } from "@/lib/supabase";
import { loadLiff } from "@/lib/liff";
import { getSession, listenForSession } from "@/lib/session";

type Status = "loading" | "idle" | "liff_auth" | "error";

export default function LandingPage() {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [inputStoreId, setInputStoreId] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  // PWA Sync Code
  const [syncCode, setSyncCode] = useState("");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    // 1. 檢查是否已有 Session (自動登入)
    const existing = getSession();
    if (existing) {
      window.location.href = "/me";
      return;
    }

    // 2. 監聽跨視窗登入 (BroadcastChannel)
    const unlisten = listenForSession(() => {
      window.location.href = "/me";
    });

    (async () => {
      const errInUrl = new URLSearchParams(window.location.search).get("error");
      if (errInUrl) setError(errInUrl);

      const liffId = process.env.NEXT_PUBLIC_LIFF_ID;

      // 1. 讀取門市 (URL > localStorage)
      let s = readStore();
      if (!s && typeof window !== "undefined") {
        s = localStorage.getItem("last_store_id");
      }
      
      if (s) {
        setStoreId(s);
        localStorage.setItem("last_store_id", s);
      }

      // 2. LIFF 初始化與自動登入
      if (liffId) {
        try {
          const liff = await loadLiff();
          await liff.init({ liffId });

          const sFromLiff = readStore();
          if (sFromLiff) {
            s = sFromLiff;
            setStoreId(s);
            localStorage.setItem("last_store_id", s);
          }

          if (!s) {
            setStatus("idle");
            return;
          }

          if (liff.isInClient()) {
            setStatus("liff_auth");
            if (!liff.isLoggedIn()) {
              liff.login();
              return;
            }
            const idToken = liff.getIDToken();
            if (!idToken) throw new Error("LIFF getIDToken returned null");
            await runLiffSession(idToken, s);
            return;
          }
        } catch (e) {
          console.warn("liff init failed, falling back:", e);
        }
      }

      setStatus("idle");
    })();

    return unlisten;
  }, []);

  const start = () => {
    if (!storeId) return;
    window.location.href = lineOauthStartUrl(storeId);
  };

  const handleManualStoreSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = inputStoreId.trim().toUpperCase();
    if (!s) return;
    setStoreId(s);
    localStorage.setItem("last_store_id", s);
  };

  const handleSyncSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (syncCode.length !== 6 || syncing) return;
    
    setSyncing(true);
    setError(null);
    try {
      const data = await callLiffApi<any>("PUBLIC", {
        action: "claim_pwa_auth_code",
        code: syncCode,
      });

      // 模擬 consumeFragmentToSession 的行為，手動存入 localStorage
      const frag = new URLSearchParams({
        token:        data.token,
        store:        data.store,
        bound:        "1",
        member_id:    String(data.member_id),
        line_user_id: data.line_user_id,
        line_name:    data.line_name ?? "",
        line_picture: data.line_picture ?? "",
      });
      window.location.href = `/me#${frag.toString()}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "驗證碼無效或已過期");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-md flex-col items-center gap-6 p-6 pt-16">
      <h1 className="text-3xl font-semibold">團購店會員</h1>
      
      {status === "loading" && <p className="text-base text-zinc-400">載入中…</p>}

      {status === "liff_auth" && <p className="text-base text-zinc-500">LINE 驗證中…請稍候</p>}

      {status === "idle" && (
        <div className="w-full space-y-6 text-center">
          {error && (
            <div className="w-full rounded-md border border-red-200 bg-red-50 p-3 text-base text-red-800 text-left">
              發生錯誤：{error}
            </div>
          )}

          {!storeId ? (
            <div className="space-y-4">
              <p className="text-base text-zinc-500">歡迎！請輸入您的門市代號以開始：</p>
              <form onSubmit={handleManualStoreSubmit} className="flex flex-col gap-3">
                <input
                  type="text"
                  placeholder="例如: S001"
                  value={inputStoreId}
                  onChange={(e) => setInputStoreId(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-4 py-3 text-lg focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800"
                  autoFocus
                />
                <button
                  type="submit"
                  className="w-full rounded-md bg-indigo-600 px-4 py-3 text-base font-medium text-white shadow hover:bg-indigo-700 transition"
                >
                  進入門市
                </button>
              </form>
            </div>
          ) : (
            <div className="space-y-8">
              <div className="space-y-4">
                <p className="text-base text-zinc-500">您目前位於 <span className="font-bold text-zinc-900 dark:text-zinc-100">{storeId}</span> 門市</p>
                <button
                  onClick={start}
                  className="w-full rounded-md bg-[#06C755] px-4 py-3 text-base font-medium text-white shadow hover:bg-[#05b04c] transition"
                >
                  用 LINE 註冊 / 登入
                </button>
              </div>

              <div className="relative py-4">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-zinc-200"></span></div>
                <div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-2 text-zinc-400 dark:bg-zinc-950">或者</span></div>
              </div>

              <div className="space-y-4 rounded-xl border border-zinc-200 p-4 bg-zinc-50/50">
                <p className="text-sm text-zinc-500">如果您已在瀏覽器登入，請輸入驗證碼：</p>
                <form onSubmit={handleSyncSubmit} className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="6 位數驗證碼"
                    value={syncCode}
                    onChange={(e) => setSyncCode(e.target.value)}
                    className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-center font-mono text-xl tracking-widest focus:border-indigo-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={syncCode.length !== 6 || syncing}
                    className="rounded-md bg-indigo-600 px-4 py-2 text-base font-medium text-white shadow disabled:opacity-50"
                  >
                    {syncing ? "..." : "驗證"}
                  </button>
                </form>
              </div>

              <button
                onClick={() => { setStoreId(null); setInputStoreId(""); }}
                className="text-sm text-zinc-400 hover:text-zinc-600 underline"
              >
                更換其他門市
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mt-8 text-center text-xs text-zinc-400 space-y-1">
        <p>New ERP 會員系統</p>
        <p>Version 0.1.0 (PWA Ready)</p>
      </div>
    </main>
  );
}

function readStore(): string | null {
  const sp = new URLSearchParams(window.location.search);
  const s = sp.get("store");
  if (s) return s;
  const raw = sp.get("liff.state");
  if (raw) {
    const inner = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
    return inner.get("store");
  }
  return null;
}

async function runLiffSession(idToken: string, storeId: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");

  const resp = await fetch(`${base}/functions/v1/liff-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: idToken, store: storeId }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      (data as { error?: string; detail?: string }).detail
      ?? (data as { error?: string }).error
      ?? `liff-session ${resp.status}`,
    );
  }

  const frag = new URLSearchParams({
    token:        String(data.token),
    store:        String(data.store),
    bound:        "1",
    member_id:    String(data.member_id),
    line_user_id: String(data.line_user_id ?? ""),
  });
  if (data.line_name)    frag.set("line_name",    String(data.line_name));
  if (data.line_picture) frag.set("line_picture", String(data.line_picture));
  window.location.href = `/me#${frag.toString()}`;
}
