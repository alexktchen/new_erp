# new_erp — 團購店 ERP

> 零售連鎖 ERP，**業態：團購店**。
> 規模：總倉 1 + 門市 100 + SKU 15,000。
> 狀態：**v0.1 設計階段**（PRD / DB schema 完成，實作尚未開始）。

---

## 目錄結構

```
.
├── README.md                 ← 本文件
└── docs/
    ├── PRD-商品模組.md
    ├── PRD-會員模組.md
    ├── PRD-庫存模組.md
    ├── PRD-採購模組.md
    ├── PRD-條碼模組.md       ← 已併入商品模組，保留為掃碼/列印補充
    ├── PRD-銷售模組.md
    ├── DB-商品模組.md
    ├── DB-會員模組.md
    ├── DB-庫存模組.md
    ├── DB-進貨模組.md
    ├── DB-銷售模組.md
    └── sql/
        ├── product_schema.sql
        ├── member_schema.sql
        ├── inventory_schema.sql
        ├── purchase_schema.sql
        └── sales_schema.sql
```

---

## 模組依賴總覽

```mermaid
graph TD
    subgraph 主檔層
      P[商品模組<br/>Product]
      M[會員模組<br/>Member]
    end

    subgraph 核心層
      I[庫存模組<br/>Inventory<br/>SSOT]
    end

    subgraph 業務層
      PO[採購模組<br/>Purchase]
      S[銷售模組<br/>Sales / POS]
    end

    subgraph 前端 / 整合
      L[LIFF 前端<br/>另案]
      N[通知模組<br/>待建立]
    end

    P -->|SKU / 條碼 / 價格| I
    P -->|SKU / 供應商關聯| PO
    P -->|SKU / 當前售價 / 促銷| S
    M -->|會員等級倍率 / 折扣| S
    M -->|會員識別 QR| S
    PO -->|收貨 rpc_inbound| I
    S -->|結帳 rpc_outbound / 退貨 rpc_inbound| I
    M --> N
    S --> N
    L --> M
    L --> N

    style P fill:#fff3cd
    style M fill:#fff3cd
    style I fill:#d1ecf1
    style PO fill:#d4edda
    style S fill:#d4edda
    style N fill:#f8d7da,stroke-dasharray: 5 5
    style L fill:#f8d7da,stroke-dasharray: 5 5
```

**分層原則**：
- 🟡 **主檔層**：其他模組的 FK 根基，不依賴他人
- 🔵 **核心層**：庫存為庫存數字的 Single Source of Truth
- 🟢 **業務層**：落單 / 結帳 / 收貨 — 所有庫存變動皆呼叫核心層 RPC
- 🔴 **待建立**：虛線框為 P0+ 外掛模組（已規劃未實作）

---

## 模組清單

| 模組 | 狀態 | PRD | DB | SQL |
|---|---|---|---|---|
| 商品（Product） | ✅ v0.1 draft | [PRD](docs/PRD-商品模組.md) | [DB](docs/DB-商品模組.md) | [SQL](docs/sql/product_schema.sql) |
| 會員（Member） | ✅ v0.1 draft | [PRD](docs/PRD-會員模組.md) | [DB](docs/DB-會員模組.md) | [SQL](docs/sql/member_schema.sql) |
| 庫存（Inventory） | ✅ v0.1 draft | [PRD](docs/PRD-庫存模組.md) | [DB](docs/DB-庫存模組.md) | [SQL](docs/sql/inventory_schema.sql) |
| 採購（Purchase） | ✅ v0.1 draft | [PRD](docs/PRD-採購模組.md) | [DB](docs/DB-進貨模組.md) | [SQL](docs/sql/purchase_schema.sql) |
| 銷售（Sales / POS） | ✅ v0.1 draft | [PRD](docs/PRD-銷售模組.md) | [DB](docs/DB-銷售模組.md) | [SQL](docs/sql/sales_schema.sql) |
| 條碼（Barcode） | ⚠️ 已併入商品 | [PRD](docs/PRD-條碼模組.md) | — | — |
| 通知（Notification） | 🚧 待建立 | — | — | — |
| 訂單 / 取貨 | 🚧 待確認是否獨立 | — | — | — |

---

## 各模組核心結構

### 🟡 商品模組（Product）

Product / SKU 兩層；條碼 / 多單位 / 定價 / 供應商關聯 / 促銷皆在本模組。

```mermaid
graph LR
    C[categories<br/>分類樹 3 層]
    B[brands<br/>品牌]
    P[products<br/>商品]
    S[skus<br/>SKU 最小單位]
    PK[sku_packs<br/>多單位換算<br/>1 箱=12 盒=144 個]
    BC[barcodes<br/>條碼<br/>sku × unit]
    PR[prices<br/>版本化價格<br/>append-only]
    PM[promotions<br/>促銷活動]
    SS[sku_suppliers<br/>供應商關聯]

    C --> P
    B --> P
    P --> S
    S --> PK
    S --> BC
    S --> PR
    S --> PM
    S --> SS
```

**關鍵決策**：
- 價格四層 scope（retail / store / member_tier / promo），取**最低不疊加**
- 門市店長可自由改本店售價，無需總部審核
- 會員價走 `member_tiers.benefits.discount_rate`，非 per-SKU 訂價

---

### 🟡 會員模組（Member）

手機號 + LIFF 動態 QR 雙主識別；點數 / 儲值金採 append-only ledger。

