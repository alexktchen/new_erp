"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MemberDetail } from "@/components/MemberDetail";

export default function MemberDetailPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-zinc-500">載入中…</div>}>
      <Body />
    </Suspense>
  );
}

function Body() {
  const id = useSearchParams().get("id");
  if (!id) {
    return (
      <div className="mx-auto max-w-4xl p-6 text-sm text-red-700">缺少 id 參數</div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
      <Link href="/members" className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:hover:text-zinc-200">
        ← 會員列表
      </Link>
      <MemberDetail memberId={Number(id)} />
    </div>
  );
}
