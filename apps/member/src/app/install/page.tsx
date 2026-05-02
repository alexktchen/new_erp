"use client";

import { useEffect, useState } from "react";

type Env =
  | "loading"
  | "standalone"
  | "ios-safari"
  | "ios-line"
  | "ios-other"
  | "android-chrome"
  | "android-line"
  | "android-other"
  | "desktop";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function detectEnv(): Env {
  if (typeof window === "undefined") return "loading";
  const ua = navigator.userAgent;

  const isStandalone =
    (window.navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  if (isStandalone) return "standalone";

  const isLine = /Line\//i.test(ua);
  const isIos = /iPad|iPhone|iPod/.test(ua) && !(window as { MSStream?: unknown }).MSStream;
  const isAndroid = /Android/i.test(ua);

  if (isIos) {
    if (isLine) return "ios-line";
    // iOS Chrome / FF / Edge 都是 WebKit 包皮、但都沒 PWA install
    if (/CriOS|FxiOS|EdgiOS/i.test(ua)) return "ios-other";
    return "ios-safari";
  }

  if (isAndroid) {
    if (isLine) return "android-line";
    const isChrome = /Chrome\/|CrMo\//.test(ua) && !/EdgA|SamsungBrowser|FBAN|FBAV/i.test(ua);
    if (isChrome) return "android-chrome";
    return "android-other";
  }

  return "desktop";
}

export default function InstallPage() {
  const [env, setEnv] = useState<Env>("loading");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState("");

  useEffect(() => {
    setEnv(detectEnv());
    setPageUrl(window.location.origin + "/install");
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const installAndroid = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(pageUrl);
      setCopyMsg("✓ 網址已複製,請用 Safari 打開貼上");
    } catch {
      setCopyMsg("無法自動複製,請手動長按網址複製");
    }
    setTimeout(() => setCopyMsg(null), 4000);
  };

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col items-center px-5 pt-10 pb-12">
      {/* 品牌 header */}
      <div className="mb-6 flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/icons/ios/180.png"
          alt=""
          className="h-20 w-20 rounded-2xl shadow-md"
        />
        <h1 className="text-[26px] font-bold text-zinc-900">包子媽生鮮小舖</h1>
        <p className="text-[14px] text-zinc-500">把 App 加入你的手機,讓下單更方便</p>
      </div>

      {env === "loading" && (
        <p className="text-zinc-400">載入中…</p>
      )}

      {env === "standalone" && (
        <Card>
          <div className="text-center">
            <div className="text-5xl">✓</div>
            <h2 className="mt-3 text-[20px] font-bold text-zinc-900">已安裝</h2>
            <p className="mt-2 text-[15px] text-zinc-600">你已經在 PWA 裡了</p>
            <a
              href="/shop"
              className="mt-5 inline-block rounded-full bg-[#007aff] px-6 py-3 text-[16px] font-semibold text-white"
            >
              進入商店
            </a>
          </div>
        </Card>
      )}

      {env === "ios-safari" && <IosSafariSteps />}

      {(env === "ios-line" || env === "ios-other") && (
        <Card>
          <h2 className="text-[18px] font-bold text-zinc-900">請用 Safari 打開</h2>
          <p className="mt-2 text-[15px] text-zinc-600 leading-relaxed">
            iPhone 上只有 <b>Safari</b> 才能把 App 加入主畫面。
            目前的瀏覽器無法安裝。
          </p>
          <div className="mt-4 space-y-3">
            <Step n={1}>
              點下方按鈕複製網址
            </Step>
            <Step n={2}>
              {env === "ios-line"
                ? "點右上角 ⋯ → 「在 Safari 中開啟」(或長按貼到 Safari 網址列)"
                : "切到 Safari → 網址列長按 → 貼上"}
            </Step>
            <Step n={3}>
              到 Safari 後,按下方分享按鈕 → 加入主畫面
            </Step>
          </div>
          <button
            onClick={copyUrl}
            className="mt-5 w-full rounded-full bg-[#007aff] py-3 text-[16px] font-semibold text-white active:opacity-80"
          >
            複製網址
          </button>
          {copyMsg && (
            <p className="mt-2 text-center text-[13px] text-emerald-600">{copyMsg}</p>
          )}
          <p className="mt-3 break-all rounded-lg bg-zinc-100 p-3 text-center font-mono text-[12px] text-zinc-600">
            {pageUrl}
          </p>
        </Card>
      )}

      {env === "android-chrome" && (
        <Card>
          <h2 className="text-[18px] font-bold text-zinc-900">一鍵安裝</h2>
          <p className="mt-2 text-[15px] text-zinc-600">
            按下方按鈕、確認「安裝」即可加入主畫面。
          </p>
          {installPrompt ? (
            <button
              onClick={installAndroid}
              className="mt-5 w-full rounded-full bg-[#007aff] py-3.5 text-[18px] font-semibold text-white active:opacity-80"
            >
              安裝 App
            </button>
          ) : (
            <>
              <p className="mt-4 text-[14px] text-zinc-500">
                如果按鈕沒出現,請在 Chrome 右上角選單點「安裝應用程式」/「加到主畫面」。
              </p>
            </>
          )}
        </Card>
      )}

      {env === "android-line" && (
        <Card>
          <h2 className="text-[18px] font-bold text-zinc-900">請用 Chrome 打開</h2>
          <p className="mt-2 text-[15px] text-zinc-600">
            LINE 內建瀏覽器無法安裝 App。請改用 Chrome:
          </p>
          <div className="mt-4 space-y-3">
            <Step n={1}>點 LINE 視窗右上角 ⋯ → 「在其他應用程式中打開」→ 選 Chrome</Step>
            <Step n={2}>進入 Chrome 後,看到「安裝 App」按鈕點下去</Step>
          </div>
          <button
            onClick={copyUrl}
            className="mt-5 w-full rounded-full bg-[#7676801f] py-3 text-[15px] font-medium text-zinc-700"
          >
            或複製網址
          </button>
          {copyMsg && (
            <p className="mt-2 text-center text-[13px] text-emerald-600">{copyMsg}</p>
          )}
        </Card>
      )}

      {env === "android-other" && (
        <Card>
          <h2 className="text-[18px] font-bold text-zinc-900">手動安裝</h2>
          <p className="mt-2 text-[15px] text-zinc-600 leading-relaxed">
            在你的瀏覽器選單裡找「加入主畫面」或「安裝應用程式」。
          </p>
          <p className="mt-3 text-[13px] text-zinc-500">
            建議改用 <b>Chrome</b> 取得一鍵安裝。
          </p>
        </Card>
      )}

      {env === "desktop" && (
        <Card>
          <h2 className="text-[18px] font-bold text-zinc-900">用手機掃 QR 安裝</h2>
          <p className="mt-2 text-[15px] text-zinc-600">
            這個 App 是給手機用的。請用手機相機掃下方 QR 碼:
          </p>
          {pageUrl && (
            <div className="mt-4 flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(pageUrl)}&format=png&margin=10`}
                alt="QR code"
                width={320}
                height={320}
                className="rounded-2xl border border-zinc-200"
              />
            </div>
          )}
          <p className="mt-3 break-all rounded-lg bg-zinc-100 p-3 text-center font-mono text-[12px] text-zinc-600">
            {pageUrl}
          </p>
        </Card>
      )}
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full rounded-2xl bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
      {children}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#007aff] text-[14px] font-bold text-white">
        {n}
      </div>
      <div className="flex-1 pt-0.5 text-[15px] leading-relaxed text-zinc-700">{children}</div>
    </div>
  );
}

