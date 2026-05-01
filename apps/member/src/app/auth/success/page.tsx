"use client";

import { useEffect, useState } from "react";
import { consumeFragmentToSession } from "@/lib/session";

export default function AuthSuccessPage() {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    // 1. 先從 Hash 抓 (因為 line-oauth-callback 把它放在 fragment)
    const hash = window.location.hash.replace(/^#/, "");
    if (hash) {
      const hp = new URLSearchParams(hash);
      const c = hp.get("code");
      if (c) setCode(c);
    }

    // 2. 備援：從 Query 抓
    const sp = new URLSearchParams(window.location.search);
    const qc = sp.get("code");
    if (qc) setCode(qc);

    // 3. 處理登入並清理 Hash (這會清空網址)
    consumeFragmentToSession();
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col items-center gap-8 p-6 pt-16 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
        <svg className="h-10 w-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-bold">LINE 驗證成功</h1>
        <p className="text-base text-zinc-500">
          如果您是從桌面瀏覽器登入，請直接點擊下方按鈕：
        </p>
        <a 
          href="/me" 
          className="inline-block rounded-md bg-[#06C755] px-6 py-2.5 text-base font-medium text-white shadow"
        >
          進入會員中心
        </a>
      </div>

      {code && (
        <div className="w-full space-y-4 rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50 p-6">
          <p className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
            如果您正在使用 PWA App
          </p>
          <p className="text-base text-zinc-600">
            請回到 App 並輸入此 6 位數驗證碼：
          </p>
          <div className="text-5xl font-mono font-bold tracking-[0.5em] text-indigo-600">
            {code}
          </div>
          <p className="text-xs text-zinc-400">
            此驗證碼將於 5 分鐘後失效
          </p>
        </div>
      )}

      <p className="text-sm text-zinc-400">
        完成驗證後，您可以關閉此視窗。
      </p>
    </main>
  );
}
