#!/usr/bin/env python3
"""Close LIFF Q&A issue #87 + create completion + catalyzed issues."""
import json, sys, urllib.request
from pathlib import Path
try:
    sys.stdout.reconfigure(encoding='utf-8')
except AttributeError:
    pass

TOKEN = Path.home().joinpath('.github_pat').read_text(encoding='utf-8').strip()

def api(m, p, d=None):
    body = json.dumps(d).encode() if d else None
    req = urllib.request.Request(f'https://api.github.com{p}', method=m, data=body,
        headers={'Authorization': f'Bearer {TOKEN}', 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json', 'User-Agent': 'bot'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b'{}')

def gql(q, v=None):
    body = json.dumps({'query': q, 'variables': v or {}}).encode()
    req = urllib.request.Request('https://api.github.com/graphql', method='POST', data=body,
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

P = 'PVT_kwHOB2mPBc4BVRWm'
F = 'PVTSSF_lAHOB2mPBc4BVRWmzhQuSyo'
TODO = 'f75ad846'
DONE = '98236657'

def add_project(node_id, status):
    r = gql('mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}',
            {'p': P, 'c': node_id})
    item = r['data']['addProjectV2ItemById']['item']['id']
    gql('mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}',
        {'p': P, 'i': item, 'f': F, 'o': status})

# Close #87
api('PATCH', '/repos/www161616/new_erp/issues/87', {'state': 'closed', 'state_reason': 'completed'})
r = gql('query{repository(owner:"www161616",name:"new_erp"){issue(number:87){projectItems(first:5){nodes{id project{id}}}}}}')
for it in r['data']['repository']['issue']['projectItems']['nodes']:
    if it['project']['id'] == P:
        gql('mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}',
            {'p': P, 'i': it['id'], 'f': F, 'o': DONE})
print('#87 closed + Done')

# Completion
iss = api('POST', '/repos/www161616/new_erp/issues', {
    'title': '[\u2713 Done] LIFF 前端 Open Questions 回答完成（14/14）',
    'body': 'LIFF 前端 14 題 Open Questions 全部對齊完成（2026-04-21）。\n\n**關鍵決策**：\n- Q1 總部一次申請 LIFF、全店共用（?store=）\n- Q2 v1 不做 OTP / Q3 Supabase Auth cookie / Q4 full size\n- Q5 新會員最小欄位手機+姓氏+生日 / Q6 手機改需到門市\n- Q7 主畫面 3 筆訂單 / Q8 UI 保留 6 個月（底層 7 年）\n- Q9 tenant_settings.liff_url / Q10 Supabase Vault / Q11 locations.line_community_channel_id\n- Q12 LIFF 下單架構預留、P2+ 跟 APP 同步 / Q13 v1 中文 / Q14 APP+LIFF 雙軌',
    'labels': ['module:liff', 'type:decision', 'type:docs', 'priority:p1'],
    'milestone': 1,
})
api('PATCH', f'/repos/www161616/new_erp/issues/{iss["number"]}', {'state': 'closed', 'state_reason': 'completed'})
add_project(iss['node_id'], DONE)
print(f'#{iss["number"]} completion -> Done')

catalyzed = [
    {
        'title': '[schema/location] locations.line_community_channel_id + line_community_name (LIFF Q11)',
        'body': '為 LIFF 社群暱稱綁定、每店對應一主社群。\n```sql\nALTER TABLE locations\n  ADD COLUMN line_community_channel_id TEXT,\n  ADD COLUMN line_community_name TEXT;\n```',
        'labels': ['module:liff', 'module:order', 'type:schema', 'priority:p1'],
        'milestone': 2,
    },
    {
        'title': '[schema/tenant] tenant_settings 統一設定表（含 liff_url 等）',
        'body': '多模組共催生 tenant_settings 表統一管理閾值與預設值：\n- liff_url, liff_order_history_months\n- pos_return_window_days, pos_clerk_max_discount\n- employee_default_discount, points_base_rate, points_redeem_rate\n- reconcile_threshold_absolute/ratio\n- notification_resend_max, notification_resend_cooldown_minutes\n- pickup_days_by_storage JSONB\n等等。\n\n建議 v0.2 一次建好 tenant_settings 表（key-value 或 schema-defined 欄位），所有模組統一讀。',
        'labels': ['module:cross', 'type:schema', 'priority:p0'],
        'milestone': 2,
    },
    {
        'title': '[infra] Supabase Vault 設定 (LIFF Q10 + 會員 Q11 + 採購 PO 管道)',
        'body': '集中管理加密 secret：\n- LIFF HMAC secret (QR 簽章)\n- LINE OA Channel Access Token (per store)\n- 會員 PII 加密 key（P1 從 env var 升到 Vault）\n\n流程：\n1. Enable Supabase Vault extension\n2. 文件化 secret 新增/輪替 SOP\n3. Edge Function 讀取範例',
        'labels': ['module:cross', 'type:infra', 'priority:p0'],
        'milestone': 3,
    },
    {
        'title': '[infra] LIFF channel 申請 + LINE Dev 後台設定',
        'body': '總部端作業：\n1. LINE Developer Console 申請 LIFF channel\n2. 設定 size=full, endpoint URL 指向 new_erp_liff 部署\n3. 取 LIFF ID -> 寫入 tenant_settings.liff_url\n4. 文件化新 OA 掛接 LIFF 流程',
        'labels': ['module:liff', 'type:infra', 'priority:p1'],
        'milestone': 6,
    },
    {
        'title': '[spike] LIFF ID Token -> Edge Function -> Supabase JWT 驗證',
        'body': '驗證 LIFF 認證流程端到端：\n1. LIFF 取 liff.getIDToken()\n2. POST /functions/v1/liff-session { id_token, store_id }\n3. Edge Function 驗 LINE JWK\n4. 查 member_line_bindings -> 發 Supabase session\n5. RLS policy 正確限制 member_id + store_id\n\n目標：<2 秒端到端',
        'labels': ['module:liff', 'module:member', 'type:spike', 'priority:p1'],
        'milestone': 6,
    },
]
for c in catalyzed:
    i = api('POST', '/repos/www161616/new_erp/issues', c)
    add_project(i['node_id'], TODO)
    print(f'#{i["number"]} {c["title"][:60]}')
