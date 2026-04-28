// Map known Postgres RAISE EXCEPTION messages → Chinese.
// Add patterns as more surface in production.

type Rule = { pattern: RegExp; render: (m: RegExpMatchArray) => string };

const RULES: Rule[] = [
  {
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
