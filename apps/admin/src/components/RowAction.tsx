"use client";

import type { ComponentProps } from "react";
import SpinButton from "@/components/SpinButton";

export type RowActionVariant =
  | "success"
  | "primary"
  | "indigo"
  | "warning"
  | "danger"
  | "neutral";

const VARIANT_CLS: Record<RowActionVariant, string> = {
  success:
    "border-emerald-400 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900",
  primary:
    "border-blue-400 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-300 dark:hover:bg-blue-900",
  indigo:
    "border-indigo-400 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900",
  warning:
    "border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900",
  danger:
    "border-red-400 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-700 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900",
  neutral:
    "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
};

const BASE =
  "rounded border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export function RowAction({
  variant = "neutral",
  className = "",
  ...props
}: ComponentProps<typeof SpinButton> & { variant?: RowActionVariant }) {
  return <SpinButton {...props} className={`${BASE} ${VARIANT_CLS[variant]} ${className}`} />;
}

export default RowAction;
