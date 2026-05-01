/// <reference lib="webworker" />

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

declare global {
  interface ServiceWorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (string | PrecacheEntry)[] | undefined;
  }
}

const serwist = new Serwist({
  // @ts-ignore
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});

// @ts-ignore
self.addEventListener("push", (event: PushEvent) => {
  const data = event.data?.json();
  if (!data) return;

  const title = data.title || "新訊息";
  const options = {
    body: data.body || "您有一則新通知",
    icon: "/icons/icon-192x192.png",
    badge: "/icons/icon-192x192.png",
    data: data.url || "/",
  };

  // @ts-ignore
  event.waitUntil(self.registration.showNotification(title, options));
});

// @ts-ignore
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    // @ts-ignore
    self.clients.openWindow(event.notification.data)
  );
});

serwist.addEventListeners();
