"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { Modal } from "@/components/Modal";

type BillStatus = "pending" | "partially_paid" | "paid" | "cancelled" | "disputed";
type SourceType =
  | "purchase_order" | "goods_receipt" | "transfer_settlement"
  | "store_monthly_settlement" | "xiaolan_import" | "manual";

type Bill = {
  id: number;
  bill_no: string;
  supplier_id: number;
  source_type: SourceType;
  source_id: number | null;
  bill_date: string;
  due_date: string;
  amount: number;
  paid_amount: number;
  status: BillStatus;
  currency: string;
  tax_amount: number;
  supplier_invoice_no: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type Supplier = { id: number; code: string; name: string };

const STATUS_LABEL: Record<BillStatus, string> = {
  pending: "未付",
  partially_paid: "部分已付",
  paid: "已付清",
  cancelled: "已取消",
  disputed: "爭議中",
};
const STATUS_COLOR: Record<BillStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  partially_paid: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  paid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  cancelled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  disputed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};
const SOURCE_LABEL: Record<SourceType, string> = {
  purchase_order: "採購單",
  goods_receipt: "進貨單",
  transfer_settlement: "店間結算",
  store_monthly_settlement: "店月結算",
  xiaolan_import: "小蘭匯入",
  manual: "手動建立",
};

const PAGE_SIZE = 50;

