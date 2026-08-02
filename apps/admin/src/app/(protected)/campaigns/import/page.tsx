"use client";

import Link from "next/link";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import SpinButton from "@/components/SpinButton";

type ImportRow = {
  productCode: string;
  productName: string;
  campaignName: string;
  openDate: string;
  endAt: string;
  pickupDeadline: string;
  description: string;
};

type PreviewRow = ImportRow & {
  productId: number | null;
  matchedName: string;
  skuCount: number;
  status: "ready" | "missing" | "no_sku" | "created" | "error";
  message: string;
  campaignId?: number;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote && ch === '"' && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      quote = !quote;
    } else if (!quote && ch === ",") {
      row.push(cell);
      cell = "";
    } else if (!quote && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

function headerMap(headers: string[]) {
  const map = new Map<string, number>();
  headers.forEach((h, i) => map.set(h.trim(), i));
  return map;
}

function cleanName(value: string) {
  return value
    .replace(/#[^#]*#/g, "")
    .replace(/[💰⏰🔥⬜]/g, " ")
    .replace(/\d{1,2}\/\d{1,2}\s*結單/g, " ")
    .replace(/\$\s*\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toRows(csv: string): ImportRow[] {
  const parsed = parseCsv(csv);
  if (parsed.length < 2) return [];
  const hm = headerMap(parsed[0]);
  const get = (row: string[], name: string) => row[hm.get(name) ?? -1]?.trim() ?? "";
  return parsed.slice(1).map((row) => ({
    productCode: get(row, "商品編號"),
    productName: cleanName(get(row, "商品名稱")),
    campaignName: get(row, "團名稱") || get(row, "商品名稱"),
    openDate: get(row, "開團日"),
    endAt: get(row, "收單時間"),
    pickupDeadline: get(row, "取貨截止日"),
    description: get(row, "文案"),
  })).filter((row) => row.productCode || row.productName || row.campaignName);
}

function toIsoLocal(value: string, fallbackDate: string) {
  const raw = value || (fallbackDate ? `${fallbackDate}T23:59` : "");
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function safeEq(value: string) {
  return value.replace(/[(),]/g, " ").trim();
}

async function findProduct(row: ImportRow) {
  const sb = getSupabase();
  const code = safeEq(row.productCode);
  if (code) {
    const { data } = await sb
      .from("products")
      .select("id, name")
      .eq("status", "active")
      .or(`product_code.eq.${code},customized_id.eq.${code}`)
      .limit(2);
    if ((data ?? []).length === 1) return data![0] as { id: number; name: string };
  }

  const keyword = cleanName(row.productName || row.campaignName).replace(/[%,()]/g, " ").trim();
  if (!keyword) return null;
  const { data } = await sb
    .from("products")
    .select("id, name")
    .eq("status", "active")
    .ilike("name", `%${keyword}%`)
    .limit(2);
  return (data ?? []).length === 1 ? data![0] as { id: number; name: string } : null;
}

async function activeSkuCount(productId: number) {
  const { count } = await getSupabase()
    .from("skus")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .eq("status", "active");
  return count ?? 0;
}

export default function CampaignImportPage() {
  const [csv, setCsv] = useState("");
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

  async function loadFile(file?: File) {
    if (!file) return;
    setCsv(await file.text());
  }

  async function preview() {
    const imported = toRows(csv);
    setBusy(true);
    setLog(`解析 ${imported.length} 筆，開始比對商品…`);
    const next: PreviewRow[] = [];
    for (const row of imported) {
      const product = await findProduct(row);
      if (!product) {
        next.push({ ...row, productId: null, matchedName: "", skuCount: 0, status: "missing", message: "找不到唯一 active 商品" });
        continue;
      }
      const skuCount = await activeSkuCount(product.id);
      next.push({
        ...row,
        productId: product.id,
        matchedName: product.name,
        skuCount,
        status: skuCount > 0 ? "ready" : "no_sku",
        message: skuCount > 0 ? "可建團" : "商品沒有 active SKU",
      });
    }
    setRows(next);
    setLog(`可建團 ${next.filter((r) => r.status === "ready").length} / ${next.length} 筆`);
    setBusy(false);
  }

  async function createReady() {
    setBusy(true);
    const sb = getSupabase();
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      const row = next[i];
      if (row.status !== "ready" || !row.productId) continue;
      const endAt = toIsoLocal(row.endAt, row.openDate);
      if (!endAt) {
        next[i] = { ...row, status: "error", message: "收單時間錯誤" };
        setRows([...next]);
        continue;
      }
      const { data, error } = await sb.rpc("rpc_create_campaign_from_product", {
        p_name: row.campaignName || row.matchedName,
        p_end_at: endAt,
        p_pickup_deadline: row.pickupDeadline || null,
        p_product_id: row.productId,
        p_description: row.description || null,
      });
      next[i] = error
        ? { ...row, status: "error", message: error.message }
        : { ...row, status: "created", message: "已建團", campaignId: Number(data) };
      setRows([...next]);
    }
    setBusy(false);
    setLog("建團完成");
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">匯入開團檔</h1>
          <p className="text-sm text-zinc-500">從開團助手匯出的 new ERP 開團 CSV 建立開團，只處理已匹配 active 商品。</p>
        </div>
        <Link href="/campaigns" className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
          回開團
        </Link>
      </header>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".csv,text/csv" onChange={(e) => loadFile(e.target.files?.[0])} className="text-sm" />
          <SpinButton onClick={preview} disabled={busy || !csv.trim()} className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900">
            預覽比對
          </SpinButton>
          <SpinButton onClick={createReady} disabled={busy || !rows.some((r) => r.status === "ready")} className="rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            建立可建團項目
          </SpinButton>
          <span className="text-sm text-zinc-500">{log}</span>
        </div>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder="也可以直接貼上 CSV 內容"
          className="mt-3 h-48 w-full rounded-md border border-zinc-300 bg-white p-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
        />
      </section>

      <section className="overflow-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500 dark:bg-zinc-950">
            <tr>
              <th className="px-3 py-2">商品編號</th>
              <th className="px-3 py-2">CSV 商品</th>
              <th className="px-3 py-2">匹配商品</th>
              <th className="px-3 py-2">收單時間</th>
              <th className="px-3 py-2">狀態</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-3 py-2 font-mono text-xs">{row.productCode || "—"}</td>
                <td className="px-3 py-2">{row.productName || row.campaignName}</td>
                <td className="px-3 py-2">{row.productId ? `#${row.productId} ${row.matchedName}（SKU ${row.skuCount}）` : "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.endAt || "—"}</td>
                <td className="px-3 py-2">
                  <span className={row.status === "ready" ? "text-green-600" : row.status === "created" ? "text-blue-600" : "text-red-600"}>
                    {row.message}{row.campaignId ? ` #${row.campaignId}` : ""}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
