"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    try { localStorage.removeItem("sw_register_error"); } catch {}

    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        console.log("Service Worker registered with scope:", registration.scope);
      })
      .catch((error) => {
        console.error("Service Worker registration failed:", error);
        try {
          const msg = error instanceof Error ? error.message : String(error);
          localStorage.setItem("sw_register_error", msg);
        } catch {}
      });
  }, []);

  return null;
}
