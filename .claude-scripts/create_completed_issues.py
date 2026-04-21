#!/usr/bin/env python3
"""Create and immediately close issues for work completed in this design session."""
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except AttributeError:
    pass

TOKEN = Path.home().joinpath('.github_pat').read_text(encoding='utf-8').strip()
REPO = 'www161616/new_erp'
API = 'https://api.github.com'
MILESTONE_V01 = 1  # v0.1 設計完成


def api(method, path, data=None):
    url = f'{API}{path}'
    body = json.dumps(data).encode('utf-8') if data else None
    req = urllib.request.Request(
        url, method=method, data=body,
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'new-erp-issue-bot',
        }
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}


COMPLETED = [
    {
        'title': '[✓ Done] 商品模組 Open Questions 回答完成（13/13）',
        'labels': ['module:product', 'type:decision', 'type:docs', 'priority:p0'],
        'body': """本次 session 已與使用者對齊完畢商品模組 13 題 Open Questions，決策全部寫入 `docs/PRD-商品模組.md`。

**關鍵決策**：
- Q1 兩層結構（Product 1:N SKU）
- Q2 3 層分類
- Q3 5% 含稅、無免稅
- Q4 多單位通案
- Q5 混合箱條碼
- Q6 無舊條碼，全部重建 + 邊用邊建
- Q7 四層價格 scope
- Q8 店長自由改本店價
- Q9 取最低不疊加
- Q10 會員 B+C（點數倍率 + 等級折扣）
- Q11 供應商主檔歸屬採購
- Q12 多供應商 UI 可切換
- Q13 爬蟲+CSV+邊用邊建

**Commit**: `818ddbc`
""",
    },
    {
        'title': '[✓ Done] 會員模組 Open Questions 回答完成（16/16）',
        'labels': ['module:member', 'type:decision', 'type:docs', 'priority:p0'],
        'body': """會員模組 16 題 Open Questions 全部對齊完成，決策寫入 `docs/PRD-會員模組.md`。

**關鍵決策**：
- Q1 手機 + LIFF 動態 QR 雙主
- Q2 手機阻擋重辦
- Q3 QR TTL 60 秒
- Q4 點數次年底過期
- Q5 銅/銀/金/鑽 4 等級、倍率 1.0/1.2/1.5/2.0
- Q6 1 點 = 1 元、無上限
- Q7 儲值金不退現
- Q8 v1 不做加值回饋
- Q9-Q10 滾動 12 個月、降等 30 天緩衝
- Q11 v1 pgcrypto + env var、P1 Vault
- Q12 依角色遮罩
- Q13 軟刪除 + PII 清空
- Q14 7 年留存
- Q15 POS 離線只讀不寫
- Q16 v1 不跨 tenant

**Commit**: `818ddbc`
""",
    },
    {
        'title': '[✓ Done] 庫存模組 Open Questions 回答完成（8/8）',
        'labels': ['module:inventory', 'type:decision', 'type:docs', 'priority:p0'],
        'body': """庫存模組 8 題 Open Questions 全部對齊完成，決策寫入 `docs/PRD-庫存模組.md`。

**關鍵決策**：
- Q1 移動平均成本法
- Q2 追效期 + FEFO + 分類寬限天數（`categories.expiry_grace_days`）
- Q3 自建 POS + 即時扣庫存；v1 只收現金、先不開發票
- Q4 預設擋負庫存、店長權限解鎖
- Q5 門市完全開放互調、事後通知總部
- Q6 依盤點 type 預設凍結（full=凍結 / partial/cycle=不凍結）
- Q7 下單即 reserve 庫存（預購期 reserved > on_hand 常態）
- Q8 全盤後開帳 + 單店 pilot + 漸進推廣

**Commit**: `3abaef4`
""",
    },
    {
        'title': '[✓ Done] 採購模組 Open Questions 回答完成（10/10）',
        'labels': ['module:purchase', 'type:decision', 'type:docs', 'priority:p0'],
        'body': """採購模組 10 題 Open Questions 全部對齊完成，決策寫入 `docs/PRD-採購模組.md`。

**關鍵發現**：
- Q1 LINE 解析 **不在採購模組**（屬訂單模組 — 顧客下單而非店員叫貨）
- Q9 LINE 社群 (OpenChat) **無 API** — 不能自動發文 / 讀訊息
- 催生新模組：訂單取貨 / 通知 / 應付帳款

**其他決策**：
- Q2 5 人併發控制（version 鎖 + 單號 sequence）
- Q3 截圖保留分三階段（v1 人工 / P1 Claude vision / P2 OCR）
- Q4 PO 混合通道（LINE / Email / 電話）、半自動複製貼上
- Q5 沿用商品 Q12
- Q6 店長可直接緊急 PO、留稽核
- Q7 全付款類型支援 + PO 級覆寫
- Q8 A + B（永久改 + PO 臨時）、不做 C 季節表
- Q10 直接切換、不搬舊 PO

**Commit**: `7795735`
""",
    },
    {
        'title': '[✓ Done] 新建商品模組 PRD + DB + SQL schema',
        'labels': ['module:product', 'type:docs', 'type:schema', 'priority:p0'],
        'body': """新增完整的商品模組設計文件：

- `docs/PRD-商品模組.md`（797 行）
- `docs/DB-商品模組.md`（含 Mermaid ERD）
- `docs/sql/product_schema.sql`（完整 DDL + trigger + index + RLS + RPC）

**涵蓋**：分類樹、品牌、Product/SKU 兩層、多單位換算、條碼（併入）、價格版本、促銷活動、供應商關聯、稽核。

**Commit**: `818ddbc`
""",
    },
    {
        'title': '[✓ Done] 新建會員模組 PRD + DB + SQL schema',
        'labels': ['module:member', 'type:docs', 'type:schema', 'priority:p0'],
        'body': """新增完整的會員模組設計文件：

- `docs/PRD-會員模組.md`（890 行）
- `docs/DB-會員模組.md`（含 ERD）
- `docs/sql/member_schema.sql`（完整 DDL + trigger + RLS + RPC）

**涵蓋**：會員等級、PII 加密主檔、實體 / 虛擬卡、append-only points/wallet ledger、物化餘額、標籤、稽核、合併。

**Commit**: `818ddbc`
""",
    },
    {
        'title': '[✓ Done] 檔案結構整理到 docs/',
        'labels': ['module:cross', 'type:docs', 'priority:p0'],
        'body': """原本 PRD / DB / sql 散在根目錄，全部 `git mv` 到 `docs/`：

```
.
├── README.md
└── docs/
    ├── PRD-*.md (6 份)
    ├── DB-*.md (5 份)
    └── sql/
        └── *.sql (5 份)
```

統一 DB 文件內的 SQL 路徑引用為 `docs/sql/...`。

**Commit**: `818ddbc`
""",
    },
    {
        'title': '[✓ Done] 建立稽核四欄位慣例 + 44 張表補齊 + 40 個 trigger',
        'labels': ['module:cross', 'type:schema', 'priority:p0'],
        'body': """回應使用者要求：「任何操作到資料表需要幫我加上四個欄位 update time, create time, update by, create by」

**慣例分類**：
- 主檔 / 可編輯表：必帶 `created_by`, `updated_by`, `created_at`, `updated_at` + `touch_updated_at` trigger
- Append-only 流水（ledger / audit log）：僅 `operator_id` + `created_at`
- 物化餘額（由 trigger 維護）：僅 `version` + `updated_at`

**範圍**：5 個 SQL schema 檔案，共 **44 張表**補齊、**40 個 trigger** 新增。

**Commits**: `818ddbc` (product/member), `3abaef4` / 相關 (inventory/purchase/sales)

**記憶**：`feedback_audit_columns.md` 寫入專案記憶，未來任何新表自動套用此慣例。
""",
    },
    {
        'title': '[✓ Done] README 重寫：模組架構 Mermaid + 導覽',
        'labels': ['module:cross', 'type:docs', 'priority:p0'],
        'body': """原本 README 只有一行 `# new_erp`，完整改寫為：

- 專案概況 + 規模
- 目錄結構
- 模組依賴總覽 Mermaid graph（主檔 / 核心 / 業務 / 前端分層）
- 模組清單表（連結所有 PRD/DB/SQL）
- 各模組核心結構（Mermaid ERD）
- 設計慣例（稽核四欄位、多租戶、時區、精度）
- 技術棧
- v0.2 下一步

**Commit**: `818ddbc`
""",
    },
    {
        'title': '[✓ Done] ISSUES-DRAFT.md + GitHub 批次設定（26 labels / 6 milestones / 54 issues）',
        'labels': ['module:cross', 'type:docs', 'type:infra', 'priority:p0'],
        'body': """從所有 PRD / Open Questions 決策產出 `docs/ISSUES-DRAFT.md`（約 55 個 issue 原始清單）。

**批次建立（via `.claude-scripts/create_github_issues.py`）**：
- **26 個 Labels**：module:* (10), type:* (9), priority:* (3), status:* (4)
- **6 個 Milestones**：v0.1 / v0.2 / Phase 1 準備 / Phase 1 上線 / Phase 2 / Phase 3
- **54 個 Issues**：涵蓋 schema 變動、待建模組、Spike、Infrastructure、Migration、Decision、Docs

**View**: https://github.com/www161616/new_erp/issues

**Commit**: `ac68d9e`
""",
    },
    {
        'title': '[✓ Done] Wiki 初始化：9 模組總覽 + 11 PRD/DB + Home + Sidebar',
        'labels': ['module:cross', 'type:docs', 'priority:p0'],
        'body': """建立完整 GitHub Wiki（https://github.com/www161616/new_erp/wiki）：

**導覽**：
- `Home.md`（專案總覽 + 模組依賴圖 + 業態背景 + 核心決策）
- `_Sidebar.md`（階層導覽）

**模組總覽頁（5 現成 + 4 待建）**：
- 商品模組、會員模組、庫存模組、採購模組、銷售模組
- 訂單取貨模組、通知模組、應付帳款模組、LIFF 前端

**原文複製（11 份）**：
- PRD-商品 / 會員 / 庫存 / 採購 / 條碼 / 銷售 模組
- DB-商品 / 會員 / 庫存 / 進貨 / 銷售 模組

每個模組總覽頁含：定位 / 核心 Mermaid ERD / 關鍵決策摘要表 / v0.2 schema 變動 / 關聯 issues。
""",
    },
]


