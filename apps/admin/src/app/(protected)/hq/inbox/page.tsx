"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import SpinButton from "@/components/SpinButton";
import { RowAction } from "@/components/RowAction";
import { OrderDetail } from "@/components/OrderDetail";
import { Modal } from "@/components/Modal";
import { AidOrderStatusActions } from "@/components/AidOrderStatusActions";
import { ORDER_STATUS_LABEL as AID_STATUS_LABEL, type OrderStatus as AidStatus } from "@/lib/orderStatus";

type Stage = "pending" | "in_transit" | "done" | "rejected";
type SourceTag = "restock" | "transfer" | "aid" | "shortage";

const STAGE_LABEL: Record<Stage, string> = {
  pending: "待處理",
  in_transit: "在途",
  done: "已完成",
  rejected: "已拒絕 / 取消",
};

const STAGE_COLOR: Record<Stage, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  in_transit: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

const SOURCE_LABEL: Record<SourceTag, string> = {
  restock: "補貨申請",
  transfer: "轉貨單",
  aid: "互助訂單",
  shortage: "⚠️ 短少訂單",
};

const SOURCE_COLOR: Record<SourceTag, string> = {
  restock: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  transfer: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  aid: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  shortage: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

const RESOLUTION_LABEL: Record<string, string> = {
  notified: "✓ 已通知客戶",
  cancelled: "✓ 已取消退款",
  reallocated: "✓ 已改派",
  waiting_next_po: "⏳ 等下批 PO",
};

type RestockRaw = {
  id: number;
  status: "pending" | "approved_transfer" | "approved_pr" | "shipped" | "received" | "rejected" | "cancelled";
  notes: string | null;
  rejected_reason: string | null;
  linked_transfer_id: number | null;
  linked_pr_id: number | null;
  linked_transfer_no: string | null;
  linked_pr_no: string | null;
  store_name: string | null;
  requested_at: string;
  line_count: number;
  total_amount: number;
};

type TransferRaw = {
  id: number;
  transfer_no: string;
  source_location: number;
  dest_location: number;
  status: string;
  transfer_type: string;
  shipping_temp: string | null;
  is_air_transfer: boolean;
  hq_notes: string | null;
  shipped_at: string | null;
  received_at: string | null;
  created_at: string;
  source_name: string;
  dest_name: string;
  line_count: number;
};

type AidRaw = {
  id: number;
  order_no: string;
  status: AidStatus;
  is_air_transfer: boolean | null;
  pickup_store_id: number | null;
  store_name: string | null;
  campaign_no: string | null;
  updated_at: string;
  line_count: number;
};

type ShortageRaw = {
  order_id: number;
  order_no: string;
  member_id: number | null;
  store_name: string | null;
  order_status: string;
  shortage_resolution: string | null;
  shortage_notified_at: string | null;
  // 該訂單裡所有短缺品項聚合
  short_items: { sku_id: number; sku_label: string; order_qty: number; demand_unfulfillable: number }[];
  total_unfulfillable: number;
  order_updated_at: string;
};

type Row =
  | { key: string; source: "restock"; ts: number; stage: Stage; raw: RestockRaw }
  | { key: string; source: "transfer"; ts: number; stage: Stage; raw: TransferRaw }
  | { key: string; source: "aid"; ts: number; stage: Stage; raw: AidRaw }
  | { key: string; source: "shortage"; ts: number; stage: Stage; raw: ShortageRaw };

function classifyRestock(s: RestockRaw["status"]): Stage {
  if (s === "pending") return "pending";
  if (s === "approved_transfer" || s === "approved_pr" || s === "shipped") return "in_transit";
  if (s === "received") return "done";
  return "rejected";
}

function classifyTransfer(t: TransferRaw): Stage {
  if (t.status === "draft" || t.status === "confirmed") return "pending";
  if (t.status === "shipped") return "in_transit";
  if (t.status === "received") return "done";
  return "rejected";
}

function classifyAid(s: AidStatus): Stage {
  if (s === "pending" || s === "confirmed") return "pending";
  if (s === "shipping") return "in_transit";
  if (s === "ready" || s === "completed" || s === "partially_completed") return "done";
  return "rejected";
}

function classifyShortage(resolution: string | null): Stage {
  if (resolution === null) return "pending";              // 還沒處理
  if (resolution === "notified") return "in_transit";     // 已通知客戶
  if (resolution === "waiting_next_po") return "in_transit"; // 等下批
  if (resolution === "cancelled" || resolution === "reallocated") return "done";
  return "pending";
}

// === Status → Stage 對應(server-side 過濾用)===
const RESTOCK_STATUS_BY_STAGE: Record<Stage, string[]> = {
  pending: ["pending"],
  in_transit: ["approved_transfer", "approved_pr", "shipped"],
  done: ["received"],
  rejected: ["rejected", "cancelled"],
};
const TRANSFER_STATUS_BY_STAGE: Record<Stage, string[]> = {
  pending: ["draft", "confirmed"],
  in_transit: ["shipped"],
  done: ["received"],
  rejected: ["cancelled"],
};
const AID_STATUS_BY_STAGE: Record<Stage, AidStatus[]> = {
  pending: ["pending", "confirmed"],
  in_transit: ["shipping"],
  done: ["ready", "completed", "partially_completed"],
  rejected: ["cancelled"],
};
const SHORTAGE_RESOLUTION_BY_STAGE: Record<Stage, string[] | null> = {
  pending: null, // resolution IS NULL
  in_transit: ["notified", "waiting_next_po"],
  done: ["cancelled", "reallocated"],
  rejected: [], // never
};

const PAGE_SIZE = 20;

// === 各來源的 server-side fetcher(回 { rows, total })===
type SBClient = ReturnType<typeof getSupabase>;

async function fetchRestockRows(
  sb: SBClient,
  stage: Stage | null,
  page: number,
  dateFrom: string,
  dateTo: string,
): Promise<{ rows: Row[]; total: number }> {
  let q = sb
    .from("restock_requests")
    .select(
      "id, status, notes, rejected_reason, linked_transfer_id, linked_pr_id, requested_at, stores!inner(name)",
      { count: "exact" },
    )
    .order("requested_at", { ascending: false });
  if (stage) q = q.in("status", RESTOCK_STATUS_BY_STAGE[stage]);
  if (dateFrom) q = q.gte("requested_at", `${dateFrom}T00:00:00`);
  if (dateTo) q = q.lte("requested_at", `${dateTo}T23:59:59.999`);
  const start = (page - 1) * PAGE_SIZE;
  q = q.range(start, start + PAGE_SIZE - 1);
  const { data, count, error } = await q;
  if (error) throw new Error("restock: " + error.message);
  const rsRows = (data ?? []) as unknown as Array<RestockRaw & { stores?: { name: string } }>;

  const reqIds = rsRows.map((r) => r.id);
  const lineMap = new Map<number, { count: number; total: number }>();
  if (reqIds.length > 0) {
    const { data: lineData } = await sb
      .from("restock_request_lines")
      .select("request_id, qty, unit_price")
      .in("request_id", reqIds);
    for (const l of (lineData ?? []) as { request_id: number; qty: number; unit_price: number }[]) {
      const slot = lineMap.get(l.request_id) ?? { count: 0, total: 0 };
      slot.count += 1;
      slot.total += Number(l.qty) * Number(l.unit_price);
      lineMap.set(l.request_id, slot);
    }
  }
  const xferIds = rsRows.map((r) => r.linked_transfer_id).filter((x): x is number => !!x);
  const prIds = rsRows.map((r) => r.linked_pr_id).filter((x): x is number => !!x);
  const xferNoMap = new Map<number, string>();
  const prNoMap = new Map<number, string>();
  if (xferIds.length > 0) {
    const { data: xs } = await sb.from("transfers").select("id, transfer_no").in("id", xferIds);
    for (const x of (xs ?? []) as { id: number; transfer_no: string }[]) xferNoMap.set(x.id, x.transfer_no);
  }
  if (prIds.length > 0) {
    const { data: ps } = await sb.from("purchase_requests").select("id, pr_no").in("id", prIds);
    for (const p of (ps ?? []) as { id: number; pr_no: string }[]) prNoMap.set(p.id, p.pr_no);
  }

  const rows: Row[] = rsRows.map((r) => ({
    key: `restock-${r.id}`,
    source: "restock" as const,
    ts: new Date(r.requested_at).getTime(),
    stage: classifyRestock(r.status),
    raw: {
      id: r.id,
      status: r.status,
      notes: r.notes,
      rejected_reason: r.rejected_reason,
      linked_transfer_id: r.linked_transfer_id,
      linked_pr_id: r.linked_pr_id,
      linked_transfer_no: r.linked_transfer_id ? xferNoMap.get(r.linked_transfer_id) ?? null : null,
      linked_pr_no: r.linked_pr_id ? prNoMap.get(r.linked_pr_id) ?? null : null,
      store_name: r.stores?.name ?? null,
      requested_at: r.requested_at,
      line_count: lineMap.get(r.id)?.count ?? 0,
      total_amount: lineMap.get(r.id)?.total ?? 0,
    },
  }));
  return { rows, total: count ?? 0 };
}

async function fetchTransferRows(
  sb: SBClient,
  stage: Stage | null,
  page: number,
  dateFrom: string,
  dateTo: string,
): Promise<{ rows: Row[]; total: number }> {
  let q = sb
    .from("transfers")
    .select(
      "id, transfer_no, source_location, dest_location, status, transfer_type, shipping_temp, is_air_transfer, hq_notes, shipped_at, received_at, created_at",
      { count: "exact" },
    )
    .order("id", { ascending: false });
  if (stage) q = q.in("status", TRANSFER_STATUS_BY_STAGE[stage]);
  if (dateFrom) q = q.gte("created_at", `${dateFrom}T00:00:00`);
  if (dateTo) q = q.lte("created_at", `${dateTo}T23:59:59.999`);
  const start = (page - 1) * PAGE_SIZE;
  q = q.range(start, start + PAGE_SIZE - 1);
  const { data, count, error } = await q;
  if (error) throw new Error("transfers: " + error.message);
  const trs = (data as TransferRaw[] | null) ?? [];

  const locIds = Array.from(new Set(trs.flatMap((t) => [t.source_location, t.dest_location])));
  const locNameMap = new Map<number, string>();
  if (locIds.length > 0) {
    const { data: lr } = await sb.from("locations").select("id, name").in("id", locIds);
    for (const l of (lr ?? []) as { id: number; name: string }[]) locNameMap.set(l.id, l.name);
  }
  const tIds = trs.map((t) => t.id);
  const tLineMap = new Map<number, number>();
  if (tIds.length > 0) {
    const { data: tl } = await sb.from("transfer_items").select("transfer_id").in("transfer_id", tIds);
    for (const it of (tl ?? []) as { transfer_id: number }[]) {
      tLineMap.set(it.transfer_id, (tLineMap.get(it.transfer_id) ?? 0) + 1);
    }
  }

  const rows: Row[] = trs.map((t) => ({
    key: `transfer-${t.id}`,
    source: "transfer" as const,
    ts: new Date(t.created_at).getTime(),
    stage: classifyTransfer(t),
    raw: {
      ...t,
      source_name: locNameMap.get(t.source_location) ?? `#${t.source_location}`,
      dest_name: locNameMap.get(t.dest_location) ?? `#${t.dest_location}`,
      line_count: tLineMap.get(t.id) ?? 0,
    },
  }));
  return { rows, total: count ?? 0 };
}

async function fetchAidRows(
  sb: SBClient,
  stage: Stage | null,
  page: number,
  dateFrom: string,
  dateTo: string,
  aidMode: "all" | "air" | "via_warehouse",
  aidStatus: string,
): Promise<{ rows: Row[]; total: number }> {
  let q = sb
    .from("customer_orders")
    .select(
      `id, order_no, status, is_air_transfer, pickup_store_id, updated_at,
       campaign:group_buy_campaigns(id, campaign_no, name),
       store:stores!customer_orders_pickup_store_id_fkey(id, name),
       items:customer_order_items!inner(id, source)`,
      { count: "exact" },
    )
    .eq("items.source", "aid_transfer")
    .order("updated_at", { ascending: false });
  if (stage) q = q.in("status", AID_STATUS_BY_STAGE[stage] as string[]);
  if (aidStatus) q = q.eq("status", aidStatus);
  if (aidMode === "air") q = q.eq("is_air_transfer", true);
  if (aidMode === "via_warehouse") q = q.eq("is_air_transfer", false);
  if (dateFrom) q = q.gte("updated_at", `${dateFrom}T00:00:00`);
  if (dateTo) q = q.lte("updated_at", `${dateTo}T23:59:59.999`);
  const start = (page - 1) * PAGE_SIZE;
  q = q.range(start, start + PAGE_SIZE - 1);
  const { data, count, error } = await q;
  if (error) throw new Error("aid: " + error.message);

  const aidRows = (data ?? []) as unknown as Array<{
    id: number;
    order_no: string;
    status: AidStatus;
    is_air_transfer: boolean | null;
    pickup_store_id: number | null;
    updated_at: string;
    campaign?: { id: number; campaign_no: string; name: string } | null;
    store?: { id: number; name: string } | null;
    items?: { id: number }[];
  }>;

  const rows: Row[] = aidRows.map((a) => ({
    key: `aid-${a.id}`,
    source: "aid" as const,
    ts: new Date(a.updated_at).getTime(),
    stage: classifyAid(a.status),
    raw: {
      id: a.id,
      order_no: a.order_no,
      status: a.status,
      is_air_transfer: a.is_air_transfer,
      pickup_store_id: a.pickup_store_id,
      store_name: a.store?.name ?? null,
      campaign_no: a.campaign?.campaign_no ?? null,
      updated_at: a.updated_at,
      line_count: a.items?.length ?? 0,
    },
  }));
  return { rows, total: count ?? 0 };
}

async function fetchShortageRows(
  sb: SBClient,
  stage: Stage | null,
  page: number,
  dateFrom: string,
  dateTo: string,
): Promise<{ rows: Row[]; total: number }> {
  // v_order_shortage 是 (order × sku) 維度,需多撈再聚合。
  // 先做簡化版:抓所有相關 row,client-side 聚合 + 切頁。
  let q = sb
    .from("v_order_shortage")
    .select(
      "order_id, order_no, member_id, store_name, order_status, shortage_resolution, shortage_notified_at, sku_id, product_name, variant_name, sku_code, order_qty, demand_unfulfillable, order_updated_at",
    )
    .order("order_updated_at", { ascending: false });
  if (stage) {
    const resolutions = SHORTAGE_RESOLUTION_BY_STAGE[stage];
    if (resolutions === null) q = q.is("shortage_resolution", null);
    else if (resolutions.length === 0) return { rows: [], total: 0 };
    else q = q.in("shortage_resolution", resolutions);
  }
  if (dateFrom) q = q.gte("order_updated_at", `${dateFrom}T00:00:00`);
  if (dateTo) q = q.lte("order_updated_at", `${dateTo}T23:59:59.999`);
  // v_order_shortage 是 (order × sku) 維度,撈夠多 row 才能聚合出正確 distinct 訂單數
  q = q.limit(20000);
  const { data, error } = await q;
  if (error) throw new Error("shortage: " + error.message);

  type ShortageRowRaw = {
    order_id: number;
    order_no: string;
    member_id: number | null;
    store_name: string | null;
    order_status: string;
    shortage_resolution: string | null;
    shortage_notified_at: string | null;
    sku_id: number;
    product_name: string | null;
    variant_name: string | null;
    sku_code: string | null;
    order_qty: number;
    demand_unfulfillable: number;
    order_updated_at: string;
  };
  const shortageRaw = (data ?? []) as ShortageRowRaw[];
  const shortageByOrder = new Map<number, ShortageRaw>();
  for (const r of shortageRaw) {
    let s = shortageByOrder.get(r.order_id);
    if (!s) {
      s = {
        order_id: r.order_id,
        order_no: r.order_no,
        member_id: r.member_id,
        store_name: r.store_name,
        order_status: r.order_status,
        shortage_resolution: r.shortage_resolution,
        shortage_notified_at: r.shortage_notified_at,
        short_items: [],
        total_unfulfillable: 0,
        order_updated_at: r.order_updated_at,
      };
      shortageByOrder.set(r.order_id, s);
    }
    const skuLabel = `${r.product_name ?? ""}${r.variant_name ? ` / ${r.variant_name}` : ""}`.trim() || `品項#${r.sku_id}`;
    s.short_items.push({
      sku_id: r.sku_id,
      sku_label: r.sku_code ? `${r.sku_code} ${skuLabel}` : skuLabel,
      order_qty: Number(r.order_qty),
      demand_unfulfillable: Number(r.demand_unfulfillable),
    });
    s.total_unfulfillable += Number(r.demand_unfulfillable);
  }
  const allOrderRows = Array.from(shortageByOrder.values());
  const total = allOrderRows.length;
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = allOrderRows.slice(start, start + PAGE_SIZE);
  const rows: Row[] = pageRows.map((s) => ({
    key: `shortage-${s.order_id}`,
    source: "shortage" as const,
    ts: new Date(s.order_updated_at).getTime(),
    stage: classifyShortage(s.shortage_resolution),
    raw: s,
  }));
  return { rows, total };
}

export default function HqInboxPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-zinc-500">載入中…</div>}>
      <HqInboxContent />
    </Suspense>
  );
}

