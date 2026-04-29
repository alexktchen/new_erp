---
title: BRIEF — 社群商品候選池與商品行事曆
status: workflow-aligned（已決方向、待 Alex 對焦技術細節）
audience: Alex（工程）+ 香奈（業主）
created: 2026-04-28
updated: 2026-04-28
related:
  - docs/PRD-商品模組.md
  - docs/PRD-訂單取貨模組.md（campaign 流程）
  - supabase/migrations/20260424130000_v02_q_closure_delta.sql（lele_order_imports pattern）
  - supabase/migrations/20260511000001_campaign_from_products.sql（既有 RPC）
---

# BRIEF — 社群商品候選池與商品行事曆

---

## 1. 背景

業主在 LINE 社群有一個機器人會抓所有人丟進來的商品（品名 / 文案 / 金額 / 圖）。希望 ERP 能讀機器人撈到的資料，老闆從中挑選哪些要開團。

**問題不在「商品本身」、在「商品來源到開團之間少了一段」**：機器人是源頭、現有的「商品 / SKU / 開團」是終點，中間需要一段「候選池 + 行事曆」才能銜接。

---

## 2. 核心結論

> **這不是改商品主檔，而是在商品主檔前面新增一個「社群來源收件匣 + 開團週曆」。**
> 機器人只負責收集，老闆負責挑選、收藏、排到開團日；
> 到當天由老闆確認後，才轉正式商品或接既有商品，最後接既有開團流程。

接點明確：
- **既有資產不動**：products / skus / campaigns 結構不改
- **唯一新東西**：1 張候選池表、1 個機器人入口、3 個 admin 頁（候選清單 / 商品週曆 / 今日待確認）
- **採用後唯一接點**：直接走 5/11 已做好的 `campaign_from_products` RPC

---

## 3. 使用流程

### 主流程

```
LINE 社群有人貼商品
    ↓
機器人帶密鑰 POST 一筆原始資料
    ↓
進「候選池」（raw 全留：品名、文案、金額、圖、貼文者、頻道、時間）
    ↓
系統自動標籤：新抓到 / 重複 / 資料不足
    ↓
老闆在「候選池」頁面看（預設只顯示最近 7 天）
    ↓
老闆動作三選一：
  A. 收藏（先存著、沒日期）
  B. 排上週曆（指定預計開團日）
  C. 忽略（從清單消失）
    ↓
到了預計開團日當天
    ↓
這些候選自動出現在「今日待確認」清單
    ↓
老闆逐筆確認、每筆要決定：
  - 接到既有商品（系統提示 70% 相似）← 第二次以後通常選這個
  - 或建立新商品（從 raw 預填、老闆只補分類）← 第一次選這個
    ↓
確認 = 走既有 campaign_from_products RPC，campaign 建立
```

**心法**：「排程」是計畫、「開團」是確認。東西可以先排、當天還是由人按一下。

### 第二次以後出現同一個商品

```
候選商品（系統提示「⚠️ 可能跟既有商品 X 70% 相似」）
    ↓
老闆選 B「接到既有正式商品」
    ↓
直接從那個 product 再開一次團、不用重建商品資料
    ↓
歷史售價、銷量、毛利、條碼、供應商、圖、文案全部接得起來
```

→ 商品庫**越用越有價值**，不是每次開團都重新開始。

---

## 4. 已確認決策（2026-04-28 香奈定）

| # | 決策 |
|---|---|
| 1 | 候選商品**保留 1 週**（UI 預設只顯示最近 7 天 + 已收藏 + 已排程；超過不刪、自動折疊） |
| 2 | 後台主要用**週曆**、不用月曆（左候選清單、右 7 天 grid、可拖排） |
| 3 | 排到某天後**不自動開團**、當天仍需老闆確認（避免出包；早上發 LINE 提醒） |
| 4 | 重複商品**只提示、不自動合併**（系統用品名相似度標記、人最終決定） |
| 5 | 採用候選商品 = **建正式商品**（不做「一次性商品」概念） |
| 6 | 未來再開同商品時，**接到既有正式商品再開團**（不重建） |
| 7 | **不做**「一次性商品類型」（products 表既有 `draft / active / inactive / discontinued` 4 狀態夠用）|

