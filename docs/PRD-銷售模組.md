---
title: PRD - 銷售模組
module: Sales
status: draft-v0.1
owner: www161616
created: 2026-04-20
tags: [PRD, ERP, 銷售, Sales, POS]
---

# PRD — 銷售模組（Sales Module）

> 涵蓋三種銷售型態：**B2B 批發銷售**、**門市散客 POS**、**員工餐扣帳**。
> 付款方式支援：現金 / 信用卡 / LinePay / 街口 / 電子發票載具 / 月結掛帳。
> 電子發票沿用舊系統串接。

---

## 1. 模組定位
- [ ] 所有「收入面」業務的單據中心
- [ ] 下游：觸發庫存模組出庫（`rpc_outbound`）；產生發票；增加應收帳款
- [ ] **不**擁有：庫存扣減邏輯（庫存模組）、發票格式產生（沿用舊系統模組）、薪資計算（HR）

---

## 2. 三種銷售型態對照

| 特性 | A. B2B 批發 | B. 門市 POS | C. 員工餐 |
|---|---|---|---|
| 客戶 | 餐廳 / 固定批發客戶 | 現場散客（可具名）| 員工 |
| 觸發點 | 業務 / LINE / 電話下單 | 現場掃碼結帳 | 員工自取 |
| 付款時機 | 月結 or 貨到 | 即時 | 月薪資扣款 |
| 價格 | 客戶級距價 / 議價 | 牌價（可折扣） | 員工價（可 0）|
| 發票 | 三聯式 | 二聯式電子發票 | 不開 |
| 出貨 | 分多次可能 | 現場取貨 | 現場取 |
| 應收 | 產生應收 → 沖帳 | 即時結清 | 月扣 |
| 量級 | 日均 50~200 張 | 日均各店 100~500 筆 | 日均 ~20 筆 |

---

## 3. Goals
- [ ] G1 — B2B 下單到出貨時間 ↓ 30%，透過預帶客戶階級價 + 快速複製歷史單
- [ ] G2 — POS 結帳單筆完成時間 ≤ 30 秒（從開始到列印小票）
- [ ] G3 — 月結對帳自動產生，人工對帳時間 ↓ 70%
- [ ] G4 — 退貨 / 退款可追溯到原銷售單、原付款、原庫存異動
- [ ] G5 — 員工餐月扣款清單自動產出給會計

---

## 4. Non-Goals（v1 不做）
- [ ] ❌ **電子發票 API 重寫** — 沿用舊系統、只留整合欄位
- [ ] ❌ **散客會員 / 點數 / CRM** — 僅保留客戶主檔欄位，P2
- [ ] ❌ **線上商城 / 電商訂單** — P2 獨立模組
- [ ] ❌ **多店出貨 split（一張訂單從多店拆出）** — v1 一張單一個出貨倉
- [ ] ❌ **複雜促銷引擎（A+B 第二件 X 折、滿件送、會員日⋯⋯）** — 僅支援單品折扣、整單折扣
- [ ] ❌ **信用卡分期、退刷流程** — 紀錄付款金額與卡別即可，實際分期交銀行

---

## 5. User Stories

### 5.1 B2B 批發（業務 / 門市店長）
- [ ] 作為業務，我要能快速開銷售單（帶客戶預設階級價、複製上次訂單）
- [ ] 作為業務，我要能**分批出貨**（客戶訂 100 箱，先出 30 箱、隔週再出 70 箱）
- [ ] 作為業務，我要能**掛帳**（這張單今天不收錢、進應收）
- [ ] 作為業務，我要能為同一客戶手動議價（逐品修改單價）
- [ ] 作為店長，我要能看「本店本月未出貨訂單」、「逾期未收款客戶」
- [ ] 作為會計，我要能月底產生對帳單給每個 B2B 客戶（含未結明細）

