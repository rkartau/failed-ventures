"use client";

// Outreach "Booking link" panel (Wave-4 §G). A small client island on the read-only
// outreach dashboard: shows the canonical public /book URL (resolved server-side via
// getPublicBaseUrl and passed in as `url`), a Copy-link button (navigator.clipboard),
// and a ready-to-paste snippet for outreach letters. Drop-in ready for the future
// email-send system. All copy is i18n (useT). Card styling mirrors admin/ui.tsx Card.

import { useState } from "react";
import { useT } from "@/components/LanguageProvider";

const BTN =
  "rounded border px-2 py-1 text-xs font-medium transition disabled:opacity-40 border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100";

export function BookingLinkPanel({ url }: { url: string }): JSX.Element {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const snippet = t("book.snippetText", { url });

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure ctx / permissions) — the link stays selectable */
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">{t("book.linkTitle")}</h2>
      <p className="mt-0.5 text-xs text-slate-500">{t("book.linkSubtitle")}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="select-all rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
          {url}
        </code>
        <button type="button" className={BTN} onClick={() => void copy(url)}>
          {copied ? t("book.linkCopied") : t("book.linkCopy")}
        </button>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium text-slate-500">{t("book.linkSnippet")}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="select-all rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
            {snippet}
          </code>
          <button type="button" className={BTN} onClick={() => void copy(snippet)}>
            {copied ? t("book.linkCopied") : t("book.linkCopy")}
          </button>
        </div>
      </div>
    </section>
  );
}
