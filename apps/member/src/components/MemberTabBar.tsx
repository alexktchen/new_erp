"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = {
  href: string;
  label: string;
  icon: (active: boolean) => React.ReactNode;
};

const stroke = (active: boolean) => (active ? "currentColor" : "currentColor");

const tabs: Tab[] = [
  {
    href: "/shop",
    label: "商品",
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke={stroke(active)} strokeWidth={active ? 0 : 1.8} className="h-7 w-7">
        <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5" strokeLinejoin="round" />
        <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5" strokeLinejoin="round" />
        <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5" strokeLinejoin="round" />
        <rect x="13" y="13" width="7.5" height="7.5" rx="1.5" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: "/orders",
    label: "訂單",
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke={stroke(active)} strokeWidth={active ? 0 : 1.8} className="h-7 w-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 7h14l-1.2 11.1A2 2 0 0 1 15.8 20H8.2a2 2 0 0 1-2-1.9L5 7Zm3 0V5a4 4 0 0 1 8 0v2" />
      </svg>
    ),
  },
  {
    href: "/settlements",
    label: "結單",
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke={stroke(active)} strokeWidth={active ? 0 : 1.8} className="h-7 w-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 3h9l3 3v15l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3Zm3 5h6m-6 4h6m-6 4h4" />
      </svg>
    ),
  },
  {
    href: "/me",
    label: "我",
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke={stroke(active)} strokeWidth={active ? 0 : 1.8} className="h-7 w-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0v1H5v-1Z" />
      </svg>
    ),
  },
];

export default function MemberTabBar() {
  const pathname = usePathname() ?? "";
  const [hide, setHide] = useState(false);

  // 從 LINE app 的 LIFF webview 進來,不顯示 tab bar(整個 PWA 導航體驗只屬於
  // 加入主畫面後的 standalone 模式)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ua = navigator.userAgent;
    const isLine = /Line\//i.test(ua);
    const isStandalone =
      (window.navigator as { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    setHide(isLine && !isStandalone);
  }, []);

  if (hide) return null;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--separator)] bg-white/85 backdrop-blur-xl"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 20px)" }}
    >
      <ul className="mx-auto flex max-w-md items-stretch">
        {tabs.map((t) => {
          const active = pathname.startsWith(t.href);
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                className={`flex flex-col items-center justify-center gap-1.5 px-1 pb-2.5 pt-3.5 text-[13px] font-medium transition-colors ${
                  active ? "text-[var(--brand-strong)]" : "text-[var(--ios-gray)]"
                }`}
              >
                {t.icon(active)}
                <span>{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
