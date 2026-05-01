"use client";

import { useEffect, useState } from "react";
import { consumeFragmentToSession, getSession } from "@/lib/session";
import { callLiffApi } from "@/lib/supabase";
import PageShell from "@/components/PageShell";

type MemberData = {
  member_id: number;
  member_no: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  gender: string | null;
  home_store_id: number | null;
  avatar_url: string | null;
  status: string;
};

export default function MePage() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MemberData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineName, setLineName] = useState<string | null>(null);
  const [linePicture, setLinePicture] = useState<string | null>(null);
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", birthday: "", email: "" });

  useEffect(() => {
    consumeFragmentToSession();
    const s = getSession();
    if (!s) {
      setError("尚未登入");
      setLoading(false);
      return;
    }
    setLineName(s.lineName);
    setLinePicture(s.linePicture);
    setLineUserId(s.lineUserId);
    setStoreId(s.storeId);

    (async () => {
      try {
        const data = await callLiffApi<MemberData>(s.token, { action: "get_me" });
        setMe(data);
        setForm({
          name: data.name ?? "",
          phone: data.phone ?? "",
          birthday: data.birthday ?? "",
          email: data.email ?? "",
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onSave() {
    const s = getSession();
    if (!s) return setError("session 失效");
    setSaving(true);
    setError(null);
    try {
      await callLiffApi(s.token, {
        action: "update_me",
        name: form.name,
        phone: form.phone,
        birthday: form.birthday,
        email: form.email,
      });
      const data = await callLiffApi<MemberData>(s.token, { action: "get_me" });
      setMe(data);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <PageShell title="會員中心">
        <p className="px-5 pt-4 text-[15px] text-[var(--tertiary-label)]">載入中…</p>
      </PageShell>
    );
  }

  if (!me) {
    return (
      <PageShell title="會員中心">
        <div className="px-5 pt-6 text-center">
          <p className="text-[15px] text-[var(--secondary-label)]">{error ?? "尚未登入，請回首頁。"}</p>
          <a href="/" className="mt-4 inline-block text-[15px] text-[var(--ios-blue)]">回首頁</a>
        </div>
      </PageShell>
    );
  }

  const avatarSrc = me.avatar_url ?? linePicture;
  const displayName = me.name ?? lineName ?? "(未提供)";

  const rightAction = !editing ? (
    <button
      onClick={() => setEditing(true)}
      className="text-[17px] text-[var(--ios-blue)] active:opacity-60"
    >
      編輯
    </button>
  ) : null;

  return (
    <PageShell title="會員中心" rightAction={rightAction}>
      <div className="space-y-4 px-4 pt-2 pb-6">
        {error && (
          <div className="rounded-2xl bg-[#ff3b30]/10 p-3 text-[14px] text-[#c4271d]">
            {error}
          </div>
        )}

        {/* LINE 綁定卡片 */}
        <section className="overflow-hidden rounded-2xl bg-[var(--card-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="flex items-center gap-3 px-4 py-4">
            {avatarSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarSrc} alt="" className="h-16 w-16 rounded-full object-cover" />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#7676801a] text-2xl text-[var(--secondary-label)]">
                {displayName[0]}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[19px] font-semibold text-[var(--foreground)]">{displayName}</div>
              <div className="font-mono text-[12px] text-[var(--secondary-label)]">{me.member_no}</div>
              <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#06C755]/15 px-2 py-[2px] text-[11px] font-medium text-[#067a37]">
                ✓ 已綁定 LINE
              </div>
            </div>
          </div>
        </section>

        {!editing ? (
          /* 檢視模式 — iOS settings-style */
          <section>
            <div className="px-4 pb-1 pt-2 text-[12px] uppercase tracking-wide text-[var(--tertiary-label)]">
              個人資料
            </div>
            <div className="overflow-hidden rounded-2xl bg-[var(--card-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              <InfoRow label="手機" value={me.phone ?? null} mono />
              <InfoRow label="生日" value={me.birthday ?? null} />
              <InfoRow label="Email" value={me.email ?? null} breakAll />
              <InfoRow label="門市" value={storeId ?? null} />
              {lineUserId && (
                <InfoRow label="LINE ID" value={lineUserId} mono breakAll small />
              )}
            </div>
          </section>
        ) : (
          /* 編輯模式 */
          <form
            onSubmit={(e) => { e.preventDefault(); onSave(); }}
            className="space-y-4"
          >
            <section>
              <div className="px-4 pb-1 pt-2 text-[12px] uppercase tracking-wide text-[var(--tertiary-label)]">
                個人資料
              </div>
              <div className="overflow-hidden rounded-2xl bg-[var(--card-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <FormField label="姓名" required>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full bg-transparent text-right text-[15px] text-[var(--foreground)] outline-none placeholder:text-[var(--tertiary-label)]"
                    placeholder="請輸入"
                    required
                  />
                </FormField>
                <FormField label="手機" hint="台灣 09xxxxxxxx">
                  <input
                    type="tel"
                    inputMode="numeric"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="0912345678"
                    className="w-full bg-transparent text-right font-mono text-[15px] text-[var(--foreground)] outline-none placeholder:text-[var(--tertiary-label)]"
                  />
                </FormField>
                <FormField label="生日">
                  <input
                    type="date"
                    value={form.birthday}
                    onChange={(e) => setForm({ ...form, birthday: e.target.value })}
                    className="w-full bg-transparent text-right text-[15px] text-[var(--foreground)] outline-none"
                  />
                </FormField>
                <FormField label="Email">
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="you@example.com"
                    className="w-full bg-transparent text-right text-[15px] text-[var(--foreground)] outline-none placeholder:text-[var(--tertiary-label)]"
                  />
                </FormField>
              </div>
            </section>

            <div className="flex gap-2 px-1 pt-1">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  setForm({
                    name: me.name ?? "",
                    phone: me.phone ?? "",
                    birthday: me.birthday ?? "",
                    email: me.email ?? "",
                  });
                }}
                disabled={saving}
                className="flex-1 rounded-xl bg-[#7676801f] py-3 text-[16px] font-medium text-[var(--foreground)] active:bg-[#76768033] disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 rounded-xl bg-[var(--ios-blue)] py-3 text-[16px] font-semibold text-white active:opacity-80 disabled:opacity-50"
              >
                {saving ? "儲存中…" : "儲存"}
              </button>
            </div>
          </form>
        )}

        <p className="px-4 pt-2 text-[12px] text-[var(--tertiary-label)]">
          會員卡 QR、點數、訂單等功能尚未上線（MVP-1 開發中）。
        </p>
      </div>
    </PageShell>
  );
}

function InfoRow({
  label,
  value,
  mono,
  breakAll,
  small,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  breakAll?: boolean;
  small?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--separator)] px-4 py-3 first:border-t-0">
      <span className="text-[15px] text-[var(--foreground)]">{label}</span>
      <span
        className={`max-w-[60%] text-right ${small ? "text-[13px]" : "text-[15px]"} ${
          mono ? "font-mono" : ""
        } ${breakAll ? "break-all" : ""} ${
          value ? "text-[var(--secondary-label)]" : "text-[var(--tertiary-label)]"
        }`}
      >
        {value ?? "未填"}
      </span>
    </div>
  );
}

function FormField({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-3 border-t border-[var(--separator)] px-4 py-2.5 first:border-t-0">
      <div className="w-[88px] flex-shrink-0">
        <div className="text-[15px] text-[var(--foreground)]">
          {label}
          {required && <span className="ml-0.5 text-[var(--ios-red)]">*</span>}
        </div>
        {hint && <div className="text-[11px] text-[var(--tertiary-label)]">{hint}</div>}
      </div>
      <div className="flex-1">{children}</div>
    </label>
  );
}
