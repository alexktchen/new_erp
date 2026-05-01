"use client";

import { useEffect, useState } from "react";
import { lineOauthStartUrl } from "@/lib/supabase";
import { loadLiff } from "@/lib/liff";

type Status = "loading" | "idle" | "liff_auth" | "error";

export default function LandingPage() {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [inputStoreId, setInputStoreId] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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

          // 若 init 完發現 URL 有變 (liff.state 還原)，再次嘗試讀取
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

  return (
    <main className="mx-auto flex w-full max-w-md flex-col items-center gap-6 p-6 pt-16">
      <h1 className="text-3xl font-semibold">團購店會員</h1>
      
      {status === "loading" && <p className="text-base text-zinc-400">載入中…</p>}

      {status === "liff_auth" && <p className="text-base text-zinc-500">LINE 驗證中…請稍候</p>}

      {status === "idle" && (
        <div className="w-full space-y-6 text-center">
          {error && (
            <div className="w-full rounded-md border border-red-200 bg-red-50 p-3 text-base text-red-800 text-left">
              登入失敗：{error}
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
            <div className="space-y-6">
              <p className="text-base text-zinc-500">您目前位於 <span className="font-bold text-zinc-900 dark:text-zinc-100">{storeId}</span> 門市</p>
              
              <button
                onClick={start}
                className="w-full rounded-md bg-[#06C755] px-4 py-3 text-base font-medium text-white shadow hover:bg-[#05b04c] transition"
              >
                用 LINE 註冊 / 登入
              </button>

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
  // liff.init 後 liff.state 已展開；直接讀 search
  const sp = new URLSearchParams(window.location.search);
  const s = sp.get("store");
  if (s) return s;

  // 備援：少數情境 liff.init 沒展開時、自己從 liff.state 解
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
