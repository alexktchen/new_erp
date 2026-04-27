"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  type Ref,
} from "react";
import { getSupabase } from "@/lib/supabase";

type Sku = {
  id: number;
  sku_code: string;
  variant_name: string | null;
  base_unit: string;
};

type PriceRow = { sku_id: number; price: number; effective_from: string };

type Draft = {
  id: number | null;
  sku_code: string;
  variant_name: string;
  base_unit: string;
  retail_price: string;
};

type PendingSku = Draft & { tempId: number };

const EMPTY_DRAFT: Draft = {
  id: null,
  sku_code: "",
  variant_name: "",
  base_unit: "個",
  retail_price: "",
};

export type ProductSkuSectionHandle = {
  flush: (productId: number) => Promise<void>;
  hasPending: () => boolean;
};

export function ProductSkuSection({
  productId,
  ref,
}: {
  productId: number | null;
  ref?: Ref<ProductSkuSectionHandle>;
}) {
  const isPending = productId === null;

  const [skus, setSkus] = useState<Sku[] | null>(isPending ? [] : null);
  const [prices, setPrices] = useState<Record<number, number>>({});
  const [pending, setPending] = useState<PendingSku[]>([]);
  const [editingTempId, setEditingTempId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (productId === null) return;
    setError(null);
    const sb = getSupabase();
    const { data: skuRows, error: skuErr } = await sb
      .from("skus")
      .select("id, sku_code, variant_name, base_unit")
      .eq("product_id", productId)
      .order("id");
    if (skuErr) {
      setError(skuErr.message);
      return;
    }
    const list = (skuRows ?? []) as Sku[];
    setSkus(list);

    if (list.length > 0) {
      const ids = list.map((s) => s.id);
      const { data: priceRows } = await sb
        .from("prices")
        .select("sku_id, price, effective_from")
        .eq("scope", "retail")
        .is("effective_to", null)
        .in("sku_id", ids)
        .order("effective_from", { ascending: false });
      const map: Record<number, number> = {};
      for (const row of (priceRows ?? []) as PriceRow[]) {
        if (!(row.sku_id in map)) map[row.sku_id] = Number(row.price);
      }
      setPrices(map);
    } else {
      setPrices({});
    }
  }, [productId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useImperativeHandle(
    ref,
    () => ({
      hasPending: () => pending.length > 0,
      flush: async (newId: number) => {
        if (pending.length === 0) return;
        const sb = getSupabase();
        for (const p of pending) {
          const { data: skuId, error: rpcErr } = await sb.rpc("rpc_upsert_sku", {
            p_id: null,
            p_product_id: newId,
            p_sku_code: p.sku_code,
            p_variant_name: p.variant_name || null,
            p_spec: {},
            p_base_unit: p.base_unit || "個",
            p_weight_g: null,
            p_tax_rate: 0,
            p_status: "active",
            p_reason: null,
          });
          if (rpcErr) throw rpcErr;
          const priceStr = p.retail_price.trim();
          if (priceStr !== "") {
            const { error: priceErr } = await sb.rpc("rpc_set_retail_price", {
              p_sku_id: skuId,
              p_price: Number(priceStr),
              p_effective_from: new Date().toISOString(),
              p_reason: null,
            });
            if (priceErr) throw priceErr;
          }
        }
        setPending([]);
      },
    }),
    [pending]
  );

  function startNew() {
    setDraft({ ...EMPTY_DRAFT });
    setEditingTempId(null);
  }

  function startEditExisting(sku: Sku) {
    setDraft({
      id: sku.id,
      sku_code: sku.sku_code,
      variant_name: sku.variant_name ?? "",
      base_unit: sku.base_unit,
      retail_price: sku.id in prices ? String(prices[sku.id]) : "",
    });
    setEditingTempId(null);
  }

  function startEditPending(p: PendingSku) {
    setDraft({
      id: null,
      sku_code: p.sku_code,
      variant_name: p.variant_name,
      base_unit: p.base_unit,
      retail_price: p.retail_price,
    });
    setEditingTempId(p.tempId);
  }

  function deletePending(tempId: number) {
    setPending((arr) => arr.filter((x) => x.tempId !== tempId));
    if (editingTempId === tempId) {
      setDraft(null);
      setEditingTempId(null);
    }
  }

  function cancelEdit() {
    setDraft(null);
    setEditingTempId(null);
  }

  async function save() {
    if (!draft) return;
    setError(null);

    if (!draft.sku_code.trim()) {
      setError("規格編號必填");
      return;
    }

    if (isPending) {
      if (editingTempId !== null) {
        const tid = editingTempId;
        setPending((arr) =>
          arr.map((x) => (x.tempId === tid ? { ...draft, tempId: tid } : x))
        );
      } else {
        const tid = -Date.now();
        setPending((arr) => [...arr, { ...draft, tempId: tid }]);
      }
      cancelEdit();
      return;
    }

    setSaving(true);
    try {
      const sb = getSupabase();
      const { data: skuId, error: rpcErr } = await sb.rpc("rpc_upsert_sku", {
        p_id: draft.id,
        p_product_id: productId,
        p_sku_code: draft.sku_code,
        p_variant_name: draft.variant_name || null,
        p_spec: {},
        p_base_unit: draft.base_unit || "個",
        p_weight_g: null,
        p_tax_rate: 0,
        p_status: "active",
        p_reason: null,
      });
      if (rpcErr) throw rpcErr;

      const priceStr = draft.retail_price.trim();
      if (priceStr !== "") {
        const priceNum = Number(priceStr);
        const existing = skuId in prices ? prices[skuId as number] : null;
        if (existing !== priceNum) {
          const { error: priceErr } = await sb.rpc("rpc_set_retail_price", {
            p_sku_id: skuId,
            p_price: priceNum,
            p_effective_from: new Date().toISOString(),
            p_reason: null,
          });
          if (priceErr) throw priceErr;
        }
      }

      cancelEdit();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const isEditingExisting = draft?.id != null;
  const isEditingPending = editingTempId !== null;
  const isAddingNew = draft != null && !isEditingExisting && !isEditingPending;

  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">規格</h2>
          <p className="text-xs text-zinc-500">每個規格獨立計庫存與定價。</p>
        </div>
        {!draft && (
          <button
            type="button"
            onClick={startNew}
            className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            + 新增規格
          </button>
        )}
      </header>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="space-y-2">
        {skus === null && (
          <div className="h-12 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />
        )}

        {skus?.map((s) =>
          draft?.id === s.id ? (
            <DraftCard
              key={s.id}
              draft={draft}
              setDraft={setDraft}
              onSave={save}
              onCancel={cancelEdit}
              saving={saving}
            />
          ) : (
            <SkuCard
              key={s.id}
              sku={s}
              price={prices[s.id]}
              onEdit={() => startEditExisting(s)}
            />
          )
        )}

        {pending.map((p) =>
          editingTempId === p.tempId && draft ? (
            <DraftCard
              key={p.tempId}
              draft={draft}
              setDraft={setDraft}
              onSave={save}
              onCancel={cancelEdit}
              saving={saving}
            />
          ) : (
            <PendingCard
              key={p.tempId}
              p={p}
              onEdit={() => startEditPending(p)}
              onDelete={() => deletePending(p.tempId)}
            />
          )
        )}

        {isAddingNew && draft && (
          <DraftCard
            draft={draft}
            setDraft={setDraft}
            onSave={save}
            onCancel={cancelEdit}
            saving={saving}
          />
        )}

        {skus !== null && skus.length === 0 && pending.length === 0 && !draft && (
          <p className="rounded-md border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            還沒有規格。按「新增規格」開始。
          </p>
        )}
      </div>

      {isPending && pending.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          已暫存 {pending.length} 筆規格，將在「建立」商品時一併寫入。
        </p>
      )}
    </section>
  );
}

function SkuCard({
  sku,
  price,
  onEdit,
}: {
  sku: Sku;
  price: number | undefined;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-zinc-200 px-3 py-2 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{sku.sku_code}</span>
          {sku.variant_name && (
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {sku.variant_name}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {sku.base_unit}
          {price != null ? ` · $${price}` : ""}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        編輯
      </button>
    </div>
  );
}

function PendingCard({
  p,
  onEdit,
  onDelete,
}: {
  p: PendingSku;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50/40 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/20">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{p.sku_code}</span>
          {p.variant_name && (
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {p.variant_name}
            </span>
          )}
          <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
            待寫入
          </span>
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {p.base_unit}
          {p.retail_price ? ` · $${p.retail_price}` : ""}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        編輯
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="shrink-0 rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
      >
        移除
      </button>
    </div>
  );
}

function DraftCard({
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft({ ...draft, [key]: value });
  }

  return (
    <div className="space-y-3 rounded-md border-2 border-amber-300 bg-amber-50/40 p-3 dark:border-amber-800 dark:bg-amber-950/20">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="規格編號" required>
          <input
            value={draft.sku_code}
            onChange={(e) => set("sku_code", e.target.value)}
            placeholder="例：A001-100"
            className={inputClass}
          />
        </Field>
        <Field label="變體名">
          <input
            value={draft.variant_name}
            onChange={(e) => set("variant_name", e.target.value)}
            placeholder="例：100 入"
            className={inputClass}
          />
        </Field>
        <Field label="單位">
          <input
            value={draft.base_unit}
            onChange={(e) => set("base_unit", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="零售價">
          <input
            type="number"
            step="0.01"
            value={draft.retail_price}
            onChange={(e) => set("retail_price", e.target.value)}
            placeholder="$"
            className={inputClass}
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {saving ? "儲存中…" : "儲存"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700"
        >
          取消
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800";