### 為什麼決策 #5+#6+#7 是這樣（累積價值 5 點）

「一律建正式 + 第二次接既有」帶來：

1. 之後再賣不用重建商品
2. 可以看到這商品以前賣過幾次
3. 可以看歷史售價、銷量、毛利
4. 不會一年後有一堆「其實是同一個東西」的開團紀錄散落各處
5. 條碼、供應商、圖片、文案能慢慢累積變乾淨

### 哲學定位

> 「只賣一次」其實只是「目前只開過一次團」，不是商品的種類屬性。

所以不另開「一次性商品」類型、沿用既有 4 狀態即可。

### 設計後果（影響 MVP 範圍）

「採用 = 建正式商品」會讓老闆每天頻繁建商品 → **「採用」按鈕的 UX 必須很順**（1~2 鍵完成、不能像填表單）。具體做法見 §5 MVP #6。

---

## 5. MVP 範圍

| # | 內容 | 為什麼要做 |
|---|---|---|
| 1 | 候選池表（含 raw JSONB + scheduled_open_at + 相似度欄位） | 收得到資料才有後面 |
| 2 | 機器人 POST 入口（Edge Function + 密鑰驗證） | 對接源頭 |
| 3 | admin「商品候選池」清單（預設 7 天視窗、可篩選 + 收藏 + 忽略 + 標重複） | 老闆能看、能整理 |
| 4 | admin「商品週曆」（7 天 grid、左候選右週曆、可拖排） | 排程的 UI 載體 |
| 5 | admin「今日待確認」（每日進入點 + 系統首頁紅色徽章） | 確保老闆每天知道要做什麼；**LINE 提醒 MVP 不做、放著**（見 §7 Q8） |
| 6 | **「採用」UX 順** ⭐：接既有（品名模糊搜提示）OR 一鍵建新（從 raw 預填、老闆只補分類） | 不順老闆會嫌煩、影響採納率 |
| 7 | 採用後接既有 `campaign_from_products` RPC | 不重做開團流程 |
| 8 | cron job：超過 N 天沒動的候選自動 archive（不刪、UI 折疊） | 避免池子越來越亂 |

**估時感**：1~1.5 週工程量。其中 #6「採用 UX」是 MVP 風險最大的一段、值得多花時間打磨。

---

## 6. 暫不處理（v1 範圍外）

- ❌ AI 自動清品名 / 自動分類（issue #103「1688/拼多多商品頁解析」延伸、晚一些）
- ❌ 排程到日**自動**開團（老闆手動確認為主）
- ❌ 候選池**自動**老化以外的智能排序 / 推薦
- ❌ 候選商品多語言 / 多幣別
- ❌ 跨社群熱度 / 比較 / BI 分析
- ❌ 機器人雙向（機器人只接進來、不從 ERP 推回社群、那是通知模組的事）

> **註**：LINE 推播提醒「先前以為要錢」一事已修正、實際 1 人 30 則/月免費。但 MVP 仍**延後不做**（見 §7 Q8）、首頁徽章 baseline 已夠、未來真要做時走「拉式」+ 用既有 group-buy-bot。

---

## 7. 待確認（技術細節）

### Alex 已答（2026-04-29）

> 完整 schema 草稿留到 PRD-社群商品候選池.md；本節給結論。

1. ✅ **狀態軸 → 分兩軸**：`system_status`（new / duplicate_hint / insufficient_data / archived_by_age）+ `owner_action`（none / collected / scheduled / adopted / ignored）。
   - 比照既有專案慣例：`purchase_requests.status` + `review_status`、`goods_receipts.status` + `arrival_status` 都這樣設計。
   - 兩軸正交、UI 上下兩個 badge、避免「老闆已收藏 + 系統 30 天 archive」flat 寫法打架。