/** iOS Safari 加入主畫面圖示教學 */
function IosSafariSteps() {
  return (
    <Card>
      <h2 className="text-[18px] font-bold text-zinc-900">把 App 加到主畫面</h2>
      <p className="mt-2 text-[15px] text-zinc-600">
        三步驟,大約 10 秒鐘。
      </p>

      <div className="mt-5 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#007aff] text-[15px] font-bold text-white">
            1
          </div>
          <div className="flex-1">
            <div className="text-[16px] font-medium text-zinc-900">點下方分享按鈕</div>
            <div className="mt-2 inline-flex items-center gap-2 rounded-xl bg-zinc-100 px-3 py-2">
              {/* iOS Share icon SVG */}
              <svg viewBox="0 0 24 24" fill="none" stroke="#007aff" strokeWidth="2" className="h-6 w-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v13M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
              </svg>
              <span className="text-[14px] text-zinc-600">畫面下方那個</span>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#007aff] text-[15px] font-bold text-white">
            2
          </div>
          <div className="flex-1">
            <div className="text-[16px] font-medium text-zinc-900">向下捲動找「加入主畫面」</div>
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-zinc-100 px-3 py-2">
              <span className="text-[14px] text-zinc-600">加入主畫面</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="#3c3c43" strokeWidth="2" className="h-5 w-5">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <path strokeLinecap="round" d="M12 8v8M8 12h8" />
              </svg>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#007aff] text-[15px] font-bold text-white">
            3
          </div>
          <div className="flex-1">
            <div className="text-[16px] font-medium text-zinc-900">右上角點「新增」</div>
            <p className="mt-1 text-[13px] text-zinc-500">
              桌面就會多一顆「包子媽生鮮小舖」圖示,以後從那裡開就能下單。
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
