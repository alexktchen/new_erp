// Map known Postgres RAISE EXCEPTION messages → Chinese.
// Add patterns as more surface in production.

type Rule = { pattern: RegExp; render: (m: RegExpMatchArray) => string };

const RULES: Rule[] = [
  {
    // 新版（含 SKU）：'Insufficient stock for SKU <code> (<name>): available=X, required=Y'
    pattern: /Insufficient stock for SKU\s+(\S+)\s*(?:\(([^)]*)\))?\s*:\s*available=([\d.]+),\s*required=([\d.]+)/i,
    render: (m) => {
      const code = m[1];
      const name = (m[2] ?? "").trim();
      const skuLabel = name ? `${code}（${name}）` : code;
      return `庫存不足：${skuLabel} 總倉只剩 ${fmt(m[3])} 件，本次需要 ${fmt(m[4])} 件`;
    },
  },
  {
    // 舊版（向後相容，無 SKU 資訊）
    pattern: /Insufficient stock:\s*available=([\d.]+),\s*required=([\d.]+)/i,
    render: (m) => `庫存不足：總倉只剩 ${fmt(m[1])} 件，本次需要 ${fmt(m[2])} 件`,
  },
  {
    pattern: /Insufficient points:\s*available=([\d.]+),\s*required=([\d.]+)/i,
    render: (m) => `點數不足：可用 ${fmt(m[1])} 點，本次需要 ${fmt(m[2])} 點`,
  },
  {
    pattern: /Insufficient wallet:\s*available=([\d.]+),\s*required=([\d.]+)/i,
    render: (m) => `儲值金不足：可用 $${fmt(m[1])}，本次需要 $${fmt(m[2])}`,
  },
  { pattern: /Outbound quantity must be positive/i, render: () => "出庫數量必須大於 0" },
  { pattern: /Inbound quantity must be positive/i, render: () => "入庫數量必須大於 0" },
  {
    pattern: /store\s+(\d+)\s+has no location_id(?:\s+mapped)?/i,
    render: (m) =>
      `分店 #${m[1]} 尚未綁定庫位（location_id 為空）。請到「分店設定」幫該店設定對應的庫位後再試。`,
  },
  {
    pattern: /source or dest store has no location_id/i,
    render: () => "來源或目的分店尚未綁定庫位，請先到「分店設定」補上。",
  },
  {
    pattern: /no locations defined for tenant/i,
    render: () => "此 tenant 尚未建立任何庫位。請先到「庫位設定」建立至少一個總倉/門市庫位。",
  },
  {
    pattern: /sku\s+(\d+)\s+allocation total\s+([\d.]+)\s+exceeds received\s+([\d.]+)/i,
    render: (m) =>
      `SKU #${m[1]} 的分店分配總和 ${fmt(m[2])} 超過實到數量 ${fmt(m[3])}，請重新分配。`,
  },
  // ===== Aid transfer 系列 =====
  {
    pattern: /aid order \d+ has no transferred_from_order_id/i,
    render: () => "找不到原源訂單（transferred_from_order_id 為空），無法派貨。",
  },
  {
    pattern: /source order \d+ has no pickup_store/i,
    render: () => "原源訂單沒有設定取貨分店，無法決定 source location。",
  },
  {
    pattern: /aid order \d+ is (\w+), only confirmed can ship/i,
    render: (m) => `此訂單目前是「${m[1]}」狀態，只有「confirmed」可以派貨。`,
  },
  {
    pattern: /no central warehouse location for tenant/i,
    render: () => "找不到總倉 location（type=central_warehouse）。請先到 locations 設定建立一個總倉。",
  },
  {
    pattern: /source and dest store share location_id/i,
    render: () => "來源店和目的店是同一個庫位，無法派貨。",
  },
  {
    pattern: /order \d+ has no aid_transfer items/i,
    render: () => "此訂單沒有任何 aid_transfer 來源的品項，無法派貨。",
  },
  {
    pattern: /order \d+ is shipping but has no terminal transfer/i,
    render: () => "訂單是 shipping 狀態但找不到對應的 transfer，資料不一致。請聯繫工程師。",
  },
  {
    pattern: /transfer \d+ already received, cannot cancel chain/i,
    render: () => "transfer chain 中已有單據被收貨，無法整個撤回。",
  },
  {
    pattern: /transfer \d+ is (\w+), only shipped can be rejected/i,
    render: (m) => `transfer 目前是「${m[1]}」狀態，只有「shipped」可以拒收。`,
  },
  {
    pattern: /order \d+ is (\w+), only pending\/confirmed\/shipping can be cancelled/i,
    render: (m) => `訂單目前是「${m[1]}」狀態，只有 pending / confirmed / shipping 可以取消。`,
  },
  {
    pattern: /transfer \d+ is in status (\w+), expected shipped/i,
    render: (m) => `transfer 目前是「${m[1]}」狀態，預期應為「shipped」。`,
  },
];

function fmt(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return Number.isInteger(n) ? String(n) : String(n);
}

export function translateRpcError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw);
  for (const r of RULES) {
    const m = msg.match(r.pattern);
    if (m) return r.render(m);
  }
  return msg;
}
