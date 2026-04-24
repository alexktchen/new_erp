// LIFF SDK loader — 用 CDN 載入官方 SDK，不用 npm 套件（免動 package-lock）
// 官方建議 CDN：https://static.line-scdn.net/liff/edge/2/sdk.js

type LiffStatic = {
  init: (cfg: { liffId: string }) => Promise<void>;
  isInClient: () => boolean;
  isLoggedIn: () => boolean;
  login: (cfg?: { redirectUri?: string }) => void;
  logout: () => void;
  getIDToken: () => string | null;
  getAccessToken: () => string | null;
  getProfile: () => Promise<{
    userId: string;
    displayName: string;
    pictureUrl?: string;
    statusMessage?: string;
  }>;
  getLanguage: () => string;
  getOS: () => "ios" | "android" | "web";
  getLineVersion: () => string | null;
  getDecodedIDToken: () => Record<string, unknown> | null;
  closeWindow: () => void;
};

declare global {
  interface Window {
    liff?: LiffStatic;
  }
}

const SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";
let loadPromise: Promise<LiffStatic> | null = null;

/** 載入 LIFF SDK（冪等）。回傳 window.liff */
export function loadLiff(): Promise<LiffStatic> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("LIFF can only be used in browser"));
  }
  if (window.liff) return Promise.resolve(window.liff);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.liff) resolve(window.liff);
        else reject(new Error("LIFF SDK loaded but window.liff missing"));
      });
      existing.addEventListener("error", () => reject(new Error("LIFF SDK load error")));
      return;
    }
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.charset = "utf-8";
    s.onload = () => {
      if (window.liff) resolve(window.liff);
      else reject(new Error("LIFF SDK loaded but window.liff missing"));
    };
    s.onerror = () => reject(new Error("LIFF SDK load error"));
    document.head.appendChild(s);
  });
  return loadPromise;
}
