"use client";

import { useEffect, useState } from "react";
import { qrPath } from "@/lib/qr";

// Persona B5 — compact, collapsed-by-default proof affordance for a doc CARD /
// list row. A government-verified doc WITHOUT a photo has no file viewer, so
// the proof QR inside DocViewer was unreachable for it; this toggle puts the
// same VerifyQr (same /api/verify-link machinery) one tap away on the row
// itself. Renders nothing without a token (the server mints the link only for
// an authorised share/owner token + a proof-eligible government doc).
export function VerifyQrToggle({ documentId, token }: { documentId: string; token?: string }) {
  const [open, setOpen] = useState(false);
  if (!token) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        data-testid="proof-qr-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <path d="M14 14h3v3h-3zM20 14h1M14 20h1M20 20h1" />
        </svg>
        {open ? "Hide proof link" : "Share proof (QR)"}
      </button>
      {open && <VerifyQr documentId={documentId} token={token} />}
    </div>
  );
}

// Outward re-verification QR for a government-verified document (roadmap T1.4).
//
// Rendered on the SEAMAN and SHARED views (both pass the owner/share token). It asks
// the server to mint the public verify link for this document — authorised by the
// share token the viewer already holds — then draws the QR inline (pure lib/qr.ts, no
// dependency) plus a copyable link. Anyone who scans it opens the no-login /verify page
// and re-confirms the credential against the government registry. Renders nothing when
// there is no token or the document is not a verifiable credential.
export function VerifyQr({ documentId, token }: { documentId: string; token?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/verify-link?documentId=${encodeURIComponent(documentId)}&token=${encodeURIComponent(token)}`
        );
        const data = await res.json().catch(() => null);
        if (!cancelled && res.ok && data?.ok && data.path) {
          setUrl(`${window.location.origin}${data.path}`);
        }
      } catch {
        /* leave unset — the widget simply doesn't render */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, token]);

  if (loading || !url) return null;

  const { size, path } = qrPath(url, { ecc: "M" });
  const margin = 4;
  const dim = size + margin * 2;

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3" data-testid="verify-qr">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Share proof</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
        Anyone can scan this to re-confirm this certificate against the government registry — no
        login, no personal data.
      </p>
      <div className="mt-2 flex items-start gap-3">
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open public verification page">
          <svg
            viewBox={`0 0 ${dim} ${dim}`}
            width="112"
            height="112"
            shapeRendering="crispEdges"
            role="img"
            aria-label="Verification QR code"
            className="rounded bg-white ring-1 ring-slate-200"
          >
            <rect width={dim} height={dim} fill="#ffffff" />
            <path transform={`translate(${margin} ${margin})`} d={path} fill="#0f172a" />
          </svg>
        </a>
        <div className="min-w-0 flex-1">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block break-all text-[11px] font-medium text-brand-700 hover:underline"
            data-testid="verify-qr-link"
          >
            {url}
          </a>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
            className="mt-2 inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      </div>
    </div>
  );
}
