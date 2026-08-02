"use client";

// 匯出「樂樂團購」商品上架檔。
// 格式是拿老闆實際上架成功的檔反推的：Excel 97-2003 (BIFF8 .xls)、工作表名「商品匯入」、
// 24 欄固定順序。⚠ 樂樂不吃 xlsx，bookType 一定要 biff8。
//
// 一團一列。單款把售價寫進品名（💰85）、多款不寫（價格不同），
// 改用「(A)款名,(B)款名」對上「售價」欄的逗號序列 — 兩邊順序必須完全對齊。

export type LeleItem = {
  id: number;
  sort_order: number;
  unit_price: number | string;
  variant_name: string | null;
  sku_code: string;
};

export type LeleCampaign = {
  campaign_no: string;
  name: string;
  description: string | null;
  end_at: string | null;
  items: LeleItem[];
};

/** 樂樂匯入檔固定 24 欄 */
export const LELE_COLUMN_COUNT = 24;

/** 表頭（含欄內換行，順序與字面都不可動 — 樂樂靠這個認欄位）*/
export const LELE_HEADERS = [
  "保留欄位",
  "自定義編號",
  "商品名稱",
  "主要分類\n(款式名稱，以半形逗號分隔)",
  "細項一\n(款式二名稱，以半形逗號分隔)",
  "細項二\n(款式三名稱，以半形逗號分隔)",
  "售價\n(以半形逗號分隔)",
  "VIP價\n(以半形逗號分隔)",
  "成本\n(以半形逗號分隔)",
  "庫存\n(以半形逗號分隔)",
  "僅限VIP\n(1=是, 空白=否)",
  "上架個人賣場\n(1=是, 空白=否)",
  "商品分類\n(以半形逗號分隔)",
  "僅供現貨\n(1=是, 空白=否)",
  "禁止結單\n(1=是, 空白=否)",
  "成團人數",
  "收單時間\n(yyyy/M/d  hh:mm:ss AM/PM)",
  "自定義標籤\n(以半形逗號分隔)",
  "倉儲位置",
  "預設供貨商",
  "商品描述",
  "商品備註",
  "公開備註",
  "檔案版本",
];

const SHEET_NAME = "商品匯入";

/** 售價：整數不要拖小數點（實檔是 85，不是 85.0000）*/
function fmtPrice(v: number | string): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "";
}