2. ✅ **不合表、新開 `community_product_candidates`**：
   - 業務域不同（lele_order_imports = 訂單來源 → customer_orders；新表 = 商品來源 → products）
   - Lifecycle 不同（lele 用完即丟、候選池要持續顯示在週曆 / 比對相似度）
   - **借 lele 的 JSONB pattern**（raw + parsed + status enum + tenant index + RLS），但欄位另開（加 source_post_url / source_user_id / scheduled_open_at / similar_product_id 等）

3. ✅ **不開新表、候選池表加 `scheduled_open_at DATE` 欄位**：
   - 週曆 UI = `WHERE scheduled_open_at BETWEEN today AND today+6` 純讀
   - 拖排 UI = `UPDATE ... SET scheduled_open_at = ?` 一句、不要 join
   - partial index `WHERE scheduled_open_at IS NOT NULL`、未排程不佔 index
   - 同表加 `scheduled_by` / `scheduled_at` 留審計

4. ✅ **機器人密鑰 → Edge Function Secrets 延續既有**：
   - 新 secret：`COMMUNITY_BOT_SECRET`（Supabase Dashboard → Edge Functions → Secrets）
   - 驗證點：新 Edge Function `community-bot-ingest`，header `X-Bot-Secret: <token>`、不一致回 401 + audit log
   - **不放 Vault**：Vault 是 v1 infra issue（PRD-LIFF前端.md 列為基建）、目前還沒部署、升 Vault 是橫向任務、不該卡候選池 MVP
   - **不放表 BYTEA enc**：那是給 outbound 用（總部代加盟店打 LINE OA API 需要可解密）；候選池機器人是 inbound webhook、密鑰只用來驗證對方 → Edge Secret 即可

### 香奈已決（2026-04-28）

| 題 | 答 |
|---|---|
| 5. 舊候選多少天後折疊？ | **30 天**（cron 每日掃、標 status、UI 過濾；不刪、要查可手動撈） |
| 6. 重複偵測演算法 | **MVP 先簡單版**（品名 LIKE / trigram）、之後升 AI（issue #103 順便用） |
| 7. 「採用建正式商品」老闆採用當下最少補什麼 | **分類 + 供應商**（其他預填或 default、品名/圖/參考價從候選池帶） |

### 香奈已決：Q8 延後不做（2026-04-29）

8. **「今日待確認」LINE 提醒** → **MVP 不做、放著、之後再評**

   **成本算清楚**：
   - 提醒對象 = 老闆 1 人 × 1 則/天 × 30 天 = 30 則/月 ⊂ LINE OA 免費額度 200 則/月 → 實際成本 0
   - 不是錢的問題、是「需不需要」

   **延後不做的理由**：
   - 系統首頁紅色徽章 + 候選池 banner 是 baseline、足夠
   - 老闆每天本來就會開系統、不需要 bot 追著
   - 等實際跑一陣子、看會不會忘記、再決定要不要加

   **未來真要做時的設計筆記**（避免下次重新討論）：

   - **用既有 group-buy-bot 推**（不另開新 OA、避免管理多 channel）
   - **優先做「拉式」、不做「推式」**：
     - 拉式 = 老闆私訊機器人「今天」/「候選池」→ bot 即時回今日待確認清單
     - 拉式用 LINE reply message（1 分鐘內回覆）= **完全免費、不算推播額度**
     - 不打擾、不用排時段、不用存 userId（webhook 自帶）
     - 實作 ~30 分鐘
   - **推式（每天主動推）做為 P2**：跑一陣子確定有需要再加、~1.5 hr

   **無論未來做不做**：系統首頁紅色徽章 + 候選池 banner 是 baseline、必做。

---

## 8. 後續可轉 PRD 的內容（§7 全結 → 可立即升 PRD）

§7 已全部收斂（香奈 Q3/Q5/Q6/Q8 + Alex Q1/Q2/Q4/Q7）→ 這份可立即升 `PRD-社群商品候選池.md`、需要展開的內容：