export default function PayablesPage() {
  const [rows, setRows] = useState<Bill[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [statusFilter, setStatusFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [supplierFilter, setSupplierFilter] = useState<string>("");
  const [page, setPage] = useState(1);

  const [suppliers, setSuppliers] = useState<Map<number, Supplier>>(new Map());
  const [detail, setDetail] = useState<Bill | null>(null);

  useEffect(() => { setPage(1); }, [statusFilter, sourceFilter, supplierFilter]);

  // 載入 supplier 名稱對應
  useEffect(() => {
    (async () => {
      const sb = getSupabase();
      const { data } = await sb.from("suppliers").select("id, code, name").order("name").limit(500);
      const m = new Map<number, Supplier>();
      for (const s of (data ?? []) as Supplier[]) m.set(s.id, s);
      setSuppliers(m);
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const sb = getSupabase();
        let q = sb
          .from("vendor_bills")
          .select(
            "id, bill_no, supplier_id, source_type, source_id, bill_date, due_date, amount, paid_amount, status, currency, tax_amount, supplier_invoice_no, notes, created_at, updated_at",
            { count: "exact" },
          )
          .order("bill_date", { ascending: false })
          .order("id", { ascending: false })
          .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

        if (statusFilter) q = q.eq("status", statusFilter);
        if (sourceFilter) q = q.eq("source_type", sourceFilter);
        if (supplierFilter) q = q.eq("supplier_id", Number(supplierFilter));

        const { data, count, error: e1 } = await q;
        if (cancelled) return;
        if (e1) { setError(e1.message); return; }
        setError(null);
        setRows((data ?? []) as Bill[]);
        setTotal(count ?? 0);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [statusFilter, sourceFilter, supplierFilter, page, reloadTick]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromIdx = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toIdx = Math.min(page * PAGE_SIZE, total);

  // 統計
  const stats = useMemo(() => {
    if (!rows) return { totalAmount: 0, totalPaid: 0, totalUnpaid: 0, pendingCount: 0 };
    let totalAmount = 0, totalPaid = 0, pendingCount = 0;
    for (const b of rows) {
      if (b.status === "cancelled") continue;
      totalAmount += Number(b.amount);
      totalPaid += Number(b.paid_amount);
      if (b.status === "pending" || b.status === "partially_paid") pendingCount++;
    }
    return { totalAmount, totalPaid, totalUnpaid: totalAmount - totalPaid, pendingCount };
  }, [rows]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">應付帳款</h1>
        <p className="text-sm text-zinc-500">
          {loading ? "載入中…" : total === 0 ? "共 0 筆" : `共 ${total} 筆（${fromIdx}-${toIdx}）`}
        </p>
      </header>

      {/* 統計卡 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="本頁總額" value={`$${stats.totalAmount.toLocaleString()}`} />
        <Stat label="本頁已付" value={`$${stats.totalPaid.toLocaleString()}`} accent="positive" />
        <Stat label="本頁未付" value={`$${stats.totalUnpaid.toLocaleString()}`} accent={stats.totalUnpaid > 0 ? "negative" : "neutral"} />
        <Stat label="未結清張數" value={String(stats.pendingCount)} />
      </div>

      {/* 篩選 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
          <option value="">全部狀態</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
          <option value="">全部來源</option>
          {Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
          <option value="">全部供應商</option>
          {Array.from(suppliers.values()).map((s) => (
            <option key={s.id} value={s.id}>{s.code} {s.name}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <p className="font-mono text-xs">{error}</p>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <Th>帳單號</Th>
              <Th>供應商</Th>
              <Th>來源</Th>
              <Th>帳單日</Th>
              <Th>到期日</Th>
              <Th className="text-right">金額</Th>
              <Th className="text-right">已付</Th>
              <Th className="text-right">未付</Th>
              <Th>狀態</Th>
              <Th className="text-right">操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows === null ? (
              <tr><td colSpan={10} className="p-3 text-center text-zinc-500">載入中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={10} className="p-6 text-center text-zinc-500">尚無應付帳款。</td></tr>
            ) : rows.map((b) => {
              const sup = suppliers.get(b.supplier_id);
              const unpaid = Number(b.amount) - Number(b.paid_amount);
              const overdue = b.status !== "paid" && b.status !== "cancelled" && b.due_date < today;
              return (
                <tr key={b.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <Td className="font-mono text-xs">{b.bill_no}</Td>
                  <Td className="text-xs">
                    <span className="font-mono text-zinc-500">{sup?.code ?? "—"}</span>{" "}
                    <span>{sup?.name ?? `#${b.supplier_id}`}</span>
                  </Td>
                  <Td className="text-xs">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{SOURCE_LABEL[b.source_type]}</span>
                  </Td>
                  <Td className="text-xs">{b.bill_date}</Td>
                  <Td className={`text-xs ${overdue ? "text-rose-600 font-medium" : ""}`}>
                    {b.due_date}{overdue && " ⚠️"}
                  </Td>
                  <Td className="text-right font-mono">${Number(b.amount).toLocaleString()}</Td>
                  <Td className="text-right font-mono text-emerald-600">${Number(b.paid_amount).toLocaleString()}</Td>
                  <Td className={`text-right font-mono ${unpaid > 0 ? "text-rose-600" : "text-zinc-400"}`}>${unpaid.toLocaleString()}</Td>
                  <Td><span className={`inline-block rounded px-2 py-0.5 text-xs ${STATUS_COLOR[b.status]}`}>{STATUS_LABEL[b.status]}</span></Td>
                  <Td className="text-right">
                    <button
                      onClick={() => setDetail(b)}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      詳情
                    </button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-md border border-zinc-300 px-3 py-1 disabled:opacity-50 dark:border-zinc-700">
            上一頁
          </button>
          <span className="text-zinc-500">{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="rounded-md border border-zinc-300 px-3 py-1 disabled:opacity-50 dark:border-zinc-700">
            下一頁
          </button>
        </div>
      )}

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail ? `應付帳款 ${detail.bill_no}` : ""}
        maxWidth="max-w-4xl"
      >
        {detail && (
          <BillDetail
            bill={detail}
            supplier={suppliers.get(detail.supplier_id) ?? null}
            onChanged={() => {
              setDetail(null);
              setReloadTick((t) => t + 1);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

// ============================================================
// Bill 詳情 Modal — 顯示來源 + 付款歷史 + 標已付
// ============================================================

type Payment = {
  id: number;
  payment_no: string;
  amount: number;
  method: string;
  paid_at: string;
  status: string;
  notes: string | null;
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "現金",
  bank_transfer: "銀行轉帳",
  check: "支票",
  offset: "對沖",
  petty_cash: "零用金",
  other: "其他",
};

function BillDetail({
  bill,
  supplier,
  onChanged,
}: {
  bill: Bill;
  supplier: Supplier | null;
  onChanged: () => void;
}) {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [showPayForm, setShowPayForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const unpaid = Number(bill.amount) - Number(bill.paid_amount);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = getSupabase();
      // 透過 vendor_payment_allocations 反查付款
      const { data, error } = await sb
        .from("vendor_payment_allocations")
        .select("payment_id, allocated_amount, payment:vendor_payments(id, payment_no, amount, method, paid_at, status, notes)")
        .eq("bill_id", bill.id);
      if (cancelled) return;
      if (error) { setErr(error.message); return; }
      // Supabase 把 relation join 推斷為 array、所以要 flatten
      const list: Payment[] = [];
      for (const a of ((data ?? []) as unknown as { payment: Payment | Payment[] | null }[])) {
        if (Array.isArray(a.payment)) {
          for (const p of a.payment) list.push(p);
        } else if (a.payment) {
          list.push(a.payment);
        }
      }
      setPayments(list);
    })();
    return () => { cancelled = true; };
  }, [bill.id]);

  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="供應商" value={supplier ? `${supplier.code} ${supplier.name}` : `#${bill.supplier_id}`} />
        <Stat label="來源" value={SOURCE_LABEL[bill.source_type]} />
        <Stat label="狀態" value={STATUS_LABEL[bill.status]} />
        <Stat label="總金額" value={`$${Number(bill.amount).toLocaleString()}`} />
        <Stat label="已付" value={`$${Number(bill.paid_amount).toLocaleString()}`} accent="positive" />
        <Stat label="未付" value={`$${unpaid.toLocaleString()}`} accent={unpaid > 0 ? "negative" : "neutral"} />
        <Stat label="帳單日" value={bill.bill_date} />
        <Stat label="到期日" value={bill.due_date} />
        <Stat label="供應商發票號" value={bill.supplier_invoice_no ?? "—"} />
      </div>

      {bill.notes && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <span className="text-zinc-500">備註：</span>{bill.notes}
        </div>
      )}

      {/* 付款歷史 */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">付款記錄（{payments?.length ?? 0} 筆）</span>
          {unpaid > 0 && bill.status !== "cancelled" && (
            <button
              onClick={() => setShowPayForm(!showPayForm)}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              {showPayForm ? "取消" : "💰 標記付款"}
            </button>
          )}
        </div>
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                <Th>付款單號</Th>
                <Th>付款日</Th>
                <Th>方式</Th>
                <Th className="text-right">金額</Th>
                <Th>備註</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {payments === null ? (
                <tr><td colSpan={5} className="p-3 text-center text-zinc-500">載入中…</td></tr>
              ) : payments.length === 0 ? (
                <tr><td colSpan={5} className="p-3 text-center text-zinc-500">尚未付款。</td></tr>
              ) : payments.map((p) => (
                <tr key={p.id}>
                  <Td className="font-mono text-xs">{p.payment_no}</Td>
                  <Td className="text-xs">{p.paid_at?.slice(0, 10)}</Td>
                  <Td className="text-xs">{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</Td>
                  <Td className="text-right font-mono">${Number(p.amount).toLocaleString()}</Td>
                  <Td className="text-xs text-zinc-500">{p.notes ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showPayForm && (
        <PaymentForm
          bill={bill}
          unpaid={unpaid}
          supplier={supplier}
          onDone={() => { setShowPayForm(false); onChanged(); }}
        />
      )}

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <p className="font-mono text-xs">{err}</p>
        </div>
      )}
    </div>
  );
}

// ============================================================
// PaymentForm — 標記付款
// ============================================================

function PaymentForm({
  bill,
  unpaid,
  supplier,
  onDone,
}: {
  bill: Bill;
  unpaid: number;
  supplier: Supplier | null;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(unpaid);
  const [method, setMethod] = useState("bank_transfer");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (amount <= 0 || amount > unpaid) {
      setErr(`金額必須在 0 ~ ${unpaid} 之間`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const sb = getSupabase();
      const { data: sess } = await sb.auth.getSession();
      const tenantId = (sess.session?.user?.app_metadata as Record<string, unknown> | undefined)
        ?.tenant_id as string | undefined;
      const operator = sess.session?.user?.id;
      if (!tenantId || !operator) throw new Error("尚未登入");

      const paymentNo = `PAY-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}${String(new Date().getDate()).padStart(2, "0")}-${Date.now().toString().slice(-6)}`;

      const { error } = await sb.rpc("rpc_make_payment", {
        p_tenant_id: tenantId,
        p_supplier_id: bill.supplier_id,
        p_payment_no: paymentNo,
        p_amount: amount,
        p_method: method,
        p_paid_at: paidAt,
        p_allocations: [{ bill_id: bill.id, allocated_amount: amount }],
        p_operator: operator,
        p_notes: notes || null,
      });
      if (error) throw new Error(error.message);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
      <h3 className="mb-3 text-sm font-medium">付款給 {supplier?.name ?? `供應商 #${bill.supplier_id}`}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">付款金額（最多 ${unpaid.toLocaleString()}）</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            min={0}
            max={unpaid}
            step={0.01}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">付款方式</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          >
            {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">付款日</span>
          <input
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">備註</span>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </label>
      </div>
      {err && (
        <p className="mt-2 text-xs text-rose-600">{err}</p>
      )}
      <div className="mt-3 flex justify-end">
        <button
          onClick={submit}
          disabled={busy || amount <= 0 || amount > unpaid}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? "處理中…" : `💰 確認付款 $${Number(amount).toLocaleString()}`}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function Stat({ label, value, accent }: { label: string; value: string; accent?: "positive" | "negative" | "neutral" }) {
  const cls =
    accent === "positive" ? "text-emerald-600" :
    accent === "negative" ? "text-rose-600" :
    "text-zinc-700 dark:text-zinc-200";
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-base font-medium ${cls}`}>{value}</div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}
