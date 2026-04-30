"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";

type CalendarCandidate = {
  id: number;
  product_name_hint: string | null;
  scheduled_open_at: string | null;
  owner_action: string;
  adopted_supplier_name: string | null;
  adopted_cost: number | null;
  adopted_sale_price: number | null;
};

const ACTION_LABEL: Record<string, string> = {
  none: "Pending",
  collected: "Saved",
  scheduled: "Scheduled",
  adopted: "Adopted",
  ignored: "Ignored",
};

const ACTION_COLOR: Record<string, string> = {
  none: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  collected: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  scheduled: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  adopted: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  ignored: "bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function CommunityCandidatesCalendarPage() {
  const [rows, setRows] = useState<CalendarCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, []);

  useEffect(() => {
    const todayStr = formatDate(days[0]);
    const endStr = formatDate(days[6]);
    getSupabase()
      .from("community_product_candidates")
      .select(
        "id, product_name_hint, scheduled_open_at, owner_action, adopted_supplier_name, adopted_cost, adopted_sale_price"
      )
      .not("scheduled_open_at", "is", null)
      .gte("scheduled_open_at", todayStr)
      .lte("scheduled_open_at", endStr)
      .order("scheduled_open_at")
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setRows((data as CalendarCandidate[]) ?? []);
      });
  }, [days]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarCandidate[]>();
    for (const d of days) map.set(formatDate(d), []);
    for (const r of rows ?? []) {
      if (r.scheduled_open_at) {
        const key = r.scheduled_open_at.slice(0, 10);
        map.get(key)?.push(r);
      }
    }
    return map;
  }, [days, rows]);

  const todayStr = formatDate(days[0]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Candidate Calendar</h1>
          <p className="mt-0.5 text-sm text-zinc-500">Next 7 days</p>
        </div>
        <Link
          href="/community-candidates"
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Candidates
        </Link>
      </header>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="text-sm text-zinc-400">Loading...</div>
      ) : (
        <div className="grid grid-cols-7 gap-2 overflow-x-auto">
          {days.map((d) => {
            const key = formatDate(d);
            const isToday = key === todayStr;
            const cards = byDate.get(key) ?? [];
            return (
              <div key={key} className="flex min-w-[120px] flex-col gap-2">
                <div
                  className={`rounded-md px-2 py-1.5 text-center text-xs font-semibold ${
                    isToday
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  }`}
                >
                  <div>{d.getMonth() + 1}/{d.getDate()}</div>
                  <div className="text-[10px] font-normal opacity-70">{WEEKDAYS[d.getDay()]}</div>
                </div>

                {cards.length === 0 ? (
                  <div className="rounded border border-dashed border-zinc-200 px-2 py-4 text-center text-[10px] text-zinc-400 dark:border-zinc-800">
                    No schedule
                  </div>
                ) : (
                  cards.map((r) => {
                    const any = r.adopted_supplier_name || r.adopted_cost !== null || r.adopted_sale_price !== null;
                    const complete = !!(r.adopted_supplier_name && r.adopted_cost !== null && r.adopted_sale_price !== null);
                    return (
                      <Link
                        key={r.id}
                        href="/community-candidates"
                        className="flex flex-col gap-1.5 rounded-md border border-zinc-200 bg-white p-2 text-xs transition hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
                      >
                        <div className="font-medium leading-snug">
                          {r.product_name_hint ?? "(No title)"}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <span
                            className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              ACTION_COLOR[r.owner_action] ?? ACTION_COLOR.none
                            }`}
                          >
                            {ACTION_LABEL[r.owner_action] ?? r.owner_action}
                          </span>
                          {complete && (
                            <span className="inline-flex rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-medium text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                              Ready
                            </span>
                          )}
                          {any && !complete && (
                            <span className="inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                              Incomplete
                            </span>
                          )}
                        </div>
                        {any && (
                          <div className="space-y-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                            {r.adopted_supplier_name && <div>Supplier: {r.adopted_supplier_name}</div>}
                            {r.adopted_cost !== null && <div>Cost: {r.adopted_cost}</div>}
                            {r.adopted_sale_price !== null && <div>Price: {r.adopted_sale_price}</div>}
                          </div>
                        )}
                      </Link>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="text-xs text-zinc-400">Total: {rows?.length ?? 0}</div>
    </div>
  );
}