- **候選池表 schema**：完整欄位、type、constraints、index、RLS policy
- **機器人 POST API spec**：URL、headers（密鑰）、body shape、response、錯誤碼
- **「採用」流程 UI wireframe**：接既有商品 vs 建新商品 兩條路的具體畫面
- **「商品週曆」UI 互動規格**：拖排 / 點選 / 換週 / 多筆批次操作
- **相似度提示的具體實作**：threshold（70% 是建議值、要驗）、比對欄位（只比 name、還是 name+price+image）、預先計算還是 query 時算
- **archive cron 規格**：每日幾點跑、conditions、是否有 retry / 通知
- **通知模組整合**：LINE 推提醒的訊息模板、觸發時機、收件人
- **RBAC**：誰能看候選池、誰能採用、誰能看行事曆（推：老闆 + 小幫手）
- **狀態 enum 完整定義**：系統 enum + 老闆 enum 兩個的所有值 + 轉換規則
- **「採用」product 欄位預填 mapping 表**：raw → product 各欄位的對應
- **重複偵測 trigger 機制**：寫入時即時算還是 batch 算
- **與 group_buy_campaigns 的銜接**：是否需要在 campaigns 加 `source = 'community_pool'` 欄位、追溯用
- **機器人密鑰管理**：存放、rotation、失效處理
- **E2E 測試 scenario**：對應 `npm run db:reset:*` 的新情境

---

## 跟其他模組的關係

- **不動**：商品 / SKU / campaigns / 採購 / 庫存 / 銷售 既有模型
- **接點**：採用後唯一 RPC 呼叫 = `campaign_from_products`
- **接點**：「今日待確認」LINE 推提醒 = 通知模組（待 §7 Q8 決定）
- **可能受惠**：之後 issue #103（商品頁 vision 解析）的 prompt / golden dataset 可以共用候選池當訓練樣本

---

## 附錄：實際文案範例與 AI 解析難度

> 給工程方校準難度、避免低估解析成本。**這個附錄對應 issue #102「團購記事本貼文解析」**。

### 真實 LINE 文案範例（2026-04-29 香奈提供）

```
好鄰居💕敲碗回歸

西井村 隱藏版丼飯系列牛肉丼（260g）

($)(8)(5)

(A)豬肉丼
(B)牛肉丼

⏰4/30結單
10-20天到貨通知

這包真的太方便加熱後打一顆蛋🥚
就是吉野家等級丼飯(emoji)
嚴選雪花牛五花🐮搭配洋蔥絲慢火熬煮🧅加入昆布＋柴魚熬製日式丼飯醬汁鹹甜交織、牛肉軟嫩入味(emoji)

(heart)配白飯超銷魂
(dance)拌麵條也好吃
(thumping)加顆半熟蛋更升級

(emoji)重量260克
```

### 期望 AI 解析輸出

```jsonc
{
  "campaign_hint": "好鄰居敲碗回歸",  // 「敲碗回歸」= 是回團、之前開過
  "products": [
    { "code": "A", "name": "西井村隱藏版丼飯 豬肉丼", "weight_g": 260, "price": 85 },
    { "code": "B", "name": "西井村隱藏版丼飯 牛肉丼", "weight_g": 260, "price": 85 }
  ],
  "close_date": "4/30",
  "delivery_estimate_days": "10-20",
  "category_guess": "冷凍 / 即食調理包",
  "selling_points": [
    "雪花牛五花 + 洋蔥慢火熬",
    "昆布柴魚日式丼飯醬汁",
    "加蛋升級 / 配飯拌麵都行"
  ],
  "raw_text": "（保留原文供老闆覆核）"
}
```

### 為什麼純規則做不到

| 文案特徵 | 規則的痛 | AI 處理 |
|---|---|---|
| `($)(8)(5)` 是 $85（LINE emoji 化的數字）| 要 hard-code emoji → 數字轉換表、新 emoji 出來就壞 | 一眼看懂 |
| 一篇兩個商品（A 豬 / B 牛）| 要假設「(A)/(B)」格式、換成「1./2.」就死 | 自動辨識 |
| 第一行「好鄰居敲碗回歸」不是品名 | 規則沒辦法判斷哪行才是品名 | 上下文推斷 |
| 大量 emoji + (emoji) (heart) (dance) 噪音 | 要逐個過濾 | 自動忽略 |
| 廣告文 / 賣點 / 規格 混在一起 | 要寫一堆 keyword 拆段 | 自動分類 |

