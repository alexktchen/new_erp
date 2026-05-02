"use client";

import Link from "next/link";
import Countdown from "./Countdown";

export type CampaignSummary = {
  id: number;
  campaign_no: string;
  name: string;
  description: string | null;
  cover_image_url: string | null;
  end_at: string | null;
  pickup_deadline: string | null;
  item_count: number;
  min_price: number;
  max_price: number;
};

/**
 * 蝦皮風卡片 + Uber Eats 大字級。
 * variant=hero 用在限時專區頭一張(更大)、grid 用在列表。
 */
export default function CampaignCard({
  campaign,
  variant = "grid",
}: {
  campaign: CampaignSummary;
  variant?: "grid" | "hero";
}) {
  const href = `/shop/c/${campaign.id}`;
  const priceText = campaign.min_price > 0
    ? `$${campaign.min_price.toLocaleString()}${campaign.max_price > campaign.min_price ? " 起" : ""}`
    : "—";

  if (variant === "hero") {
    return (
      <Link
        href={href}
        className="block overflow-hidden rounded-2xl bg-[var(--card-bg)] shadow-[0_2px_8px_rgba(0,0,0,0.08)] active:opacity-90"
      >
        <div className="relative aspect-[16/9] w-full bg-[#7676801a]">
          {campaign.cover_image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={campaign.cover_image_url}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-5xl">📦</div>
          )}
          {campaign.end_at && (
            <div className="absolute left-3 top-3 rounded-full bg-black/65 px-3 py-1 text-[14px] font-medium text-white backdrop-blur">
              限時 <Countdown target={campaign.end_at} compact />
            </div>
          )}
        </div>
        <div className="space-y-1.5 px-4 py-3">
          <h3 className="text-[22px] font-bold leading-tight text-[var(--foreground)]">
            {campaign.name}
          </h3>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[28px] font-bold tabular-nums text-[var(--brand-strong)] leading-none">
              {priceText}
            </span>
            <span className="text-[13px] text-[var(--secondary-label)]">
              共 {campaign.item_count} 項
            </span>
          </div>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className="block overflow-hidden rounded-2xl bg-[var(--card-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] active:opacity-90"
    >
      <div className="relative aspect-square w-full bg-[#7676801a]">
        {campaign.cover_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={campaign.cover_image_url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-4xl">📦</div>
        )}
      </div>
      <div className="space-y-1 px-3 py-2.5">
        <h3 className="line-clamp-2 text-[17px] font-semibold leading-tight text-[var(--foreground)]">
          {campaign.name}
        </h3>
        <div className="text-[24px] font-bold tabular-nums text-[var(--brand-strong)] leading-none">
          {priceText}
        </div>
        {campaign.end_at && (
          <div className="text-[13px] text-[var(--secondary-label)]">
            <Countdown target={campaign.end_at} />
          </div>
        )}
      </div>
    </Link>
  );
}
