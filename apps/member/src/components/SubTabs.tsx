"use client";

type Option = { value: string; label: string; count?: number };

/**
 * iOS-style segmented control。
 * 整體放在 #767680 ~12% alpha 的灰色 track 上，選中項是白色帶 shadow。
 */
export default function SubTabs({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
}) {
  return (
    <div className="px-4 pt-3">
      <div className="flex rounded-[10px] bg-[#7676801f] p-[2px]">
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              className={`flex-1 rounded-[8px] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                active
                  ? "bg-white text-[var(--foreground)] shadow-[0_3px_8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]"
                  : "bg-transparent text-[var(--ios-gray)]"
              }`}
            >
              {o.label}
              {o.count !== undefined && (
                <span className={`ml-1 ${active ? "text-[var(--ios-gray)]" : "text-[var(--ios-gray)]/70"}`}>
                  ({o.count})
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