### 5.2 門市 POS 散客（店員）
- [ ] 作為店員，我要能掃條碼加入購物車，連續結帳不卡
- [ ] 作為店員，我要能**混合付款**（500 元現金 + 300 元信用卡 + 200 元 LinePay）
- [ ] 作為店員，我要能輸入客戶統編 / 載具條碼（手機條碼 / 自然人憑證 / 悠遊卡）
- [ ] 作為店員，我要能**整單打折**或**單品打折**（需權限密碼）
- [ ] 作為店員，遇到退貨顧客 → 掃原發票條碼 → 系統帶出原單 → 選退貨品項
- [ ] 作為店員，每天營業結束要做**日結**（現金點收、卡別對帳）

### 5.3 員工餐（員工 / 店長）
- [ ] 作為員工，我要能在系統登記「今日取了 XX 兩份」
- [ ] 作為店長，我要能查本店員工每月取餐清單
- [ ] 作為會計，我要能月底匯出「員工扣款清單」交薪資系統

### 5.4 總部老闆 / 管理
- [ ] 作為老闆，我要看集團日銷售儀表板（B2B / POS / 員工餐 分類）
- [ ] 作為老闆，我要看客戶 Top 20、商品 Top 20、滯銷 Top 20
- [ ] 作為會計，我要看應收老化分析（30/60/90 天）

---

## 6. Functional Requirements

### 6.1 客戶主檔
- [ ] 型別：`b2b` / `walk_in`（散客預設 1 筆匿名）/ `employee`（員工餐用）
- [ ] B2B 欄位：公司名、統編、聯絡人、付款條件、信用額度、階級 (A/B/C)
- [ ] 員工欄位：對應員工 id、員工價等級
- [ ] 客戶階級價：`(customer_tier, sku_id) → price`（P1 才用）

### 6.2 B2B 銷售流程（Sales Order, SO）
- [ ] 建單：選客戶 → 預帶階級價 → 逐項加品項 / 複製舊單
- [ ] 狀態：`draft → confirmed → partially_shipped → shipped → invoiced → closed / cancelled`
- [ ] 分批出貨：每次出貨建 `sales_deliveries`，更新 `qty_shipped`
- [ ] 出貨當下 → 呼叫 **庫存模組 `rpc_outbound`**（type = `sale`，source 指向 delivery）
- [ ] 開發票：可一張 SO 對應一張或多張發票（依出貨節奏）
- [ ] 月結掛帳 → 產生 `receivables` 紀錄

### 6.3 POS 結帳流程
- [ ] 掃碼 / 手選商品入購物車
- [ ] 單品折扣 / 整單折扣（需權限）
- [ ] 選客戶（或匿名）/ 輸入統編 / 載具
- [ ] **混合付款**：一筆交易可同時有多種付款方式
- [ ] 付款完成 → 同時：
  - [ ] 扣庫存（`rpc_outbound` type=`sale`）
  - [ ] 開發票（呼叫既有發票系統 API）
  - [ ] 列印小票
  - [ ] 寫入 payments 紀錄
- [ ] 日結：每日營業結束跑一次，產出日結單（現金短溢、卡別總額）

### 6.4 退貨 / 退款
- [ ] 來源：POS 即時退、事後退（需原發票）、B2B 退（需原 SO）
- [ ] 狀態：`draft → confirmed → refunded`
- [ ] 確認退貨 → 庫存入庫（`rpc_inbound` type=`customer_return`）
- [ ] 退款：原路退（現金退現金、刷卡退刷卡）；作廢發票 or 開折讓
- [ ] 部分退：只退部分品項 / 部分數量

### 6.5 付款（Payments）
- [ ] 付款方式列舉：
  - `cash`（現金）
  - `credit_card`（信用卡 — 可再細分卡別：VISA / Master / JCB）
  - `line_pay`
  - `jko_pay`（街口）
  - `credit_sale`（月結掛帳 → 產生應收）
- [ ] 一筆銷售可多筆付款（payment_lines）
- [ ] 每筆付款紀錄：金額、方式、交易單號（信用卡授權碼、電支 tx id）、狀態
- [ ] 找零：現金超收可自動計算找零；電子支付找零為 0

### 6.6 發票（沿用舊系統）
- [ ] 開立時機：
  - POS：結帳完成即時開
  - B2B：依客戶偏好（隨貨開 / 月結開）
- [ ] 本系統內僅存：發票號碼、載具 / 統編、發票狀態、發票日期、關聯單據
- [ ] 格式產生 / API 呼叫 → 舊系統模組負責
- [ ] 作廢 / 折讓：本系統觸發、寫回狀態

