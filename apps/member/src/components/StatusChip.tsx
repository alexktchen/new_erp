type Tone = "ok" | "muted" | "warn" | "danger";

const styles: Record<Tone, string> = {
  ok: "bg-[#34c759]/15 text-[#1f8a3c]",
  muted: "bg-[#7676801f] text-[var(--ios-gray)]",
  warn: "bg-[#ff9500]/15 text-[#b06c00]",
  danger: "bg-[#ff3b30]/15 text-[#c4271d]",
};

/**
 * iOS-style status pill。系統色 + 半透明背景。
 */
export default function StatusChip({
  tone = "muted",
  label,
}: {
  tone?: Tone;
  label: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-[2px] text-[12px] font-medium leading-tight ${styles[tone]}`}
    >
      {label}
    </span>
  );
}