def main():
    created = 0
    closed = 0
    failed = 0

    print(f'Target repo: {REPO}')
    print(f'Creating {len(COMPLETED)} completion issues...')
    print()

    for i, item in enumerate(COMPLETED, 1):
        # Create
        data = {
            'title': item['title'],
            'body': item['body'],
            'labels': item['labels'],
            'milestone': MILESTONE_V01,
        }
        code, resp = api('POST', f'/repos/{REPO}/issues', data)
        if code != 201:
            failed += 1
            print(f'  ✗ CREATE FAIL ({code}) [{i}] {item["title"][:60]}')
            print(f'       {resp.get("message", "")}')
            continue
        issue_num = resp['number']
        created += 1
        print(f'  ✓ #{issue_num:3d} created: {item["title"][:60]}')

        # Close with completed reason
        time.sleep(0.1)
        code2, resp2 = api(
            'PATCH',
            f'/repos/{REPO}/issues/{issue_num}',
            {'state': 'closed', 'state_reason': 'completed'},
        )
        if code2 == 200:
            closed += 1
            print(f'      → closed as completed')
        else:
            print(f'      ✗ CLOSE FAIL ({code2}): {resp2.get("message", "")}')
        time.sleep(0.2)

    print()
    print(f'=== DONE: {created} created, {closed} closed, {failed} failed ===')


if __name__ == '__main__':
    main()
