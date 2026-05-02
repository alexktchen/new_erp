"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { consumeFragmentToSession, getSession } from "@/lib/session";
import { callLiffApi } from "@/lib/supabase";
import PageShell from "@/components/PageShell";
import PullToRefresh from "@/components/PullToRefresh";
import CampaignCard, { type CampaignSummary } from "@/components/CampaignCard";
import Countdown from "@/components/Countdown";

export default function ShopPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const fetchCampaigns = useCallback(async () => {
    const s = getSession();
    if (!s || !s.memberId) {
      router.replace("/");
      return;
    }
    setErr(null);
    try {
      const d = await callLiffApi<{ campaigns: CampaignSummary[] }>(s.token, {
        action: "list_active_campaigns",
      });
      setCampaigns(d.campaigns);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [router]);

  useEffect(() => {
    consumeFragmentToSession();
    (async () => {
      await fetchCampaigns();
      setLoading(false);
    })();
  }, [fetchCampaigns]);

  // 結單最近的那張當 hero(限時專區封面)
  const hero = campaigns[0];

  return (
    <PageShell title="商品">
      <PullToRefresh onRefresh={fetchCampaigns}>
      <div className="space-y-5 px-4 pt-2 pb-6">
        {loading && (
          <p className="px-1 text-[16px] text-[var(--tertiary-label)]">載入中…</p>
        )}

        {err && (
          <div className="rounded-2xl bg-[#ff3b30]/10 p-3 text-[15px] text-[#c4271d]">
            {err}
          </div>
        )}

        {!loading && !err && campaigns.length === 0 && (
          <div className="py-16 text-center">
            <div className="text-4xl">🛒</div>
            <p className="mt-2 text-[16px] text-[var(--tertiary-label)]">
              目前沒有進行中的團購
            </p>
          </div>
        )}

        {/* 限時專區 banner */}
        {hero && (
          <Link
            href="/shop/flash"
            className="block overflow-hidden rounded-2xl active:opacity-90"
          >
            <div className="relative">
              <div className="relative aspect-[16/8] w-full bg-gradient-to-br from-[#ff3b30] to-[#ff9500]">
                {hero.cover_image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={hero.cover_image_url}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover opacity-40"
                  />
                )}
                <div className="absolute inset-0 flex flex-col justify-between p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-[18px]">⚡</span>
                    <span className="text-[20px] font-bold text-white">限時專區</span>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[14px] text-white/85">最快結單</div>
                    <div className="text-[26px] font-bold text-white">
                      {hero.end_at ? <Countdown target={hero.end_at} compact /> : "—"}
                    </div>
                  </div>
                </div>
                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 text-[28px]">›</div>
              </div>
            </div>
          </Link>
        )}

        {/* 進行中商品 grid */}
        {campaigns.length > 0 && (
          <section>
            <h2 className="px-1 pb-2 text-[20px] font-bold text-[var(--foreground)]">
              進行中商品
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {campaigns.map((c) => (
                <CampaignCard key={c.id} campaign={c} />
              ))}
            </div>
          </section>
        )}
      </div>
      </PullToRefresh>
    </PageShell>
  );
}
