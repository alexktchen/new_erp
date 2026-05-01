"use client";

import { useEffect, useState } from "react";
import { callLiffApi } from "@/lib/supabase";

const VAPID_PUBLIC_KEY = "BPu5IptVgyuZFTpZEMkP3CB9C-EDkd16kcGIY3cAMnM2VeqeixebwRm4r-giCPX9UeewLLHQgsVabx04Uxss-xE";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// 等到 SW registration 真的有 active worker 才回傳。
// `getRegistration()` 在 installing/waiting 階段就會回 reg（active=null），
// pushManager.subscribe() 在這狀態下會丟「subscribing for push requires an active service worker」。
// 必須等 `.ready`（保證 active 已就緒），並用 timeout 防呆。
async function getActiveRegistration(timeoutMs: number): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) return existing;

  return await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Service Worker 啟用超時（>${Math.round(timeoutMs / 1000)}s），請重開 App`)),
        timeoutMs,
      ),
    ),
  ]);
}

export function PushNotificationManager({ jwt }: { jwt: string | null }) {
  const [isSupported, setIsSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [debugStatus, setDebugStatus] = useState<string>("");
  const [isPWA, setIsPWA] = useState(false);

  useEffect(() => {
    const standalone =
      (window.navigator as any).standalone ||
      window.matchMedia("(display-mode: standalone)").matches;
    setIsPWA(!!standalone);

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setDebugStatus("不支援 Web Push (iOS 需 16.4+)");
      return;
    }

    setIsSupported(true);
    setPermission(Notification.permission);

    // 顯示先前 SW register 失敗的錯誤（若有）
    const swErr = (() => {
      try { return localStorage.getItem("sw_register_error"); } catch { return null; }
    })();
    if (swErr) {
      setDebugStatus(`SW 註冊失敗: ${swErr}`);
      return;
    }

    setDebugStatus(standalone ? "等待 Service Worker 啟用..." : "請加入主畫面以啟用通知");

    let cancelled = false;
    (async () => {
      try {
        const registration = await getActiveRegistration(8000);
        if (cancelled) return;
        setDebugStatus(standalone ? "PWA 已就緒" : "請加入主畫面以啟用通知");

        const sub = await registration.pushManager.getSubscription();
        if (cancelled) return;
        setSubscription(sub);

        if (sub && jwt) {
          setDebugStatus("發現舊訂閱，同步中...");
          const subJson = sub.toJSON();
          try {
            await callLiffApi(jwt, {
              action: "upsert_push_subscription",
              endpoint: subJson.endpoint,
              p256dh: subJson.keys?.p256dh,
              auth: subJson.keys?.auth,
              user_agent: navigator.userAgent,
            });
            if (!cancelled) setDebugStatus("同步成功");
          } catch (err) {
            if (cancelled) return;
            const msg = err instanceof Error ? err.message : String(err);
            setDebugStatus(`同步失敗: ${msg}`);
          }
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setDebugStatus(`SW 等待失敗: ${msg}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jwt]);

  const rebind = () => {
    if (confirm("這將重新連動 LINE 並更新身分資料，確定嗎？")) {
      const storeId = localStorage.getItem("member_store_id") || "1";
      localStorage.clear(); // 清除舊快取
      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/line-oauth-start?store=${storeId}`;
      window.location.href = url;
    }
  };

  const subscribe = async () => {
    if (!jwt) {
      alert("請先登入");
      return;
    }

    if (!isPWA) {
      alert("iOS 必須「加入主畫面」後從桌面開啟 App 才能訂閱通知。");
      return;
    }
    
    try {
      setDebugStatus("請求通知權限...");
      const result = await Notification.requestPermission();
      setPermission(result);
      
      if (result !== "granted") {
        setDebugStatus(`權限被拒絕 (${result})`);
        alert("未獲得通知權限。請到手機「設定 > 通知」開啟權限。");
        return;
      }

      setDebugStatus("正在取得 Service Worker...");
      const registration = await getActiveRegistration(15000);

      if (!registration.pushManager) {
        setDebugStatus("PushManager 不可用");
        alert("此裝置不支援 PushManager (或需重開 App)");
        return;
      }
      
      setDebugStatus("正在向 Push Server 註冊...");
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      setSubscription(sub);
      const subJson = sub.toJSON();
      
      setDebugStatus("正在寫入資料庫...");
      await callLiffApi(jwt, {
        action: "upsert_push_subscription",
        endpoint: subJson.endpoint,
        p256dh: subJson.keys?.p256dh,
        auth: subJson.keys?.auth,
        user_agent: navigator.userAgent,
      });

      setDebugStatus("訂閱成功！");
      alert("通知訂閱成功！");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDebugStatus(`錯誤: ${msg}`);
      alert(`訂閱失敗：${msg}`);
      
      // 如果失敗，嘗試強制註冊一次
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }
    }
  };

  if (!isSupported) return null;

  return (
    <section>
      <div className="px-4 pb-1 pt-2 text-[12px] uppercase tracking-wide text-[var(--tertiary-label)]">
        通知設定
      </div>
      <div className="overflow-hidden rounded-2xl bg-[var(--card-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--separator)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] text-[var(--foreground)]">推播通知</div>
            <p className="mt-0.5 text-[13px] text-[var(--secondary-label)]">
              開啟以獲得訂閱商品提醒。
            </p>
          </div>
          <button
            onClick={rebind}
            className="flex-shrink-0 text-[13px] text-[var(--ios-blue)] active:opacity-60"
          >
            重新連動 LINE
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3">
          {subscription ? (
            <div className="flex items-center gap-1.5 text-[15px] font-medium text-[#1f8a3c]">
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              已啟用通知
            </div>
          ) : (
            <>
              <span className="text-[15px] text-[var(--secondary-label)]">尚未啟用</span>
              <button
                onClick={subscribe}
                disabled={!jwt}
                className="rounded-full bg-[var(--ios-blue)] px-4 py-1.5 text-[14px] font-medium text-white active:opacity-80 disabled:opacity-50"
              >
                開啟通知
              </button>
            </>
          )}
        </div>

        {debugStatus && (
          <div className="border-t border-[var(--separator)] bg-[#7676800a] px-4 py-2 font-mono text-[10px] text-[var(--secondary-label)]">
            {debugStatus} {isPWA ? " · PWA" : " · Browser"}
          </div>
        )}
      </div>
    </section>
  );
}
