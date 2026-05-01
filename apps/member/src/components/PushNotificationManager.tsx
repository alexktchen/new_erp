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

export function PushNotificationManager({ jwt }: { jwt: string | null }) {
  const [isSupported, setIsSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [debugStatus, setDebugStatus] = useState<string>("");
  const [isPWA, setIsPWA] = useState(false);

  useEffect(() => {
    // 偵測是否為加入主畫面的 PWA 模式
    const standalone = (window.navigator as any).standalone || window.matchMedia('(display-mode: standalone)').matches;
    setIsPWA(!!standalone);

    if ("serviceWorker" in navigator && "PushManager" in window) {
      setIsSupported(true);
      setPermission(Notification.permission);
      
      navigator.serviceWorker.ready.then((registration) => {
        setDebugStatus(standalone ? "PWA 已就緒" : "請加入主畫面以啟用通知");
        registration.pushManager.getSubscription().then((sub) => {
          setSubscription(sub);
          if (sub && jwt) {
            setDebugStatus("發現舊訂閱，同步中...");
            const subJson = sub.toJSON();
            callLiffApi(jwt, {
              action: "upsert_push_subscription",
              endpoint: subJson.endpoint,
              p256dh: subJson.keys?.p256dh,
              auth: subJson.keys?.auth,
              user_agent: navigator.userAgent,
            })
            .then(() => setDebugStatus("同步成功"))
            .catch(err => setDebugStatus(`同步失敗: ${err.message}`));
          }
        });
      });
    } else {
      setDebugStatus("不支援 Web Push (iOS 需 16.4+)");
    }
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
      
      // 使用更強健的方式取得 registration，避免死等 .ready
      const getRegistration = async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) return reg;
        return await navigator.serviceWorker.ready;
      };

      const registration = await Promise.race([
        getRegistration(),
        new Promise<ServiceWorkerRegistration>((_, reject) => 
          setTimeout(() => reject(new Error("Service Worker 回應超時，請重開 App")), 5000)
        )
      ]);

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
    <div className="p-4 bg-white shadow rounded-lg mb-4">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-lg font-medium text-gray-900">通知與身分設定</h3>
          <p className="mt-1 text-sm text-gray-500">
            開啟通知以獲得訂閱商品提醒。
          </p>
        </div>
        <button 
          onClick={rebind}
          className="text-xs text-indigo-600 hover:text-indigo-500 font-medium"
        >
          重新連動 LINE
        </button>
      </div>
      
      {debugStatus && (
        <div className="mt-2 p-2 bg-gray-100 text-[10px] font-mono text-gray-600 rounded">
          狀態: {debugStatus} {isPWA ? " (PWA)" : " (Browser)"}
        </div>
      )}

      <div className="mt-4">
        {subscription ? (
          <div className="flex items-center text-green-600 text-sm font-medium">
            <svg className="h-5 w-5 mr-1" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            已啟用通知
          </div>
        ) : (
          <button
            onClick={subscribe}
            disabled={!jwt}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            開啟通知
          </button>
        )}
      </div>
    </div>
  );
}