### 6.7 員工餐
- [ ] 員工在 POS / 簡化介面登記取餐
- [ ] 價格：可設定員工價（可為 0）
- [ ] **不**開發票、**不**扣庫存現金流，但**仍扣庫存**（出庫 type=`sale`，客戶=員工）
- [ ] 月底產出扣款清單（匯出 CSV / Excel 給薪資系統）

### 6.8 報表
- [ ] 日報：本店 / 全集團當日銷售（分型態、分付款、毛利）
- [ ] 月報：月銷售 / 月退貨 / 月應收 / 月員工餐
- [ ] 客戶分析：Top / 滯購 / 異常
- [ ] 商品分析：Top / 滯銷 / 毛利
- [ ] 對帳單：某客戶 × 某月 全明細

---

## 7. 非功能需求
- [ ] **POS 即時結帳**：掃碼到入車 < 300ms；結帳點擊到發票列印 < 3s（含電子發票 API）
- [ ] **POS 離線容錯**：斷網 4 小時內仍可結帳（本地暫存，恢復後上拋；電子發票可延後開立）
- [ ] **併發**：同一 SKU 兩支 POS 同時結帳 → 由庫存模組 row lock 排隊
- [ ] **稽核**：每筆銷售 / 退貨 / 付款 / 作廢都有 operator + timestamp
- [ ] **多租戶**：所有表 `tenant_id`
- [ ] **日結不可撤回**：日結完成後當日交易鎖定，修改必須走作廢 + 沖正

---

## 8. 權限

| 權限 | 老闆 | 會計 | 業務 | 店長 | 店員 |
|---|:-:|:-:|:-:|:-:|:-:|
| B2B 開單 | ✅ | ❌ | ✅ | ✅ | ❌ |
| B2B 議價 | ✅ | ❌ | ✅（限度） | ✅（限度） | ❌ |
| POS 結帳 | ✅ | ❌ | ❌ | ✅ | ✅ |
| 整單折扣 | ✅ | ❌ | ✅ | ✅（需密碼） | ❌ |
| 退貨確認 | ✅ | ❌ | ✅ | ✅ | ❌（只能提出）|
| 日結 | ✅ | ❌ | ❌ | ✅ | ❌ |
| 發票作廢 | ✅ | ✅ | ❌ | ✅ | ❌ |
| 應收收款 | ✅ | ✅ | ❌ | ❌ | ❌ |
| 員工餐登記 | ✅ | ❌ | ✅ | ✅ | ✅ |
| 看跨店銷售 | ✅ | ✅ | ❌ | ❌ | ❌ |

---

## 9. 與其他模組整合

- [ ] **庫存模組** → 出貨 / 退貨 呼叫 `rpc_outbound` / `rpc_inbound`
- [ ] **條碼模組** → POS 掃碼查 SKU；發票條碼、退貨條碼
- [ ] **進貨模組** → 客戶退貨若要退給供應商，本模組產生退貨單 → 人員決定是否轉退供
- [ ] **主檔模組** → 客戶、SKU、員工
- [ ] **發票系統（舊）** → 呼叫既有 API 開票 / 作廢
- [ ] **薪資系統（外部）** → 匯出員工餐扣款 CSV

---

## 10. 驗收準則
- [ ] B2B：建單 → 出貨（部分 30）→ 庫存扣 30 + SO 狀態 `partially_shipped`
- [ ] B2B：再出貨 70 → 庫存扣 70 + SO 狀態 `shipped` → 開發票 → 狀態 `invoiced`
- [ ] POS：掃 5 品 → 付現 200 + 刷卡 300 + LinePay 100 → 成立 1 筆 sale、3 筆 payment、庫存扣 5 項
- [ ] POS：顧客持原發票退其中 1 品 → 成立退貨單、庫存入 1、作廢原發票或開折讓、原路退款
- [ ] 員工登記取餐 → 本月扣款清單正確列出
- [ ] 日結：當日卡別 / 現金彙總正確 → 差異為 0 → 鎖定當日
- [ ] 掛帳 B2B 銷售 → `receivables` 增加對應金額，月結對帳單可列出
- [ ] 店員無權限退貨 → 被擋下，顯示「請店長授權」

