"use client";

import { useEffect, useState } from "react";
import { consumeFragmentToSession, getSession } from "@/lib/session";

export default function MePage() {
  const [memberId, setMemberId] = useState<number | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [lineName, setLineName] = useState<string | null>(null);
  const [linePicture, setLinePicture] = useState<string | null>(null);
  const [lineUserId, setLineUserId] = useState<string | null>(null);

  useEffect(() => {
    consumeFragmentToSession();
    const s = getSession();
    if (s) {
      setMemberId(s.memberId);
      setStoreId(s.storeId);
      setLineName(s.lineName);
      setLinePicture(s.linePicture);
      setLineUserId(s.lineUserId);
    }
    const sp = new URLSearchParams(window.location.search);
    const mid = sp.get("member_id");
    if (mid && !s?.memberId) setMemberId(Number(mid));
  }, []);

  if (!memberId && !lineUserId) {
    return (
      <main className="mx-auto max-w-md p-6 pt-16 text-center">
        <p className="text-sm text-zinc-500">尚未登入，請回首頁。</p>
        <a href="/" className="mt-4 inline-block text-sm text-blue-600 hover:underline">回首頁</a>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-5 p-6 pt-10">
      <h1 className="text-xl font-semibold">會員中心</h1>

      <div className="rounded-md border border-[#06C755]/30 bg-[#06C755]/5 p-4">
        <div className="flex items-center gap-3">
          {linePicture && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={linePicture} alt="" className="h-14 w-14 rounded-full" />
          )}
          <div className="flex-1">
            <div className="text-xs text-zinc-500">✓ 已綁定 LINE</div>
            <div className="text-lg font-semibold">{lineName ?? "(未提供姓名)"}</div>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          {memberId && (
            <>
              <dt className="text-zinc-500">會員 ID</dt>
              <dd className="font-mono">{memberId}</dd>
            </>
          )}
          {storeId && (
            <>
              <dt className="text-zinc-500">門市代號</dt>
              <dd>{storeId}</dd>
            </>
          )}
          {lineUserId && (
            <>
              <dt className="text-zinc-500">LINE ID</dt>
              <dd className="font-mono break-all text-xs">{lineUserId}</dd>
            </>
          )}
        </dl>
      </div>

      <p className="text-xs text-zinc-400">
        會員卡 QR、點數、訂單等功能尚未上線（MVP-1 開發中）。
      </p>
    </main>
  );
}
