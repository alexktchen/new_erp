# PWA & Web Push 設定說明

## 1. VAPID 金鑰
請將以下金鑰加入到你的環境變數中（建議加入到 Supabase 的 Edge Function Secrets 與 `.env` 檔案中）：

- **VAPID_PUBLIC_KEY**: `BPu5IptVgyuZFTpZEMkP3CB9C-EDkd16kcGIY3cAMnM2VeqeixebwRm4r-giCPX9UeewLLHQgsVabx04Uxss-xE`
- **VAPID_PRIVATE_KEY**: `PS3AG7sUuSq_ia9Ez3o8e-N5XDSQGqaSY45xpb_O96A`

### 設定指令 (Supabase CLI):
```bash
supabase secrets set VAPID_PUBLIC_KEY=BPu5IptVgyuZFTpZEMkP3CB9C-EDkd16kcGIY3cAMnM2VeqeixebwRm4r-giCPX9UeewLLHQgsVabx04Uxss-xE
supabase secrets set VAPID_PRIVATE_KEY=PS3AG7sUuSq_ia9Ez3o8e-N5XDSQGqaSY45xpb_O96A
```

## 2. 已完成項目
- [x] PWA Manifest (`apps/member/public/manifest.json`)
- [x] Service Worker (`apps/member/src/sw.ts`) 支援快取與 Push 監聽
- [x] Next.js PWA 配置 (`apps/member/next.config.ts`)
- [x] 訂閱資料表 (`push_subscriptions`) 與 RLS
- [x] 會員端 API 整合 (`liff-api`)
- [x] 會員中心訂閱 UI (`PushNotificationManager.tsx`)

## 3. 下一步
當你需要發送通知時，可以使用 `web-push` 套件。範例程式碼（Deno/Edge Function）：

```typescript
import webpush from "https://esm.sh/web-push";

webpush.setVapidDetails(
  "mailto:your-email@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!
);

// 從資料庫取得 subscription 後發送
await webpush.sendNotification(subscription, JSON.stringify({
  title: "商品到貨囉！",
  body: "您訂購的商品已到達門市。",
  url: "/orders"
}));
```