---

## 11. Open Questions

### 業務規則
- [x] **Q1 B2B 信用額度**：→ **不阻擋、但必留紀錄**。（2026-04-21）

  **業態事實**：B2B（企業 / 餐廳 / 大戶月結）與 C2C（團購預訂）並存。

  **實作**：
  - `customers.credit_limit` 欄位已存在
  - SO 建立時 RPC 計算：`current_outstanding_ar + new_so_total`
  - 若超過 `credit_limit`：
    - ✅ **下單通過**（不阻擋）
    - ✅ 寫一筆 `credit_limit_exceeded_events`（v0.2 新增表）
    - ✅ 透過通知模組推播財務 / 老闆（情報性、非阻擋）
  - **月報**：列出本月所有超額事件，供老闆 review、決定是否調整額度 / 列黑名單
  - 寬鬆哲學延續（跟店長權限一致），但涉及現金流，log 必填

  **v0.2 schema 變動**：
  ```sql
  CREATE TABLE credit_limit_exceeded_events (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    source_so_id BIGINT REFERENCES sales_orders(id),
    credit_limit NUMERIC(18,2),
    outstanding_before NUMERIC(18,2),
    new_amount NUMERIC(18,2),
    exceeded_by NUMERIC(18,2) GENERATED ALWAYS AS (outstanding_before + new_amount - credit_limit) STORED,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
- [x] **Q2 B2B 價格策略**：→ **C + B 組合：逐品覆寫為主、未覆寫用等級折扣率**。（2026-04-21）

  **實作（三層優先序）**：
  - `customers.tier` 欄位已有（TEXT 可自訂值，如 `vip` / `regular` / `new`）
  - `customer_tier_prices (tier, sku_id, price, effective_from/to)` 已有 schema（C）
  - B2B 客戶層級 `customer_tiers.benefits.discount_rate`（仿會員模組 tier 設計，v0.2 schema 新增）（B）

  **B2B 價格 lookup 優先序**（`rpc_b2b_price_lookup`）：
  1. **C 逐品覆寫**：查 `customer_tier_prices` where tier + sku + 有效期間 → 有就用
  2. **B 等級折扣**：`retail_price × customer_tiers.benefits.discount_rate` → 用這結果
  3. **Fallback**：商品模組 `rpc_current_price`（retail / store / member_tier / promo 取最低）

  **等級數量**：2~4 級起步（例 vip / regular / new），待 v0.2 具體確認。

  **v0.2 schema 變動**：
  ```sql
  CREATE TABLE customer_tiers (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    benefits JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- benefits example: {"discount_rate": 0.90, "credit_days_default": 30}
    created_by UUID, updated_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tenant_id, code)
  );
  ALTER TABLE customers
    ALTER COLUMN tier TYPE BIGINT USING NULL,
    ADD CONSTRAINT fk_customer_tier FOREIGN KEY (tier) REFERENCES customer_tiers(id);
  ```
  （現有 `customers.tier` TEXT 改為 FK 指向 `customer_tiers.id`；搬遷時建對應 tier 記錄）

  **UI**：客戶主檔頁 → Tab「tier 特殊價」→ 可匯入 CSV（15k SKU × N tier 量大時必要）
- [x] **Q3 員工餐 / 員工購物**：→ **員工價可設定、不分類別、結算方式可設定**。（2026-04-21）

  **業態事實**：
  - 員工需要折扣購物，價格系統可調整
  - 不區分「員工餐」vs「員工購物」→ 全部走同一條路徑
  - 月底結算方式彈性（扣薪 / 付現 / 記帳均可）

  **v0.2 schema 變動**：
  ```sql
  -- 員工價設定（兩層：預設折扣率 + SKU 覆寫）
  ALTER TABLE tenant_settings    -- 若無 tenant_settings 表先建
    ADD COLUMN employee_default_discount NUMERIC(5,4) DEFAULT 0.7000;  -- 預設 7 折

  CREATE TABLE employee_sku_prices (
    tenant_id UUID NOT NULL,
    sku_id BIGINT NOT NULL REFERENCES skus(id),
    price NUMERIC(18,4),               -- 固定價
    discount_rate NUMERIC(5,4),        -- OR 折扣率（二擇一，price 優先）
    effective_from TIMESTAMPTZ DEFAULT NOW(),
    effective_to TIMESTAMPTZ,
    created_by UUID, updated_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, sku_id, COALESCE(effective_from, DATE '1900-01-01'))
  );

  -- employee_meals 擴充結算欄位
  ALTER TABLE employee_meals
    ADD COLUMN settlement_method TEXT DEFAULT 'payroll_deduct'
      CHECK (settlement_method IN ('payroll_deduct','cash_paid','credit_on_account','waived')),
    ADD COLUMN settled_at TIMESTAMPTZ,
    ADD COLUMN settled_by UUID;
  ```

  **員工價 lookup 優先序**（RPC `rpc_employee_price`）：
  1. `employee_sku_prices` 有當前有效價 → 用
  2. `employee_sku_prices.discount_rate` 有 → `retail × discount_rate`
  3. Fallback：`retail × tenant_settings.employee_default_discount`

  **結算流程**：
  - 每筆員工取貨記錄 `employee_meals`，預設 `settlement_method='payroll_deduct'`、`settled_at=NULL`
  - 月底批次：老闆選結算方式 → UPDATE `settled_at / settled_by / settlement_method`
  - 扣薪走外部薪資系統（本模組不處理）
  - 付現：產生 `payments` 紀錄
  - 記帳：產生 `receivables` 紀錄
- [x] **Q4 POS 折扣**：→ **完全自由（A）+ 留稽核**。（2026-04-21）

  **做法**：
  - POS 打任何折扣無門檻限制（店員、店長、老闆皆同）
  - **必填** `discount_reason`（一句話原因即可）
  - 每筆 audit 可追：誰 / 何時 / 打多少折 / 原因
  - 月報：列出異常折扣（例：> 3 折或折扣金額 > X 元）供老闆 review

  **v0.2 schema**：
  ```sql
  ALTER TABLE pos_sales
    ADD COLUMN discount_reason TEXT;
  ALTER TABLE pos_sale_items
    ADD COLUMN discount_reason TEXT;
  -- 搭配既有 operator_id（結帳者）= created_by 已足夠稽核
  ```

  **延續寬鬆哲學**（跟 Q8 商品模組店長自由改價、Q1 信用額度不擋一致）：信任員工、事後稽核把關。
- [x] **Q5 退貨政策**：→ **14 天內、需原銷售單號、現金原路退、店員可處理**。（2026-04-21）

  | 項目 | 決定 |
  |---|---|
  | 可退期限 | **14 天**（從取貨日起算，可在 `tenant_settings.pos_return_window_days` 調整）|
  | 憑證要求 | 需**原銷售單號** / POS 小票號（店員可在系統查訂單調出）|
  | 退款方式 | **現金原路退**（v1 無儲值金 / 點數退款機制）|
  | 權限 | 店員可直接處理，每筆進 `sales_returns` 留稽核 |
  | 原因 | `sales_returns.reason` 必填 |

  **流程**：
  1. 顧客給銷售單號（或店員輸入手機查訂單）
  2. 店員選退貨品項 + 數量
  3. 系統呼叫 `rpc_confirm_sales_return` → `rpc_inbound` 補庫存
  4. 產生 `payments` 紀錄（direction=out）退現金
  5. 若 14 天已過 → 需店長 override（事後稽核）

  **v0.2 schema**：既有 schema 已足，僅 `tenant_settings.pos_return_window_days` 新增
- [x] **Q6 混合付款上限**：→ **v1 不適用（只收現金）、P1 再議**。（2026-04-21）

  **依附 Q3 POS 決定**：v1 POS 只收現金，不會有混合付款情境。

  **schema 現況**：`payments` 表已是**一對多**（一筆 `pos_sale` / `sales_order` 可對應多筆 `payments`），未來 P1 擴充信用卡 / LINE Pay / 儲值金 / 點數折抵時，schema 已經能支援多種付款組合，不用改。

  **P1 需要再決定**：
  - 一筆最多幾種付款方式（建議 ≤ 3 種避免 UI 複雜）
  - 付款順序（現金優先 / 點數優先 / 儲值金優先）
  - 找零 vs 多付（儲值金不能多付，現金找零）

### 整合 / 技術
- [x] **Q7 電子發票 API**：→ **v1 不適用**（v1 不開發票）、P1 再決定（綠界 ezPay / 藍新 / 財政部大平台）。（2026-04-21）

- [x] **Q8 信用卡刷卡機整合**：→ **v1 不適用**（v1 只收現金）、P1 再決定金流供應商 + EDC 型號 + 軟體整合 vs 獨立操作。（2026-04-21）

- [x] **Q9 LinePay / 街口 / 行動支付整合**：→ **v1 不適用**（v1 只收現金）、P1 再申請商店帳號與沙盒測試。（2026-04-21）

- [x] **Q10 POS 硬體**：→ **v1 不需電子秤**（無散裝秤重商品）。（2026-04-21）

  **v1 必要硬體**：
  - ✅ USB 掃描槍（鍵盤模擬即可，任一款可用）
  - ✅ 熱感小票機（ESC-POS 協定，USB 連線）
  - ⭕ 錢櫃（選配，RJ-11 接小票機觸發）
  - ❌ 客顯（可選、v1 先省）
  - ❌ 電子秤（無散裝商品不需）

  **採購清單**相關 issue：[#43 Pilot 期間硬體採購](https://github.com/www161616/new_erp/issues/43)
- [x] **Q11 日結差異容忍**：→ **雙規門檻：絕對值 ≥ 100 元 或 比例 ≥ 1%**。（2026-04-21）

  **做法**：
  - 每日收班店員輸入實際現金盤點數
  - 系統計算 `|system_cash - counted_cash|`
  - 觸發條件：`diff >= 100` **OR** `diff >= 0.01 × system_cash`
  - 任一條件滿足 → 推播老闆（通知模組）+ 在 dashboard 標紅
  - 店員必填原因（`daily_reconciliation.note`）

  **v0.2 schema**：
  ```sql
  CREATE TABLE daily_reconciliations (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL,
    location_id BIGINT NOT NULL REFERENCES locations(id),
    business_date DATE NOT NULL,
    system_cash NUMERIC(18,2) NOT NULL,
    counted_cash NUMERIC(18,2) NOT NULL,
    diff NUMERIC(18,2) GENERATED ALWAYS AS (counted_cash - system_cash) STORED,
    flagged BOOLEAN NOT NULL DEFAULT FALSE,   -- 超過門檻
    note TEXT,                                 -- 超過時必填
    closed_by UUID NOT NULL,
    closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID, updated_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tenant_id, location_id, business_date)
  );

  -- tenant_settings 新增
  -- reconcile_threshold_absolute NUMERIC(18,2) DEFAULT 100
  -- reconcile_threshold_ratio NUMERIC(5,4) DEFAULT 0.0100
  ```
- [x] **Q12 舊單資料遷移**：→ **直接切換、不搬**。（2026-04-21）

  **策略**：與庫存 Q8、採購 Q10 一致：
  - 舊未結 SO / 未收應收 → 繼續在舊系統追到結清
  - 新系統從 cut-over 後的新訂單開始
  - 舊系統唯讀保留 1~3 個月自然清空
  - 免掉雙系統對帳、資料清洗、漏單 / 重複風險

---

## 12. 下一步
- [ ] 回答 Q1~Q12 → v0.2 展開欄位 / API
- [ ] 先驗證最關鍵的兩條路徑：
  - [ ] POS 結帳 → 庫存 → 發票 → 列印 端到端
  - [ ] B2B 分批出貨 → 應收 → 收款沖帳

---

## 相關連結
- [[PRD-庫存模組]]
- [[PRD-採購模組]]
- [[PRD-條碼模組]]
- [[DB-銷售模組]]
- 舊系統參考：`SalesOrder.html`、`SalesReturn.html`、`SearchSales.html`、`DailyReport.html`、`MonthlyReport.html`、`CustomerList.html`、`Receivablereport.html`、`ReceivePayment.html`、`EmployeeMeal.html`
