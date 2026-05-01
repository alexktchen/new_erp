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

  useEffect(() => {
    if ("serviceWorker" in navigator && "PushManager" in window) {
      setIsSupported(true);
      setPermission(Notification.permission);
      
      navigator.serviceWorker.ready.then((registration) => {
        setDebugStatus("Service Worker 已就緒");
        registration.pushManager.getSubscription().then((sub) => {
          setSubscription(sub);
          if (sub && jwt) {
            setDebugStatus("偵測到舊訂閱，同步中...");
            const subJson = sub.toJSON();
            callLiffApi(jwt, {
              action: "upsert_push_subscription",
              endpoint: subJson.endpoint,
              p256dh: subJson.keys?.p256dh,
              auth: subJson.keys?.auth,
              user_agent: navigator.userAgent,
            })
            .then(() => setDebugStatus("舊訂閱同步成功"))
            .catch(err => {
              setDebugStatus(`同步失敗: ${err.message}`);
              alert(`同步舊訂閱失敗：${err.message}`);
            });
          }
        });
      });
    } else {
      setDebugStatus("瀏覽器不支援 Web Push");
    }
  }, [jwt]);

  const subscribe = async () => {
    if (!jwt) {
      alert("未登入，無法訂閱");
      return;
    }
    
    try {
      setDebugStatus("請求通知權限...");
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        alert("未獲得通知權限，無法開啟。");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      if (!registration.pushManager) {
        alert("瀏覽器支援 Service Worker 但不支援 PushManager (請檢查是否已加入主畫面)");
        return;
      }
      
      setDebugStatus("正在向 Push Server 註冊...");
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      setSubscription(sub);
      const subJson = sub.toJSON();
      
      if (!subJson.keys || !subJson.keys.p256dh || !subJson.keys.auth) {
        throw new Error("取得訂閱金鑰失敗 (keys missing)");
      }
      
      setDebugStatus("正在存入資料庫...");
      await callLiffApi(jwt, {
        action: "upsert_push_subscription",
        endpoint: subJson.endpoint,
        p256dh: subJson.keys?.p256dh,
        auth: subJson.keys?.auth,
        user_agent: navigator.userAgent,
      });

      setDebugStatus("訂閱成功並已存入資料庫");
      alert("通知訂閱成功！");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDebugStatus(`錯誤: ${msg}`);
      console.error("Failed to subscribe:", err);
      alert(`訂閱失敗：${msg}`);
    }
  };

  if (!isSupported) return null;

  return (
    <div className="p-4 bg-white shadow rounded-lg mb-4">
      <h3 className="text-lg font-medium text-gray-900">通知設定</h3>
      <p className="mt-1 text-sm text-gray-500">
        開啟通知以獲得訂閱商品的到貨提醒。
      </p>
      
      {debugStatus && (
        <div className="mt-2 p-2 bg-gray-100 text-[10px] font-mono text-gray-600 rounded">
          狀態: {debugStatus}
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
