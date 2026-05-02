"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { consumeFragmentToSession, getSession } from "@/lib/session";
import { callLiffApi } from "@/lib/supabase";
import PageShell from "@/components/PageShell";
import Countdown from "@/components/Countdown";

type CampaignDetail = {
  id: number;
  campaign_no: string;
  name: string;
  description: string | null;
  cover_image_url: string | null;
  status: string;
  end_at: string | null;
  pickup_deadline: string | null;
};

type Item = {
  campaign_item_id: number;
  sku_id: number;
  sku_code: string | null;
  product_name: string | null;
  variant_name: string | null;
  image_url: string | null;
  unit_price: number;
  cap_qty: number | null;
};

export default function CampaignDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = Number(params?.id);

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [qtyMap, setQtyMap] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // confirm sheet
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [doneOrderNo, setDoneOrderNo] = useState<string | null>(null);

  useEffect(() => {
    consumeFragmentToSession();
    const s = getSession();
    if (!s || !s.memberId) {
      router.replace("/");
      return;
    }
    if (!id) return;
    (async () => {
      try {
        const d = await callLiffApi<{ campaign: CampaignDetail; items: Item[] }>(s.token, {
          action: "get_campaign_detail",
          campaign_id: id,
        });
        setCampaign(d.campaign);
        setItems(d.items);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id, router]);

  const totalQty = useMemo(
    () => Object.values(qtyMap).reduce((s, n) => s + (n || 0), 0),
    [qtyMap],
  );

  const totalAmount = useMemo(() => {
    let sum = 0;
    for (const it of items) {
      const q = qtyMap[it.campaign_item_id] ?? 0;
      sum += q * Number(it.unit_price);
    }
    return sum;
  }, [items, qtyMap]);

  const setQty = (ciId: number, q: number, cap: number | null) => {
    const max = cap != null ? cap : 999;
    const next = Math.max(0, Math.min(max, q));
    setQtyMap((prev) => ({ ...prev, [ciId]: next }));
  };

  const submit = async () => {
    const s = getSession();
    if (!s) return;
    const ordered = Object.entries(qtyMap)
      .map(([k, v]) => ({ campaign_item_id: Number(k), qty: Number(v) }))
      .filter((x) => x.qty > 0);
    if (ordered.length === 0) {
      alert("請先選擇數量");
      return;
    }
    setSubmitting(true);
    try {
      const r = await callLiffApi<{ order_no: string }>(s.token, {
        action: "place_member_order",
        campaign_id: id,
        items: ordered,
        notes: notes.trim() || null,
      });
      setDoneOrderNo(r.order_no);
    } catch (e) {
      alert(`下單失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell title={campaign?.name ?? "商品"}>
      <div className="space-y-4 px-0 pb-[160px]">
        {loading && (
          <p className="px-5 pt-2 text-[16px] text-[var(--tertiary-label)]">載入中…</p>
        )}

        {err && (
          <div className="mx-4 rounded-2xl bg-[#ff3b30]/10 p-3 text-[15px] text-[#c4271d]">
            {err}
          </div>
        )}

        {campaign && (
          <>
            {/* 封面 — 優先用第一個商品項目的圖,沒有再退到開團 cover */}
            <div className="relative aspect-[4/3] w-full bg-[#7676801a]">
              {(items[0]?.image_url ?? campaign.cover_image_url) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={items[0]?.image_url ?? campaign.cover_image_url ?? ""}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-6xl">📦</div>
              )}
              {campaign.end_at && (
                <div className="absolute right-3 top-3 rounded-full bg-black/70 px-3 py-1 text-[14px] font-medium text-white backdrop-blur">
                  剩 <Countdown target={campaign.end_at} compact className="text-white" />
                </div>
              )}
            </div>

            {/* 標題 + 描述 */}
            <div className="space-y-2 px-4">
              <h1 className="text-[26px] font-bold leading-tight text-[var(--foreground)]">
                {campaign.name}
              </h1>
              {campaign.description && (
                <p className="whitespace-pre-wrap text-[16px] leading-relaxed text-[var(--secondary-label)]">
                  {campaign.description}
                </p>
              )}
              {campaign.pickup_deadline && (
                <p className="text-[14px] text-[var(--tertiary-label)]">
                  取貨期限：{campaign.pickup_deadline}
                </p>
              )}
            </div>

            {/* SKU 列表 */}
            <section className="px-4">
              <h2 className="pb-2 pt-1 text-[20px] font-bold text-[var(--foreground)]">
                商品項目
              </h2>
              <div className="overflow-hidden rounded-2xl bg-[var(--card-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                {items.length === 0 ? (
                  <div className="px-4 py-8 text-center text-[15px] text-[var(--tertiary-label)]">
                    尚無商品
                  </div>
                ) : (
                  items.map((it, idx) => (
                    <SkuRow
                      key={it.campaign_item_id}
                      item={it}
                      qty={qtyMap[it.campaign_item_id] ?? 0}
                      onChange={(q) => setQty(it.campaign_item_id, q, it.cap_qty)}
                      isLast={idx === items.length - 1}
                    />
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </div>

      {/* sticky 底部下單列 */}
      {campaign && items.length > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--separator)] bg-white/95 backdrop-blur-xl"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}
        >
          <div className="mx-auto flex max-w-md items-center justify-between gap-3 px-4 pt-3">
            <div>
              <div className="text-[12px] text-[var(--secondary-label)]">總計 {totalQty} 件</div>
              <div className="text-[28px] font-bold tabular-nums text-[var(--brand-strong)] leading-none">
                ${totalAmount.toLocaleString()}
              </div>
            </div>
            <button
              disabled={totalQty === 0}
              onClick={() => setSheetOpen(true)}
              className="rounded-full bg-[var(--ios-blue)] px-6 py-3 text-[17px] font-semibold text-white active:opacity-80 disabled:opacity-40"
            >
              立即下單
            </button>
          </div>
        </div>
      )}

      {/* Confirm sheet */}
      {sheetOpen && (
        <ConfirmSheet
          campaignName={campaign?.name ?? ""}
          items={items.filter((it) => (qtyMap[it.campaign_item_id] ?? 0) > 0).map((it) => ({
            ...it,
            qty: qtyMap[it.campaign_item_id]!,
          }))}
          totalAmount={totalAmount}
          notes={notes}
          onNotes={setNotes}
          onClose={() => setSheetOpen(false)}
          onSubmit={submit}
          submitting={submitting}
        />
      )}

      {/* Done sheet */}
      {doneOrderNo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center">
            <div className="text-5xl">✅</div>
            <h3 className="mt-3 text-[22px] font-bold text-[var(--foreground)]">下單成功</h3>
            <p className="mt-1 font-mono text-[14px] text-[var(--secondary-label)]">
              {doneOrderNo}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => router.push("/orders")}
                className="flex-1 rounded-xl bg-[#7676801f] py-3 text-[16px] font-medium text-[var(--foreground)] active:bg-[#76768033]"
              >
                查看訂單
              </button>
              <button
                onClick={() => router.push("/shop")}
                className="flex-1 rounded-xl bg-[var(--ios-blue)] py-3 text-[16px] font-semibold text-white active:opacity-80"
              >
                繼續逛
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}

function SkuRow({
  item,
  qty,
  onChange,
  isLast,
}: {
  item: Item;
  qty: number;
  onChange: (q: number) => void;
  isLast: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3.5 ${isLast ? "" : "border-b border-[var(--separator)]"}`}
    >
      <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl bg-[#7676801a]">
        {item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.image_url} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-2xl">📦</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[16px] font-medium leading-tight text-[var(--foreground)]">
          {item.product_name ?? `SKU#${item.sku_id}`}
        </div>
        {item.variant_name && (
          <div className="text-[13px] text-[var(--secondary-label)]">{item.variant_name}</div>
        )}
        <div className="mt-0.5 text-[20px] font-bold tabular-nums text-[var(--brand-strong)] leading-none">
          ${Number(item.unit_price).toLocaleString()}
        </div>
      </div>
      <Stepper qty={qty} onChange={onChange} max={item.cap_qty ?? 999} />
    </div>
  );
}

function Stepper({
  qty,
  onChange,
  max,
}: {
  qty: number;
  onChange: (q: number) => void;
  max: number;
}) {
  if (qty === 0) {
    return (
      <button
        onClick={() => onChange(1)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white text-[22px] font-light leading-none active:opacity-80"
      >
        +
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => onChange(qty - 1)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-[#7676801a] text-[18px] font-medium text-[var(--foreground)] active:bg-[#76768033]"
      >
        −
      </button>
      <span className="min-w-[1.5em] text-center text-[18px] font-semibold tabular-nums text-[var(--foreground)]">
        {qty}
      </span>
      <button
        onClick={() => onChange(qty + 1)}
        disabled={qty >= max}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ios-blue)] text-[18px] font-medium text-white active:opacity-80 disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}

function ConfirmSheet({
  campaignName,
  items,
  totalAmount,
  notes,
  onNotes,
  onClose,
  onSubmit,
  submitting,
}: {
  campaignName: string;
  items: (Item & { qty: number })[];
  totalAmount: number;
  notes: string;
  onNotes: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40">
      <div
        className="rounded-t-3xl bg-[var(--background)] shadow-2xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-2.5">
          <div className="h-1 w-10 rounded-full bg-[#7676804d]" />
        </div>

        <div className="px-5 pt-3 pb-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-[24px] font-bold text-[var(--foreground)]">確認訂單</h2>
            <button
              onClick={onClose}
              className="text-[15px] text-[var(--ios-blue)]"
              disabled={submitting}
            >
              取消
            </button>
          </div>
          <p className="mt-1 text-[14px] text-[var(--secondary-label)]">{campaignName}</p>
        </div>

        <div className="space-y-3 px-4 pb-4">
          {/* 項目 recap */}
          <section className="overflow-hidden rounded-2xl bg-[var(--card-bg)]">
            {items.map((it, idx) => (
              <div
                key={it.campaign_item_id}
                className={`flex items-center justify-between gap-3 px-4 py-3 ${idx > 0 ? "border-t border-[var(--separator)]" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-1 text-[16px] text-[var(--foreground)]">
                    {it.product_name ?? `SKU#${it.sku_id}`}
                    {it.variant_name && (
                      <span className="ml-1 text-[var(--secondary-label)]">/ {it.variant_name}</span>
                    )}
                  </div>
                  <div className="text-[13px] text-[var(--secondary-label)]">
                    ${Number(it.unit_price).toLocaleString()} × {it.qty}
                  </div>
                </div>
                <div className="text-[17px] font-medium tabular-nums text-[var(--foreground)]">
                  ${(Number(it.unit_price) * it.qty).toLocaleString()}
                </div>
              </div>
            ))}
          </section>

          {/* 取貨 */}
          <section className="overflow-hidden rounded-2xl bg-[var(--card-bg)] px-4 py-3">
            <div className="text-[12px] uppercase tracking-wide text-[var(--tertiary-label)]">取貨</div>
            <div className="mt-1 text-[16px] text-[var(--foreground)]">您的主要門市（自動配貨）</div>
            <div className="text-[12px] text-[var(--tertiary-label)] mt-0.5">
              如需更改取貨點請與店家聯繫
            </div>
          </section>

          {/* 備註 */}
          <section className="overflow-hidden rounded-2xl bg-[var(--card-bg)] px-4 py-3">
            <div className="text-[12px] uppercase tracking-wide text-[var(--tertiary-label)]">備註</div>
            <textarea
              value={notes}
              onChange={(e) => onNotes(e.target.value)}
              placeholder="想跟店家說的話（可選）"
              maxLength={200}
              rows={2}
              className="mt-1 w-full resize-none bg-transparent text-[16px] text-[var(--foreground)] outline-none placeholder:text-[var(--tertiary-label)]"
            />
          </section>

          {/* Total + submit */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <div>
              <div className="text-[13px] text-[var(--secondary-label)]">應付金額</div>
              <div className="text-[30px] font-bold tabular-nums text-[var(--brand-strong)] leading-none">
                ${totalAmount.toLocaleString()}
              </div>
            </div>
            <button
              onClick={onSubmit}
              disabled={submitting}
              className="rounded-full bg-[var(--ios-blue)] px-7 py-3.5 text-[18px] font-semibold text-white active:opacity-80 disabled:opacity-50"
            >
              {submitting ? "送出中…" : "確認下單"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
