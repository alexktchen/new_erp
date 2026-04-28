"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";

type Row = {
  id: number;
  sku_id: number;
  sku_code: string;
  product_name: string | null;
  variant_name: string | null;
  unit_price: number;
  cap_qty: number | null;
  sort_order: number;
  notes: string | null;
};

export function CampaignItemsTable({ campaignId }: { campaignId: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const { data, error: err } = await getSupabase()
      .from("campaign_items")
      .select("id, sku_id, unit_price, cap_qty, sort_order, notes, skus!inner(id, sku_code, product_name, variant_name)")
      .eq("campaign_id", campaignId)
      .order("sort_order");
    if (err) { setError(err.message); return; }
    setRows(
      (data as unknown as Array<{
        id: number; sku_id: number; unit_price: number; cap_qty: number | null;
        sort_order: number; notes: string | null;
        skus: { id: number; sku_code: string; product_name: string | null; variant_name: string | null };
      }>).map((r) => ({
        id: r.id, sku_id: r.sku_id, sku_code: r.skus.sku_code,
        product_name: r.skus.product_name, variant_name: r.skus.variant_name,
        unit_price: Number(r.unit_price), cap_qty: r.cap_qty != null ? Number(r.cap_qty) : null,
        sort_order: r.sort_order, notes: r.notes,
      }))
    );
  };

  useEffect(() => { reload(); }, [campaignId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">商品明細</h2>
        <span className="text-xs text-zinc-500">{rows?.length ?? 0} 項</span>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{error}</div>
      )}

      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <Th>規格</Th><Th>名稱</Th><Th className="text-right">單價</Th><Th className="text-right">量上限</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows === null ? (
              <tr><td colSpan={4} className="p-3 text-center text-zinc-500">載入中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} className="p-6 text-center text-zinc-500">尚無商品</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono">{r.sku_code}</Td>
                <Td>
                  <div>{r.product_name ?? "—"}</div>
                  {r.variant_name && <div className="text-xs text-zinc-500">{r.variant_name}</div>}
                </Td>
                <Td className="text-right font-mono">${r.unit_price}</Td>
                <Td className="text-right text-xs text-zinc-500">{r.cap_qty ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 ${className}`}>{children}</td>;
}