function HqInboxContent() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [hqLocId, setHqLocId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const searchParams = useSearchParams();
  const [stage, setStage] = useState<Stage | "all">("pending");
  const [sourceFilter, setSourceFilter] = useState<SourceTag | "all">("all");
  const [search, setSearch] = useState("");

  // 跟 ?source= URL param 同步(支援從 /transfers/aid redirect 過來)
  useEffect(() => {
    const src = searchParams.get("source");
    if (src === "restock" || src === "transfer" || src === "aid" || src === "shortage") {
      setSourceFilter(src);
    }
  }, [searchParams]);

  // 共用日期區間(所有來源)
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  // Aid 專屬篩選 (source=aid 時才顯示)
  const [aidModeFilter, setAidModeFilter] = useState<"all" | "air" | "via_warehouse">("all");
  const [aidStatusFilter, setAidStatusFilter] = useState<string>("");
  const [page, setPage] = useState(1);

  // server-side counts: per source × per stage(badge / tab 用)
  const [counts, setCounts] = useState<Record<SourceTag, Record<Stage, number>> | null>(null);
  // server-side total: 當前 (source, stage) 篩選的總數
  const [total, setTotal] = useState(0);
  // 載入狀態
  const [loadingRows, setLoadingRows] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<{ id: number; reason: string } | null>(null);
  const [aidDetailId, setAidDetailId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [groupBy, setGroupBy] = useState<"none" | "store" | "source" | "campaign">("none");

  // 一次:抓 HQ location id
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = getSupabase();
      const { data } = await sb
        .from("locations")
        .select("id")
        .eq("type", "central_warehouse")
        .eq("is_active", true)
        .order("id")
        .limit(1);
      if (cancelled) return;
      const id = ((data as { id: number }[] | null) ?? [])[0]?.id ?? null;
      setHqLocId(id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 抓全部 4 來源 × 4 階段 的 count(badge / stage tab 用)
  // 在 mount 與 reloadTick 變化時刷新
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = getSupabase();
        const stages: Stage[] = ["pending", "in_transit", "done", "rejected"];
        type R = { source: SourceTag; stage: Stage; count: number };

        const queries: Promise<R>[] = [];
        for (const stg of stages) {
          queries.push(
            (async () => {
              const { count } = await sb
                .from("restock_requests")
                .select("id", { count: "exact", head: true })
                .in("status", RESTOCK_STATUS_BY_STAGE[stg]);
              return { source: "restock", stage: stg, count: count ?? 0 };
            })(),
          );
          queries.push(
            (async () => {
              const { count } = await sb
                .from("transfers")
                .select("id", { count: "exact", head: true })
                .in("status", TRANSFER_STATUS_BY_STAGE[stg]);
              return { source: "transfer", stage: stg, count: count ?? 0 };
            })(),
          );
          queries.push(
            (async () => {
              const { count } = await sb
                .from("customer_orders")
                .select("id, items:customer_order_items!inner(id, source)", { count: "exact", head: true })
                .eq("items.source", "aid_transfer")
                .in("status", AID_STATUS_BY_STAGE[stg] as string[]);
              return { source: "aid", stage: stg, count: count ?? 0 };
            })(),
          );
          queries.push(
            (async () => {
              const resolutions = SHORTAGE_RESOLUTION_BY_STAGE[stg];
              if (resolutions !== null && resolutions.length === 0) {
                return { source: "shortage", stage: stg, count: 0 };
              }
              // v_order_shortage 是 (order × sku) 維度,要算 distinct order_id
              // 撈 order_id 後在 JS 裡 set 去重(每筆 row 只有 4 byte int,1 萬筆也才 40KB)
              let q = sb.from("v_order_shortage").select("order_id");
              if (resolutions === null) q = q.is("shortage_resolution", null);
              else q = q.in("shortage_resolution", resolutions);
              q = q.limit(20000);
              const { data } = await q;
              const distinct = new Set((data ?? []).map((r: { order_id: number }) => r.order_id));
              return { source: "shortage", stage: stg, count: distinct.size };
            })(),
          );
        }

        const results = await Promise.all(queries);
        if (cancelled) return;

        const newCounts: Record<SourceTag, Record<Stage, number>> = {
          restock: { pending: 0, in_transit: 0, done: 0, rejected: 0 },
          transfer: { pending: 0, in_transit: 0, done: 0, rejected: 0 },
          aid: { pending: 0, in_transit: 0, done: 0, rejected: 0 },
          shortage: { pending: 0, in_transit: 0, done: 0, rejected: 0 },
        };
        for (const r of results) newCounts[r.source][r.stage] = r.count;
        setCounts(newCounts);
      } catch {
        // counts 失敗就用 null,UI 會 fallback 顯示 0
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // 抓當前 view 的 rows(server-side pagination)
  // 變動觸發:source / stage / page / 日期 / Aid 篩選 / reloadTick
  useEffect(() => {
    let cancelled = false;
    setLoadingRows(true);
    (async () => {
      try {
        const sb = getSupabase();
        const stageArg: Stage | null = stage === "all" ? null : stage;

        let resultRows: Row[] = [];
        let resultTotal = 0;

        if (sourceFilter === "all") {
          // "全部" 視圖:從 4 個來源各抓最近 PAGE_SIZE,merge 後取前 PAGE_SIZE
          const [r, t, a, s] = await Promise.all([
            fetchRestockRows(sb, stageArg, 1, dateFrom, dateTo),
            fetchTransferRows(sb, stageArg, 1, dateFrom, dateTo),
            fetchAidRows(sb, stageArg, 1, dateFrom, dateTo, aidModeFilter, aidStatusFilter),
            fetchShortageRows(sb, stageArg, 1, dateFrom, dateTo),
          ]);
          const merged = [...r.rows, ...t.rows, ...a.rows, ...s.rows].sort((x, y) => y.ts - x.ts);
          resultRows = merged.slice(0, PAGE_SIZE);
          resultTotal = r.total + t.total + a.total + s.total;
        } else {
          let res: { rows: Row[]; total: number };
          if (sourceFilter === "restock") {
            res = await fetchRestockRows(sb, stageArg, page, dateFrom, dateTo);
          } else if (sourceFilter === "transfer") {
            res = await fetchTransferRows(sb, stageArg, page, dateFrom, dateTo);
          } else if (sourceFilter === "aid") {
            res = await fetchAidRows(sb, stageArg, page, dateFrom, dateTo, aidModeFilter, aidStatusFilter);
          } else {
            res = await fetchShortageRows(sb, stageArg, page, dateFrom, dateTo);
          }
          resultRows = res.rows;
          resultTotal = res.total;
        }

        if (cancelled) return;
        setRows(resultRows);
        setTotal(resultTotal);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingRows(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceFilter, stage, page, dateFrom, dateTo, aidModeFilter, aidStatusFilter, reloadTick]);

  // stage tab counts:依當前 sourceFilter,從 cached counts 算出
  const stageCounts = useMemo(() => {
    const c: Record<Stage, number> = { pending: 0, in_transit: 0, done: 0, rejected: 0 };
    if (!counts) return c;
    const sources: SourceTag[] = sourceFilter === "all"
      ? ["restock", "transfer", "aid", "shortage"]
      : [sourceFilter];
    for (const s of sources) {
      for (const stg of ["pending", "in_transit", "done", "rejected"] as Stage[]) {
        c[stg] += counts[s][stg];
      }
    }
    return c;
  }, [counts, sourceFilter]);

  // source chip counts:依當前 stage,從 cached counts 算出
  const sourceCounts = useMemo(() => {
    const c: Record<SourceTag, number> = { restock: 0, transfer: 0, aid: 0, shortage: 0 };
    if (!counts) return c;
    const stages: Stage[] = stage === "all"
      ? ["pending", "in_transit", "done", "rejected"]
      : [stage];
    for (const s of ["restock", "transfer", "aid", "shortage"] as SourceTag[]) {
      for (const stg of stages) c[s] += counts[s][stg];
    }
    return c;
  }, [counts, stage]);

  // server-side 已過濾 source / stage / 日期 / Aid filters,client-side 只做 search(限當前頁)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (!q) return true;
      if (r.source === "restock") {
        const s = r.raw;
        return [s.store_name, s.notes, s.linked_transfer_no, s.linked_pr_no, `RESTOCK#${s.id}`]
          .filter((x): x is string => !!x)
          .some((x) => x.toLowerCase().includes(q));
      }
      if (r.source === "transfer") {
        const t = r.raw;
        return [t.transfer_no, t.source_name, t.dest_name, t.hq_notes].filter((x): x is string => !!x).some((x) => x.toLowerCase().includes(q));
      }
      if (r.source === "shortage") {
        const sh = r.raw;
        return [sh.order_no, sh.store_name, ...sh.short_items.map((it) => it.sku_label)]
          .filter((x): x is string => !!x).some((x) => x.toLowerCase().includes(q));
      }
      const a = r.raw;
      return [a.order_no, a.store_name, a.campaign_no].filter((x): x is string => !!x).some((x) => x.toLowerCase().includes(q));
    });
  }, [rows, search]);

  // server-side 已分頁,paginatedRows 直接 = filtered(當前頁的 rows 經過 search 過濾)
  const paginatedRows = filtered;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 任何 server 端篩選變動 → 回到第 1 頁(避免 page 超出範圍)
  useEffect(() => {
    setPage(1);
  }, [stage, sourceFilter, aidModeFilter, aidStatusFilter, dateFrom, dateTo]);

  // 計算 group key for each row
  function getGroupKey(r: Row): { key: string; label: string } {
    if (groupBy === "source") return { key: r.source, label: SOURCE_LABEL[r.source] };
    if (groupBy === "store") {
      let label = "未指定";
      if (r.source === "restock") label = r.raw.store_name ?? "未指定";
      else if (r.source === "transfer") label = r.raw.dest_name;
      else if (r.source === "aid") label = r.raw.store_name ?? "未指定";
      else if (r.source === "shortage") label = r.raw.store_name ?? "未指定";
      return { key: label, label };
    }
    if (groupBy === "campaign") {
      let key = "—", label = "無開團";
      if (r.source === "aid") {
        label = r.raw.campaign_no ?? "無開團";
        key = label;
      }
      // 其他來源沒 campaign 資訊,放「其他」
      else label = "(其他來源)";
      return { key: label === label ? key : "—", label };
    }
    return { key: "_all", label: "" };
  }

  // 依 groupBy 分組(只在 groupBy !== "none" 時有效)
  const grouped = useMemo(() => {
    if (groupBy === "none") return null;
    const map = new Map<string, { label: string; rows: Row[] }>();
    for (const r of paginatedRows) {
      const { key, label } = getGroupKey(r);
      const slot = map.get(key) ?? { label, rows: [] };
      slot.rows.push(r);
      map.set(key, slot);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([key, v]) => ({ key, ...v }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginatedRows, groupBy]);

  async function approveToTransfer(id: number) {
    if (!confirm("確定派庫存出貨？此動作會建一張 transfer 單。")) return;
    setBusy(`restock-${id}-tx`);
    try {
      const { error: err } = await getSupabase().rpc("rpc_approve_restock_to_transfer", { p_request_id: id });
      if (err) throw err;
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function approveToPr(id: number) {
    if (!confirm("確定下訂單？此動作會獨立建立一張新的採購單。")) return;
    setBusy(`restock-${id}-pr`);
    try {
      const { error: err } = await getSupabase().rpc("rpc_approve_restock_to_pr", { p_request_id: id });
      if (err) throw err;
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function shipPrReceived(id: number) {
    if (!confirm("確定 PR 已到貨、現在從 HQ 派貨到分店？")) return;
    setBusy(`restock-${id}-ship`);
    try {
      const { error: err } = await getSupabase().rpc("rpc_ship_restock_pr_received", { p_request_id: id });
      if (err) throw err;
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!rejectModal || !rejectModal.reason.trim()) return;
    setBusy(`restock-${rejectModal.id}-reject`);
    try {
      const { error: err } = await getSupabase().rpc("rpc_reject_restock", {
        p_request_id: rejectModal.id,
        p_reason: rejectModal.reason.trim(),
      });
      if (err) throw err;
      setRejectModal(null);
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function toggleSelected(key: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 「可批次」的 row keys — 只看 stage='pending' 且 source 跟 sourceFilter 一致
  const batchableKeys = useMemo(() => {
    if (sourceFilter === "all") return [] as string[];
    return paginatedRows.filter((r) => r.source === sourceFilter && r.stage === "pending").map((r) => r.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginatedRows, sourceFilter]);

  function selectAllVisible() {
    setSelected(new Set(batchableKeys));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  // 批次動作 — 依 sourceFilter 跑對應 RPC
  async function batchAction(action: string) {
    const items = paginatedRows.filter((r) => selected.has(r.key) && r.stage === "pending");
    if (items.length === 0) return;
    if (!confirm(`確認對選中的 ${items.length} 筆執行「${action}」?`)) return;
    setBatchBusy(true);
    try {
      const sb = getSupabase();
      const { data: sess } = await sb.auth.getSession();
      const operator = sess.session?.user?.id;
      if (!operator) throw new Error("尚未登入");

      const results = await Promise.allSettled(items.map(async (r) => {
        if (r.source === "restock") {
          const id = r.raw.id;
          if (action === "派貨") return sb.rpc("rpc_approve_restock_to_transfer", { p_request_id: id });
          if (action === "下訂單") return sb.rpc("rpc_approve_restock_to_pr", { p_request_id: id });
        }
        if (r.source === "aid") {
          const id = r.raw.id;
          if (action === "確認") return sb.rpc("rpc_advance_order_status", { p_order_id: id, p_new_status: "confirmed", p_operator: operator });
          if (action === "派貨") return sb.rpc("rpc_ship_aid_order", { p_order_id: id, p_operator: operator });
        }
        if (r.source === "shortage") {
          const id = r.raw.order_id;
          const map: Record<string, string> = { "通知客戶": "notified", "等下批": "waiting_next_po" };
          const a = map[action];
          if (a) return sb.rpc("rpc_handle_shortage_order", { p_order_id: id, p_action: a, p_operator: operator });
        }
        throw new Error(`無對應動作: ${r.source}/${action}`);
      }));

      const okCount = results.filter((r) => r.status === "fulfilled" && !(r.value as { error?: unknown })?.error).length;
      const failed = results.length - okCount;
      if (failed === 0) {
        alert(`✅ 完成 ${okCount} 筆`);
      } else {
        const errs: string[] = [];
        results.forEach((r) => {
          if (r.status === "rejected") errs.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
          else if ((r.value as { error?: { message?: string } })?.error) errs.push((r.value as { error: { message: string } }).error.message);
        });
        alert(`成功 ${okCount} / 失敗 ${failed}\n\n${errs.slice(0, 3).join("\n")}`);
      }
      setSelected(new Set());
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchBusy(false);
    }
  }

  async function handleTransferAction(transferId: number, action: "ship" | "arrive_at_hq" | "delete") {
    const labels: Record<typeof action, string> = {
      ship: "從 HQ 出貨(扣庫存、推到「已出貨」)",
      arrive_at_hq: "確認到倉(全收、入 HQ 庫存)",
      delete: "刪除草稿",
    };
    if (!confirm(`確定:${labels[action]}?`)) return;
    setBusy(`transfer-${transferId}-${action}`);
    try {
      const sb = getSupabase();
      const { data: sess } = await sb.auth.getSession();
      const operator = sess.session?.user?.id;
      if (!operator) throw new Error("尚未登入");
      if ((action === "ship" || action === "arrive_at_hq") && hqLocId === null) {
        throw new Error("找不到 HQ location");
      }
      let rpcName: string;
      let params: Record<string, unknown>;
      if (action === "ship") {
        rpcName = "rpc_transfer_distribute_batch";
        params = { p_transfer_ids: [transferId], p_hq_location_id: hqLocId, p_operator: operator };
      } else if (action === "arrive_at_hq") {
        rpcName = "rpc_transfer_arrive_at_hq_batch";
        params = { p_transfer_ids: [transferId], p_hq_location_id: hqLocId, p_operator: operator };
      } else {
        rpcName = "rpc_transfer_batch_delete";
        params = { p_transfer_ids: [transferId], p_operator: operator };
      }
      const { data, error: err } = await sb.rpc(rpcName, params);
      if (err) throw err;
      const res = data as { failed?: { id: number; reason: string }[] } | null;
      if (res?.failed && res.failed.length > 0) {
        throw new Error(res.failed.map((f) => `#${f.id}: ${f.reason}`).join("\n"));
      }
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleShortageAction(orderId: number, action: "notified" | "cancelled" | "waiting_next_po" | "reallocated") {
    const labelMap: Record<typeof action, string> = {
      notified: "通知客戶(PWA 推播 + 標記已通知)",
      cancelled: "取消(請去訂單頁正式取消退款)",
      waiting_next_po: "等下批 PO 補貨",
      reallocated: "改派(從其他店調貨)",
    };
    if (!confirm(`確定:${labelMap[action]}?`)) return;
    setBusy(`shortage-${orderId}-${action}`);
    try {
      const sb = getSupabase();
      const { data: sess } = await sb.auth.getSession();
      const operator = sess.session?.user?.id;
      if (!operator) throw new Error("尚未登入");
      const { error: err } = await sb.rpc("rpc_handle_shortage_order", {
        p_order_id: orderId,
        p_action: action,
        p_operator: operator,
      });
      if (err) throw err;
      // TODO: action='notified' 觸發 PWA push edge function
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">總倉收件匣</h1>
        {(rows === null || hqLocId === null) && (
          <p className="text-sm text-zinc-500">
            {rows === null ? "載入中…" : ""}
            {hqLocId === null ? " ⚠️ 未找到 HQ location" : ""}
          </p>
        )}
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* === 來源資料夾 chip bar === */}
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "restock", "transfer", "aid", "shortage"] as const).map((s) => {
          const active = sourceFilter === s;
          const label = s === "all" ? "📥 全部" : ({
            restock: "📦 補貨申請",
            transfer: "🚚 轉貨單",
            aid: "🤝 互助訂單",
            shortage: "⚠️ 短少訂單",
          } as const)[s];
          // chip 顯示「該來源」的待處理數(從 cached counts 算,固定值,跟 stage 切換無關)
          const count = !counts
            ? 0
            : s === "all"
              ? counts.restock.pending + counts.transfer.pending + counts.aid.pending + counts.shortage.pending
              : counts[s].pending;
          return (
            <SpinButton
              key={s}
              onClick={() => setSourceFilter(s)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              <span>{label}</span>
              {count > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                  active ? "bg-white/20 text-white dark:bg-zinc-900/20 dark:text-zinc-900" : "bg-blue-600 text-white"
                }`}>
                  {count}
                </span>
              )}
            </SpinButton>
          );
        })}
      </div>

      {/* Aid 專屬篩選 — 選 Aid 才出現 */}
      {sourceFilter === "aid" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-fuchsia-200 bg-fuchsia-50 px-3 py-2 text-xs dark:border-fuchsia-900 dark:bg-fuchsia-950/30">
          <span className="font-semibold text-fuchsia-700 dark:text-fuchsia-300">互助專屬:</span>
          <select
            value={aidModeFilter}
            onChange={(e) => setAidModeFilter(e.target.value as typeof aidModeFilter)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="all">全部模式</option>
            <option value="air">空中轉</option>
            <option value="via_warehouse">經總倉中轉</option>
          </select>
          <select
            value={aidStatusFilter}
            onChange={(e) => setAidStatusFilter(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">全部狀態</option>
            {Object.entries(AID_STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          {(aidModeFilter !== "all" || aidStatusFilter) && (
            <SpinButton
              onClick={() => {
                setAidModeFilter("all");
                setAidStatusFilter("");
              }}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              清除
            </SpinButton>
          )}
        </div>
      )}

      {/* === 主區 === */}
      <div className="flex flex-1 flex-col gap-3 min-w-0">

          {/* Toolbar: 搜尋 + 起迄日 + 閱讀模式 */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 搜尋 單號 / 店 / 備註"
              className="flex-1 min-w-[180px] rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              title="起日"
            />
            <span className="text-xs text-zinc-400">~</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              title="迄日"
            />
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              <span>閱讀模式</span>
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="none">不分組</option>
                <option value="store">分店</option>
                <option value="campaign">開團</option>
              </select>
            </label>
          </div>

          {/* Stage tabs (套用在當前資料夾) */}
          <div className="flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800">
            {(["pending", "in_transit", "done", "rejected", "all"] as const).map((s) => {
              const label = s === "all" ? "全部" : STAGE_LABEL[s];
              const count = s === "all"
                ? Object.values(stageCounts).reduce((a, b) => a + b, 0)
                : stageCounts[s];
              const active = stage === s;
              return (
                <SpinButton
                  key={s}
                  onClick={() => setStage(s)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                    active
                      ? "border-blue-600 font-semibold text-blue-700 dark:text-blue-300"
                      : "border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  }`}
                >
                  {label} <span className="ml-1 text-xs text-zinc-400">{count}</span>
                </SpinButton>
              );
            })}
          </div>

          {/* 批次工具列 */}
          {sourceFilter !== "all" && batchableKeys.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === batchableKeys.length}
                onChange={() => selected.size === batchableKeys.length ? clearSelection() : selectAllVisible()}
                className="cursor-pointer"
                title="全選 / 清空"
              />
              <span className="text-xs text-zinc-500">
                {selected.size > 0 ? `已選 ${selected.size} / ${batchableKeys.length} 筆待處理` : `${batchableKeys.length} 筆待處理可批次`}
              </span>
              <SpinButton
                type="button"
                onClick={selectAllVisible}
                disabled={selected.size === batchableKeys.length}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                全選
              </SpinButton>
              {selected.size > 0 && (
                <SpinButton
                  type="button"
                  onClick={clearSelection}
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  清空
                </SpinButton>
              )}
              {selected.size > 0 && (
                <div className="ml-auto flex flex-wrap gap-1">
                  {sourceFilter === "restock" && (
                    <>
                      <RowAction variant="success" onClick={() => batchAction("派貨")} disabled={batchBusy}>派貨 ({selected.size})</RowAction>
                      <RowAction variant="indigo" onClick={() => batchAction("下訂單")} disabled={batchBusy}>下訂單 ({selected.size})</RowAction>
                    </>
                  )}
                  {sourceFilter === "aid" && (
                    <>
                      <RowAction variant="primary" onClick={() => batchAction("確認")} disabled={batchBusy}>確認 ({selected.size})</RowAction>
                      <RowAction variant="success" onClick={() => batchAction("派貨")} disabled={batchBusy}>派貨 ({selected.size})</RowAction>
                    </>
                  )}
                  {sourceFilter === "shortage" && (
                    <>
                      <RowAction variant="primary" onClick={() => batchAction("通知客戶")} disabled={batchBusy}>通知客戶 ({selected.size})</RowAction>
                      <RowAction variant="warning" onClick={() => batchAction("等下批")} disabled={batchBusy}>等下批 ({selected.size})</RowAction>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* === Row list (郵件列) === */}
          <div className="overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {rows === null ? (
              <div className="p-6 text-center text-sm text-zinc-500">載入中…</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">目前沒有資料</div>
            ) : (
              (() => {
                const showCheckbox = sourceFilter !== "all" && batchableKeys.length > 0;
                const renderRow = (r: Row) => {
                  const batchable = batchableKeys.includes(r.key);
                  return (
                    <MailRow key={r.key} row={r} busy={busy}
                      onApproveTransfer={approveToTransfer} onApprovePr={approveToPr} onShipPrReceived={shipPrReceived}
                      onOpenReject={(id) => setRejectModal({ id, reason: "" })}
                      onOpenAidDetail={setAidDetailId} onAidChanged={() => setReloadTick((t) => t + 1)}
                      onShortageAction={handleShortageAction} onTransferAction={handleTransferAction} hqLocId={hqLocId}
                      showCheckbox={showCheckbox} batchable={batchable}
                      selected={selected.has(r.key)} onToggleSelect={() => toggleSelected(r.key)}
                    />
                  );
                };
                if (grouped) {
                  return grouped.flatMap((g) => [
                    <div key={`g-${g.key}`} className="border-b border-zinc-200 bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                      📂 {g.label} <span className="ml-2 font-normal text-zinc-500">({g.rows.length})</span>
                    </div>,
                    ...g.rows.map(renderRow),
                  ]);
                }
                return paginatedRows.map(renderRow);
              })()
            )}
          </div>

          {/* 分頁 — server-side,僅特定來源 */}
          {sourceFilter !== "all" && total > PAGE_SIZE && (
            <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
              <span className="text-xs text-zinc-500">
                共 {total} 筆 ·
                顯示 {(page - 1) * PAGE_SIZE + 1} - {Math.min(page * PAGE_SIZE, total)}
              </span>
              <SpinButton onClick={() => setPage(1)} disabled={page === 1}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                « 第一頁
              </SpinButton>
              <SpinButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                ‹ 上頁
              </SpinButton>
              <span className="text-xs text-zinc-500">{page} / {totalPages}</span>
              <SpinButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                下頁 ›
              </SpinButton>
              <SpinButton onClick={() => setPage(totalPages)} disabled={page === totalPages}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                最末頁 »
              </SpinButton>
            </div>
          )}
      </div>

      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-md bg-white p-4 shadow-lg dark:bg-zinc-900">
            <h2 className="mb-3 text-base font-semibold">拒絕補貨申請 #{rejectModal.id}</h2>
            <label className="block space-y-1 text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">拒絕原因 *</span>
              <textarea
                value={rejectModal.reason}
                onChange={(e) => setRejectModal({ ...rejectModal, reason: e.target.value })}
                placeholder="例如：庫存不足且採購週期太長 / 商品已停售…"
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                rows={3}
              />
            </label>
            <div className="mt-3 flex gap-2">
              <SpinButton
                onClick={reject}
                disabled={!rejectModal.reason.trim() || busy === `restock-${rejectModal.id}-reject`}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                確認拒絕
              </SpinButton>
              <SpinButton
                onClick={() => setRejectModal(null)}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
              >
                取消
              </SpinButton>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={aidDetailId !== null}
        onClose={() => setAidDetailId(null)}
        title="互助訂單明細"
        maxWidth="max-w-4xl"
      >
        {aidDetailId !== null && <OrderDetail orderId={aidDetailId} />}
      </Modal>
    </div>
  );
}

function MailRow({
  row,
  busy,
  onApproveTransfer,
  onApprovePr,
  onShipPrReceived,
  onOpenReject,
  onOpenAidDetail,
  onAidChanged,
  onShortageAction,
  onTransferAction,
  hqLocId,
  showCheckbox,
  batchable,
  selected,
  onToggleSelect,
}: {
  row: Row;
  busy: string | null;
  onApproveTransfer: (id: number) => Promise<void>;
  onApprovePr: (id: number) => Promise<void>;
  onShipPrReceived: (id: number) => Promise<void>;
  onOpenReject: (id: number) => void;
  onOpenAidDetail: (id: number) => void;
  onAidChanged: () => void;
  onShortageAction: (orderId: number, action: "notified" | "cancelled" | "waiting_next_po" | "reallocated") => Promise<void>;
  onTransferAction: (transferId: number, action: "ship" | "arrive_at_hq" | "delete") => Promise<void>;
  hqLocId: number | null;
  showCheckbox: boolean;
  batchable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const isPending = row.stage === "pending";
  const sourceCls = SOURCE_COLOR[row.source];
  const stageCls = STAGE_COLOR[row.stage];
  const sourceText = SOURCE_LABEL[row.source];
  const stageText = STAGE_LABEL[row.stage];
  const accent = ({
    restock: "border-l-indigo-500",
    transfer: "border-l-blue-500",
    aid: "border-l-fuchsia-500",
    shortage: "border-l-rose-500",
  } as const)[row.source];

  let idText: string;
  let title: React.ReactNode;
  let subtitle: React.ReactNode;
  let timeIso: string;
  let actions: React.ReactNode;

  if (row.source === "restock") {
    const s = row.raw;
    idText = `RESTOCK#${s.id}`;
    title = <>{s.store_name ?? "—"} <span className="text-zinc-400 mx-1">→</span> HQ</>;
    subtitle = (
      <>
        急補 {s.line_count} 項 · NT${s.total_amount.toFixed(0)}
        {s.linked_pr_id && (
          <Link href={`/purchase/requests/edit?id=${s.linked_pr_id}`} className="ml-2 font-mono text-blue-600 hover:underline dark:text-blue-400">
            · {s.linked_pr_no ?? `採購單 #${s.linked_pr_id}`}
          </Link>
        )}
        {s.linked_transfer_id && (
          <Link href={`/wms/outbound?id=${s.linked_transfer_id}`} className="ml-2 font-mono text-blue-600 hover:underline dark:text-blue-400">
            · {s.linked_transfer_no ?? `轉貨單 #${s.linked_transfer_id}`}
          </Link>
        )}
        {s.status === "rejected" && s.rejected_reason && (
          <span className="ml-2 text-red-600" title={s.rejected_reason}>· 拒絕:{s.rejected_reason}</span>
        )}
      </>
    );
    timeIso = s.requested_at;
    if (s.status === "pending") {
      actions = (
        <>
          <RowAction variant="success" onClick={() => onApproveTransfer(s.id)} disabled={busy?.startsWith(`restock-${s.id}`) ?? false}>派貨</RowAction>
          <RowAction variant="indigo" onClick={() => onApprovePr(s.id)} disabled={busy?.startsWith(`restock-${s.id}`) ?? false}>下訂單</RowAction>
          <RowAction variant="danger" onClick={() => onOpenReject(s.id)} disabled={busy?.startsWith(`restock-${s.id}`) ?? false}>拒絕</RowAction>
        </>
      );
    } else if (s.status === "approved_pr") {
      actions = (
        <RowAction variant="success" onClick={() => onShipPrReceived(s.id)} disabled={busy?.startsWith(`restock-${s.id}`) ?? false}>PO 到貨建轉貨單</RowAction>
      );
    } else {
      actions = null;
    }
  } else if (row.source === "transfer") {
    const t = row.raw;
    idText = t.transfer_no;
    title = <>{t.source_name} <span className="text-zinc-400 mx-1">→</span> {t.dest_name}</>;
    subtitle = (
      <>
        {t.line_count} 項
        {t.is_air_transfer && <span className="ml-1">· ✈ 空運</span>}
        {t.shipping_temp && <span className="ml-1">· {t.shipping_temp}</span>}
        <span className="ml-1 text-[10px] text-zinc-400">· {t.status}</span>
      </>
    );
    timeIso = t.created_at;
    actions = <TransferActions transfer={t} hqLocId={hqLocId} busy={busy} onAction={onTransferAction} />;
  } else if (row.source === "shortage") {
    const sh = row.raw;
    const isBusy = busy?.startsWith(`shortage-${sh.order_id}`) ?? false;
    const itemsTooltip = sh.short_items
      .map((it) => `${it.sku_label}:訂 ${it.order_qty}, 缺 ${it.demand_unfulfillable}`)
      .join("\n");
    idText = sh.order_no;
    title = <>會員 #{sh.member_id ?? "—"} <span className="text-zinc-400 mx-1">·</span> {sh.store_name ?? "—"}</>;
    subtitle = (
      <span title={itemsTooltip}>
        <span className="font-semibold text-rose-700 dark:text-rose-400">
          缺 {sh.total_unfulfillable}({sh.short_items.length} 項)
        </span>
        {sh.shortage_resolution && (
          <span className="ml-2 text-zinc-500">
            · {RESOLUTION_LABEL[sh.shortage_resolution] ?? sh.shortage_resolution}
          </span>
        )}
        {sh.shortage_notified_at && (
          <span className="ml-2 text-zinc-400">已通知 {new Date(sh.shortage_notified_at).toLocaleDateString("zh-TW")}</span>
        )}
      </span>
    );
    timeIso = sh.order_updated_at;
    actions = (
      <>
        <RowAction variant="primary" onClick={() => onShortageAction(sh.order_id, "notified")} disabled={isBusy}>通知客戶</RowAction>
        <RowAction variant="warning" onClick={() => onShortageAction(sh.order_id, "waiting_next_po")} disabled={isBusy}>等下批</RowAction>
        <RowAction variant="success" onClick={() => onShortageAction(sh.order_id, "reallocated")} disabled={isBusy}>改派</RowAction>
        <RowAction variant="danger" onClick={() => onShortageAction(sh.order_id, "cancelled")} disabled={isBusy}>取消退款</RowAction>
      </>
    );
  } else {
    const a = row.raw;
    idText = a.order_no;
    title = <>{a.campaign_no ?? "—"} <span className="text-zinc-400 mx-1">→</span> {a.store_name ?? "—"}</>;
    subtitle = (
      <>
        {a.line_count} 項
        {a.is_air_transfer && <span className="ml-1">· ✈ 空運</span>}
        <span className="ml-1">· {AID_STATUS_LABEL[a.status]}</span>
      </>
    );
    timeIso = a.updated_at;
    actions = (
      <>
        <AidOrderStatusActions order={{ id: a.id, status: a.status }} onChanged={onAidChanged} />
        <RowAction variant="neutral" onClick={() => onOpenAidDetail(a.id)}>查看訂單</RowAction>
      </>
    );
  }

  const time = new Date(timeIso).toLocaleString("zh-TW", { dateStyle: "short", timeStyle: "short" });

  return (
    <div className={`flex items-start gap-3 border-b border-l-4 px-4 py-3 transition hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-950 ${accent} ${row.source === "shortage" ? "bg-rose-50/30 dark:bg-rose-950/20" : ""} ${selected ? "bg-blue-50 dark:bg-blue-950/30" : ""}`}>
      {/* checkbox */}
      <div className="w-5 shrink-0 pt-1">
        {showCheckbox && batchable ? (
          <input type="checkbox" checked={selected} onChange={onToggleSelect} className="cursor-pointer" />
        ) : null}
      </div>

      {/* source chip + 未讀 dot (sm+) */}
      <div className="hidden sm:block w-24 shrink-0 pt-0.5">
        <span className={`inline-flex w-fit items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium ${sourceCls}`}>
          {isPending && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden />}
          {sourceText}
        </span>
      </div>

      {/* 主旨 + 摘要 */}
      <div className="min-w-0 flex-1">
        <div className={`flex flex-wrap items-baseline gap-x-2 ${isPending ? "font-semibold" : "text-zinc-700 dark:text-zinc-300"}`}>
          <span className="truncate text-sm">{title}</span>
          <span className="font-mono text-[10px] text-zinc-500">{idText}</span>
          <span className={`sm:hidden inline-flex rounded px-1.5 py-0.5 text-[9px] font-medium ${sourceCls}`}>
            {sourceText}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-zinc-500">{subtitle}</div>
      </div>

      {/* 階段 chip 直接放在動作區左邊(時間移到動作下方右下) */}
      <div className="hidden md:flex shrink-0 items-start pt-0.5">
        <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] ${stageCls}`}>{stageText}</span>
      </div>

      {/* 動作 + 時間(右下)— 固定寬度 */}
      <div className="flex w-[280px] shrink-0 flex-col items-end gap-1">
        <div className="flex flex-wrap items-center justify-end gap-1">
          {actions}
        </div>
        <span className="text-[11px] text-zinc-400">{time}</span>
      </div>
    </div>
  );
}

function TransferActions({
  transfer,
  hqLocId,
  busy,
  onAction,
}: {
  transfer: TransferRaw;
  hqLocId: number | null;
  busy: string | null;
  onAction: (transferId: number, action: "ship" | "arrive_at_hq" | "delete") => Promise<void>;
}) {
  const isBusy = busy?.startsWith(`transfer-${transfer.id}`) ?? false;
  const isHqDest = hqLocId !== null && transfer.dest_location === hqLocId;
  const buttons: React.ReactNode[] = [];

  // draft: 可刪除
  if (transfer.status === "draft") {
    buttons.push(
      <RowAction
        key="delete"
        variant="danger"
        onClick={() => onAction(transfer.id, "delete")}
        disabled={isBusy}
      >
        刪除
      </RowAction>,
    );
  }

  // draft / confirmed → 出貨(RPC 不限 source,任何 source 都可以)
  if (transfer.status === "draft" || transfer.status === "confirmed") {
    buttons.push(
      <RowAction
        key="ship"
        variant="success"
        onClick={() => onAction(transfer.id, "ship")}
        disabled={isBusy}
      >
        出貨
      </RowAction>,
    );
  }

  // shipped + dest=HQ → 到倉
  if (transfer.status === "shipped" && isHqDest) {
    buttons.push(
      <RowAction
        key="arrive"
        variant="primary"
        onClick={() => onAction(transfer.id, "arrive_at_hq")}
        disabled={isBusy}
      >
        到倉
      </RowAction>,
    );
  }

  return <>{buttons}</>;
}