```mermaid
graph LR
    T[member_tiers<br/>銅/銀/金/鑽]
    M[members<br/>主檔 PII 加密]
    MC[member_cards<br/>實體 / 虛擬 QR]
    PL[points_ledger<br/>點數流水 append-only]
    PB[member_points_balance<br/>點數餘額]
    WL[wallet_ledger<br/>儲值金流水 append-only]
    WB[wallet_balances<br/>儲值金餘額]
    TG[member_tags<br/>行銷分群]

    T --> M
    M --> MC
    M --> PL
    M --> WL
    M --> TG
    PL -.trigger.-> PB
    WL -.trigger.-> WB
```

**關鍵決策**：
- 點數次年底到期、1 點 = 1 元、無單筆上限
- 儲值金不退現
- LINE OA + LIFF 前端（不做原生 APP）
- GDPR 刪除：軟刪除 + PII 清空，歷史流水保留 7 年

---

### 🔵 庫存模組（Inventory）— 所有庫存數字的 SSOT

`stock_movements` append-only 流水 + `stock_balances` 物化餘額，trigger 自動維護。

```mermaid
graph LR
    L[locations<br/>總倉 + 門市]
    SM[stock_movements<br/>異動流水<br/>append-only]
    SB[stock_balances<br/>結存<br/>物化視圖]
    TR[transfers<br/>調撥單]
    ST[stocktakes<br/>盤點單]
    RR[reorder_rules<br/>補貨規則]

    L --> SM
    L --> SB
    L --> TR
    L --> ST
    L --> RR
    SM -.trigger.-> SB
    TR --> SM
    ST --> SM
```

**關鍵決策**：
- 所有庫存變動**必經** RPC：`rpc_inbound` / `rpc_outbound`
- 成本法：移動平均（`stock_balances.avg_cost`）
- 併發安全：`SELECT FOR UPDATE` + 樂觀鎖 `version`
- 負庫存：DB 允許、應用層預設阻擋

---

### 🟢 採購模組（Purchase）

PR（請購）→ PO（採購單）→ GR（收貨）→ Return（退供）。

```mermaid
graph LR
    SUP[suppliers<br/>供應商]
    PR_[purchase_requests<br/>請購單 LINE 叫貨]
    PO[purchase_orders<br/>採購單]
    GR[goods_receipts<br/>收貨單]
    RET[purchase_returns<br/>退供單]
    INV[(stock_movements<br/>庫存入庫)]

    SUP --> PO
    PR_ -->|合併| PO
    PO --> GR
    GR -->|rpc_inbound| INV
    GR --> RET
    RET -->|rpc_outbound| INV
```

**關鍵決策**：
- LINE 文字叫貨 → PR → 合併成 PO
- 只有 GR 確認才動庫存
- `sku_aliases` 學習 LINE 解析

---

### 🟢 銷售模組（Sales / POS）

B2B（SO / Delivery）與 POS 同表分流；退貨 / 付款 / AR / 員工餐一體。

```mermaid
graph LR
    CUS[customers<br/>客戶]
    SO[sales_orders<br/>B2B 訂單]
    DLV[sales_deliveries<br/>出貨單]
    POS[pos_sales<br/>POS 結帳]
    RET[sales_returns<br/>退貨單]
    PAY[payments<br/>付款]
    INVO[invoices<br/>發票]
    AR[receivables<br/>應收帳款]
    EM[employee_meals<br/>員工餐]
    MV[(stock_movements)]

    CUS --> SO
    CUS --> POS
    CUS --> AR
    SO --> DLV
    DLV -->|rpc_outbound| MV
    POS -->|rpc_outbound| MV
    SO --> RET
    POS --> RET
    RET -->|rpc_inbound| MV
    SO --> PAY
    POS --> PAY
    PAY --> AR
    POS --> INVO
    EM -->|rpc_outbound| MV
```

**關鍵決策**：
- B2B vs POS 分表（流程差太大）
- 出貨才扣庫存（SO 確認不扣）
- 發票只存參照，實際開立走舊系統 API

---

## 關鍵設計慣例

### 稽核四欄位

所有可編輯主檔類表必帶：
```sql
created_by   UUID,
updated_by   UUID,
created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
```

Append-only 流水（`stock_movements`, `points_ledger`, `wallet_ledger`, `*_audit_log`）僅帶 `operator_id` + `created_at`。

### 多租戶

所有表帶 `tenant_id`；v1 只有 1 tenant，架構預留 RLS。

### 時區

一律 `TIMESTAMPTZ`，前端顯示轉台北時區。

### 精度

- 數量 `NUMERIC(18,3)`（散裝 / 重量支援 3 位）
- 金額 `NUMERIC(18,4)`（成本）/ `NUMERIC(18,2)`（總額）
- 折扣率 / 稅率 `NUMERIC(5,4)`（0.0500 = 5%）

---

## 技術棧（目標）

- **資料庫**：PostgreSQL 15+ / Supabase
- **前端**：
  - 內部 ERP：待定（可能 Next.js）
  - 會員 / 取貨：**LINE 官方帳號 + LIFF**（不做原生 APP）
- **通知**：LINE Messaging API（通知模組實作時整合）

---

## 下一步（v0.2）

- [ ] 展開每個模組的 API 合約與 UI wireframe
- [ ] 建立 **通知模組** PRD（跨會員 + 銷售 / 訂單）
- [ ] 確認**訂單 / 取貨流程**是獨立模組還是融入銷售模組
- [ ] Spike：POS 掃碼 → 扣庫存 → 發票 端到端延遲
- [ ] Spike：LIFF 動態 QR HMAC 產生 / 驗證 + APP 端刷新
- [ ] Spike：併發扣儲值金 / 扣點數（100 QPS 同一會員）
- [ ] 資料遷移工具：爬蟲 + CSV loader

---

## 相關文件

- 業態與決策記憶：`.claude/...`（Claude 助手內部記錄）
- PRD Open Questions 進度：商品 13/13 ✅、會員 16/16 ✅