function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 品名裡的收單日 M/D，不補零（4/5 不是 04/05）*/
function fmtMonthDay(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 收單時間欄：yyyy/M/d ＋ 兩個半形空格 ＋ hh:mm:ss ＋ " PM"（照老闆實檔原樣，PM 是固定字面）*/
function fmtCloseAt(d: Date | null): string {
  if (!d) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}  ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} PM`;
}

/**
 * BIFF8 單一儲存格的字串上限＝255 個 UTF-16 code unit（不是 code point）。
 * SheetJS 0.18.5 寫超過就「靜默」截到 255，不報錯也不警告 — 實測 256→255、3000→255。
 * （bookSST:true 那條路在 ~4000 字會 OOM 讓整個 process 掛掉，比截斷更糟，不能走。）
 */
const BIFF8_MAX_CHARS = 255;

/**
 * 安全截斷：切完若尾巴是孤兒 high surrogate（emoji 被切一半）就再退一格。
 * 老闆文案大量用 emoji（🌿⏰💰🇯🇵），emoji 佔 2 個 code unit，
 * 天真的 slice(0,255) 實測會留下 \ud83c 這種半個字元，寫進檔案就是亂碼。
 */
function cutForBiff8(text: string): string {
  if (text.length <= BIFF8_MAX_CHARS) return text;
  const cut = text.slice(0, BIFF8_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** 款式序號 A、B、C…（超過 26 款接 AA、AB…，避免掉出字母範圍變亂碼）*/
function letterLabel(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

/** 商品描述被 255 字上限截掉的團，匯出後要回報給使用者（不擋匯出）*/
export type LeleTruncation = {
  campaign_no: string;
  name: string;
  /** 截斷前的長度，單位是 UTF-16 code unit（emoji 算 2）*/
  originalLength: number;
};

/** 因為欄 3/欄 6 會破 255 而「整團不匯出」的團 — 嚴重度高於描述截斷 */
export type LeleSkip = {
  campaign_no: string;
  name: string;
  itemCount: number;
  /** 哪一欄過長、長到多少，讓老闆知道要拆多少 */
  reason: string;
};

/**
 * 組出整份工作表的列（第 0 列是表頭）。純函式、無 DOM，方便單獨驗。
 * 沒有 campaign_items 的團會跳過（無款式無售價，樂樂吃不了）。
 * 商品描述超過 255 字會被截斷並記進 truncated（老闆現行流程本來就在截，
 * 不可接受的是「靜默」截 → 照常匯出，但要講出來截了哪幾團）。
 */
export function buildLeleRows(campaigns: LeleCampaign[]): {
  rows: string[][];
  truncated: LeleTruncation[];
  skipped: LeleSkip[];
} {
  if (LELE_HEADERS.length !== LELE_COLUMN_COUNT) {
    throw new Error(`匯出樂樂：表頭欄數 ${LELE_HEADERS.length} ≠ ${LELE_COLUMN_COUNT}`);
  }

  const rows: string[][] = [LELE_HEADERS.slice()];
  const truncated: LeleTruncation[] = [];
  const skipped: LeleSkip[] = [];

  for (const c of campaigns) {
    const items = [...c.items].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    if (items.length === 0) continue;
    const multi = items.length > 1;

    const endAt = toDate(c.end_at);
    // end_at 是 null 就整段 ⏰…結單 省略
    const closeTag = endAt ? `⏰${fmtMonthDay(endAt)}結單` : "";
    // 多款價格不同，品名不放 💰
    const priceTag = multi ? "" : `💰${fmtPrice(items[0].unit_price)}`;
    const title = `⬜${c.name}${priceTag}${closeTag}`;

    // 單款：主要分類 = 商品名稱整串；多款：(A)款名,(B)款名…（順序與售價欄一致）
    const category = multi
      ? items.map((it, i) => `(${letterLabel(i)})${it.variant_name?.trim() || it.sku_code}`).join(",")
      : title;
    const prices = items.map((it) => fmtPrice(it.unit_price)).join(",");

    // 欄 3 主要分類 / 欄 6 售價是「半形逗號分隔」欄位。這兩欄一旦破 255 被 BIFF8 截掉，
    // 款式會少幾個、售價卻一個沒少 → 樂樂自動補價 → 上架出價格錯誤的商品（會賠錢）。
    // 描述截斷只是文案變短可以接受，這個不行 → 整團不寫進檔案，交回去請人拆團。
    // 實測門檻：約 22 款以內安全，26 款 x 8 字款名就會錯位。
    const overLong: string[] = [];
    if (category.length > BIFF8_MAX_CHARS) overLong.push(`主要分類 ${category.length} 字元`);
    if (prices.length > BIFF8_MAX_CHARS) overLong.push(`售價 ${prices.length} 字元`);
    if (overLong.length > 0) {
      skipped.push({
        campaign_no: c.campaign_no,
        name: c.name,
        itemCount: items.length,
        reason: `${overLong.join("、")}，超過單欄上限 ${BIFF8_MAX_CHARS}`,
      });
      continue;
    }

    // 欄 20 商品描述是唯一「可以」截斷的長欄位（開團文案沒有長度限制）
    const description = c.description ?? "";
    const descriptionCut = cutForBiff8(description);
    if (descriptionCut !== description) {
      truncated.push({ campaign_no: c.campaign_no, name: c.name, originalLength: description.length });
    }

    const row = [
      "",              // 0  保留欄位
      c.campaign_no,   // 1  自定義編號
      title,           // 2  商品名稱
      category,        // 3  主要分類
      "",              // 4  細項一
      "",              // 5  細項二
      prices,          // 6  售價
      "",              // 7  VIP價
      "",              // 8  成本
      "",              // 9  庫存
      "",              // 10 僅限VIP
      "1",             // 11 上架個人賣場
      "團購商品💕",     // 12 商品分類
      "",              // 13 僅供現貨
      "1",             // 14 禁止結單
      "",              // 15 成團人數
      fmtCloseAt(endAt), // 16 收單時間
      "",              // 17 自定義標籤
      "",              // 18 倉儲位置
      "",              // 19 預設供貨商
      descriptionCut,  // 20 商品描述（保留原本換行；超過 255 已安全截斷）
      "",              // 21 商品備註
      "",              // 22 公開備註
      "1",             // 23 檔案版本
    ];

    if (row.length !== LELE_COLUMN_COUNT) {
      throw new Error(`匯出樂樂：團 ${c.campaign_no} 欄數 ${row.length} ≠ ${LELE_COLUMN_COUNT}`);
    }
    // 欄 3（主要分類）與欄 6（售價）都是「半形逗號分隔」欄位，兩邊筆數必須一致。
    // 對不齊時樂樂不會擋下來，而是自動補足最後一筆數字 → 默默上架成錯的商品（比直接失敗更糟），
    // 所以這裡寧可整份匯出失敗、把團號團名報出來讓人去改，也不自動替換逗號
    // （自動替換會讓商品名稱與主要分類兩欄長得不一樣，更難查）。
    // 單款時 category = title，團名裡的半形逗號會被同一個檢查抓到（nPrice 恆為 1）。
    const nVariant = category.split(",").length;
    const nPrice = prices.split(",").length;
    if (nVariant !== nPrice) {
      const culprit = multi ? "款式名稱" : "團名";
      throw new Error(
        `匯出樂樂：團 ${c.campaign_no}「${c.name}」款式數 ${nVariant} ≠ 售價數 ${nPrice}（${culprit}可能含半形逗號，請先改掉再匯出）`,
      );
    }
    rows.push(row);
  }

  return { rows, truncated, skipped };
}

/**
 * 產生並下載樂樂上架檔。
 * exported  = 實際匯出的團數（0 表示沒東西可匯，不會產生檔案）
 * truncated = 商品描述被截到 255 字的團（有匯出，但文案被砍）
 * skipped   = 欄 3/欄 6 會破 255 而整團沒匯出的團（嚴重度較高，呼叫端要另外醒目顯示）
 */
export async function exportLeleXls(
  campaigns: LeleCampaign[],
  filename: string,
): Promise<{ exported: number; truncated: LeleTruncation[]; skipped: LeleSkip[] }> {
  const { rows, truncated, skipped } = buildLeleRows(campaigns);
  const exported = rows.length - 1; // 扣掉表頭
  // 全被跳過（或本來就沒東西）→ 不產生空檔
  if (exported === 0) return { exported: 0, truncated, skipped };

  // 動態載入：xlsx 近 1MB，不讓它進開團頁的主 bundle
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  XLSX.writeFile(wb, filename, { bookType: "biff8" });
  return { exported, truncated, skipped };
}