### 成本估算

- 用 Claude Haiku 解析這種長度的文案：**約 NT$ 0.05~0.2 / 筆**
- 假設每天 50 筆、一個月 75~300 元 → **可忽略**

### MVP 是否要立刻做 AI 解析？

**不要**。MVP 第一版讓 raw 文案進 Sheet、由老闆人眼讀 + 手動建商品。AI 解析（issue #102）是 P0 但獨立 spike、晚一點補上、省的時間是 bonus、不是 blocker。

候選池 schema 預留欄位：
- `raw_text TEXT NOT NULL` ← 必存、追溯用
- `parsed JSONB` ← 之後 AI 解析填、可空
- `parsed_at TIMESTAMPTZ` ← AI 解析時間、可空

---

## 變更歷史

- **2026-04-28** v0.1：第一次寫入。基於香奈 + Claude 對話 6 點補充（狀態多元、行事曆、參考價、新增 vs 接既有、原始來源、密鑰）+ Claude 補的 3 個坑（池子老化、去重 UI、當天觸發）+ 香奈第二輪補的「採用 ≠ 排程 ≠ 開團」。
- **2026-04-28** v0.2：香奈回 Alex 5 題對焦：(1) 7 天視窗 (2) 週曆 UI (3) 老闆確認 (4) 重複只提示 (5) 採用一律建正式商品。MVP 範圍微調。
- **2026-04-28** v0.3：補強第 5 點論述（累積價值 5 點 + 狀態沿用 + 「只賣一次」哲學定位 + 「第二次接舊商品」流程圖示）。
- **2026-04-28** v0.4：依香奈建議的 8 段結構整本重組（背景 / 核心結論 / 使用流程 / 已確認決策 / MVP 範圍 / 暫不處理 / 待 Alex 確認 / 後續可轉 PRD）。新增「後續可轉 PRD 內容」清單作為升 PRD 的 checklist。核心結論獨立成段並引用「不是改商品主檔、而是在主檔前面加收件匣 + 週曆」這句。
- **2026-04-28** v0.5：香奈回 Q3/Q5/Q6（30 天 / 先簡單版升 AI / 分類+供應商）→ 進「已確認決策」。Q8（LINE 推播）一度誤判成本、香奈點破實際算法後修正：1 老闆 × 30 則/月在免費額度內、成本 = 0；問題改回「需不需要推」、待香奈決。
- **2026-04-29** v0.6：新增附錄「實際文案範例與 AI 解析難度」。香奈提供真實 LINE 團購文案（西井村丼飯）、含 emoji 化價格 / 多選項 / 噪音 / 賣點混合等典型難度。對應 issue #102 校準工程方期望、確認 MVP 不做 AI 解析（raw 進 Sheet + 人工讀）、但候選池 schema 預留 `parsed JSONB` 欄位給之後填。
- **2026-04-29** v0.7：Q8 LINE 推播 → **MVP 延後不做**。首頁紅色徽章 baseline 已足、跑一陣子看會不會忘記再決定。未來真要做時的設計筆記入 §7：用既有 group-buy-bot（不另開 OA）、走「拉式」優先（老闆私訊「今天」bot 回清單、reply message 完全免費）、推式 P2 再評。§7 全部問題狀態已收斂、剩 Alex 4 題技術。
- **2026-04-29** v0.8：§7 4 題技術細節 Alex 答完。Q1 雙軸 status（system_status + owner_action，比照既有 purchase_requests / goods_receipts 慣例）；Q2 新開 `community_product_candidates` 表（借 lele_order_imports 的 JSONB / status enum / RLS pattern 但業務域不同不合表）；Q3 候選池表加 `scheduled_open_at DATE` 欄位 + partial index（不開新表）；Q4 Edge Function Secrets 模式（`COMMUNITY_BOT_SECRET`，延續既有 LINE_CHANNEL_SECRET 慣例、不走 Vault 因 infra 未建、不走表 BYTEA enc 因 inbound webhook 不需可解密）。**§7 全收斂 → 可升 `PRD-社群商品候選池.md`**。
