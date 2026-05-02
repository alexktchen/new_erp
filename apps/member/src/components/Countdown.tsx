"use client";

import { useEffect, useState } from "react";

/**
 * 倒數元件。target 過了就顯示「已結束」。
 * compact = 用蝦皮 04:41:53 那種固定寬度膠囊;
 * 否則顯示 X天 HH:MM:SS。
 */
export default function Countdown({
  target,
  compact = false,
  className = "",
}: {
  target: string | Date;
  compact?: boolean;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const targetMs = typeof target === "string" ? new Date(target).getTime() : target.getTime();
  const diff = Math.max(0, targetMs - now);

  if (diff <= 0) {
    return <span className={`text-[var(--ios-gray)] ${className}`}>已結束</span>;
  }

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const secs = Math.floor((diff % 60000) / 1000);

  if (compact) {
    const pad = (n: number) => String(n).padStart(2, "0");
    if (days > 0) {
      return (
        <span className={`inline-flex items-center gap-1 font-mono tabular-nums ${className}`}>
          <Cell n={days} />天<Cell n={hours} />:<Cell n={mins} />:<Cell n={secs} />
        </span>
      );
    }
    return (
      <span className={`inline-flex items-center gap-0.5 font-mono tabular-nums ${className}`}>
        <Cell n={hours} />:<Cell n={mins} />:<Cell n={secs} />
      </span>
    );
  }

  if (days > 0) {
    return (
      <span className={className}>
        剩 {days} 天 {String(hours).padStart(2, "0")}:{String(mins).padStart(2, "0")}
      </span>
    );
  }
  return (
    <span className={`font-mono tabular-nums ${className}`}>
      {String(hours).padStart(2, "0")}:{String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
    </span>
  );
}

function Cell({ n }: { n: number }) {
  return (
    <span className="inline-block min-w-[2ch] rounded bg-black/80 px-1 py-[1px] text-center text-white">
      {String(n).padStart(2, "0")}
    </span>
  );
}
