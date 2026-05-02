"use client";

import { useEffect, useState } from "react";
import MemberTabBar from "./MemberTabBar";

/**
 * iOS 大標題樣式的頁面外殼。
 * - 頁面背景：systemGroupedBackground (#F2F2F7)
 * - 大標題：34px bold，sticky 凍頂，frosted blur
 * - 內容寬度上限 max-w-md，居中
 * - 底部留 tab bar 高度（含 safe-area-inset-bottom）
 */
export default function PageShell({
  title,
  rightAction,
  children,
}: {
  title?: string;
  rightAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [tabBarHidden, setTabBarHidden] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const isLine = /Line\//i.test(navigator.userAgent);
    const isStandalone =
      (window.navigator as { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    setTabBarHidden(isLine && !isStandalone);
  }, []);

  return (
    <div
      className="min-h-[100dvh] bg-[var(--background)]"
      style={{
        paddingBottom: tabBarHidden
          ? "env(safe-area-inset-bottom)"
          : "calc(92px + env(safe-area-inset-bottom))",
      }}
    >
      <main className="mx-auto w-full max-w-md">
        {title !== undefined && (
          <header
            className="sticky top-0 z-20 flex items-end justify-between gap-3 bg-[color-mix(in_srgb,var(--background)_85%,transparent)] px-5 pb-2 backdrop-blur-xl"
            style={{ paddingTop: "calc(env(safe-area-inset-top) + 14px)" }}
          >
            <h1 className="text-[34px] font-bold tracking-tight text-[var(--foreground)] leading-tight">
              {title}
            </h1>
            {rightAction && <div className="pb-1">{rightAction}</div>}
          </header>
        )}
        {children}
      </main>
      <MemberTabBar />
    </div>
  );
}
