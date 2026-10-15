"use client";

// Shared registry-info + assisted/manual agent-action components (plan §5.3).
//
// RegistryInfo        — authority name, pinned portal link, contact email and
//                       notes (incl. the fake-domain warnings) for a country
//                       entry. Reused by VerifyBox, ReviewPanel and DocViewer.
// RegistryPrefillFields — the copy-ready prefill rows (moved verbatim from
//                       VerifyBox's AssistFields so both the anonymous paste box
//                       and the agent-side portal check share ONE implementation).
// prefillFromDoc      — the §5.3 prefill fallback chain for a STORED document:
//                       stored registryInputs → doc code → profile
//                       (verifiedName → declared name / birthDate) → prompt.
// RegistryAgentActions — the agent-side actions on a stored doc:
//                       assisted countries: "Check on official registry" (opens
//                       the pinned portal) + prefill copies + "Confirm — matched
//                       on registry" (server sets checkedVia:"registry-portal",
//                       agent-only). Manual countries: request / mark-confirmed /
//                       close-unavailable workflow (§4.4), agent-only.

import { useState } from "react";
import type { Doc, Seafarer } from "@/lib/db";
import { useT } from "@/components/LanguageProvider";
import { countryEntry } from "@/lib/registry/countries";
import {
  nameFieldSemantics,
  prefillFromDoc,
  profileNameFill,
  structuredProfileName,
  type ProfileNameParts,
} from "@/lib/registry/prefill";
import type { CountryEntry } from "@/lib/registry/types";

// Re-export for existing importers; the implementation (incl. the B4 URL-slug
// guard) lives in lib/registry/prefill.ts so it is unit-testable.
export { prefillFromDoc } from "@/lib/registry/prefill";

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ---- RegistryInfo --------------------------------------------------------

export function RegistryInfo({
  country,
  showPortal = true,
  className = "",
}: {
  country: CountryEntry;
  /** Hide the small portal link when the surrounding panel has its own CTA. */
  showPortal?: boolean;
  className?: string;
}) {
  // Persona F10c — ONLY the user-facing `userNotes` (fake-domain warnings,
  // coverage caveats) ever renders here. The `notes` field is wire/dev
  // metadata ("Django POST + CSRF + hCaptcha") and never reaches the UI.
  return (
    <div data-testid="registry-info" className={className}>
      <p
        data-testid="registry-country"
        className="text-xs font-semibold uppercase tracking-wide text-slate-500"
      >
        {country.countryName} — {country.authority}
      </p>
      {showPortal && (
        <a
          data-testid="registry-portal-link"
          href={country.portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-xs font-medium text-brand-600 underline hover:text-brand-800"
        >
          Official registry portal ↗
        </a>
      )}
      {country.contactEmail && (
        <p className="mt-1 text-xs text-slate-500">
          Contact:{" "}
          <a className="underline" href={`mailto:${country.contactEmail}`}>
            {country.contactEmail}
          </a>
        </p>
      )}
      {country.userNotes && (
        <p className="mt-1 text-xs text-slate-500" data-testid="registry-user-note">
          {country.userNotes}
        </p>
      )}
    </div>
  );
}

// ---- RegistryPrefillFields (moved from VerifyBox's AssistFields) ---------

// Copy-ready prefill rows for an assisted country. Values the caller could not
// prefill render as editable inputs ("Type to copy across") — HR's two-field
// name split and GR's father_name arrive as separate prompt fields straight
// from countries.ts. Sensitive fields are never prefilled (pass-through only).
export function RegistryPrefillFields({
  country,
  prefill,
  profileName,
}: {
  country: CountryEntry;
  prefill: Record<string, string>;
  /**
   * F10b + vr2 item 2 — the profile's name offered as a per-field "Use profile
   * name" helper, RESPECTING field semantics: a surname field receives the
   * profile's LAST name, a first-name field the FIRST name, a whole-name field
   * the full name. Structured first/last exist only where a registry holder
   * snapshot provides them (ProfileNameParts); a bare fullName string is NEVER
   * auto-split — first/last-specific fields then stay empty + typed. The USER
   * still clicks per field.
   */
  profileName?: ProfileNameParts;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...prefill }));
  const [copied, setCopied] = useState<string | null>(null);

  function copy(key: string) {
    const v = values[key] ?? "";
    if (!v) return;
    void navigator.clipboard.writeText(v).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }

  // F10a — one tap copies EVERY filled field as "Label: value" lines, so the
  // agent doesn't round-trip the clipboard once per field.
  function copyAll() {
    const text = country.inputs
      .map((f) => ({ f, v: (values[f.key] ?? "").trim() }))
      .filter(({ v }) => v)
      .map(({ f, v }) => `${f.label}: ${v}`)
      .join("\n");
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied("__all__");
      setTimeout(() => setCopied((c) => (c === "__all__" ? null : c)), 1500);
    });
  }

  // vr2 item 2 — per-field fill value respecting the field's name semantics
  // (surname ← LAST name, first-name ← FIRST name, whole-name ← full name).
  // Null = no safe value exists for that field (never a wrong split) → the
  // button is not offered and the field stays empty + typed.
  const nameFillFor = (key: string): string | null =>
    profileName ? profileNameFill(nameFieldSemantics(country, key), profileName) : null;

  return (
    <div className="mt-3 space-y-2">
      {country.inputs.map((f) => {
        const nameFill = !f.sensitive && f.source !== "paste" ? nameFillFor(f.key) : null;
        return (
        <div key={f.key} className="flex min-w-0 items-center gap-2">
          <label className="w-40 flex-shrink-0 text-xs font-medium text-slate-500">
            {f.label}
          </label>
          {/* w-0 + flex-1: the input's INTRINSIC width (size=20 default) must
              never leak into the ancestor grid's min-content — it blew the
              landing hero 109px past a 390px viewport (mobile overflow). */}
          <input
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            placeholder={f.source === "paste" ? "" : "Type to copy across"}
            className="w-0 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500"
            spellCheck={false}
          />
          {nameFill && (
            <button
              type="button"
              data-testid={`assist-from-profile-${f.key}`}
              title={`Fill with the profile name: ${nameFill}`}
              onClick={() => setValues((v) => ({ ...v, [f.key]: nameFill }))}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
            >
              Use profile name
            </button>
          )}
          <button
            type="button"
            data-testid={`assist-copy-${f.key}`}
            onClick={() => copy(f.key)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            {copied === f.key ? "Copied" : "Copy"}
          </button>
        </div>
        );
      })}
      <div>
        <button
          type="button"
          data-testid="assist-copy-all"
          onClick={copyAll}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          {copied === "__all__" ? "Copied all" : "Copy all fields"}
        </button>
      </div>
    </div>
  );
}

// ---- RegistryEmbeddedPortal (in-app iframe for embeddable countries) -----

// The official portal shown in an in-page iframe — offered ONLY where
// countries.ts says `embeddable:true` (Latvia; live header probe 2026-07-21:
// no X-Frame-Options, no CSP, no framebusting, reCAPTCHA Enterprise v2 works
// in an iframe). This is a convenience VIEW of the OFFICIAL portal: no
// proxying, no header stripping, nothing injected into the frame — the human
// user copies the prefill values across and solves the CAPTCHA themselves.
// Cross-origin JS prefill is impossible by design; the only nudge is the
// untested, non-sensitive ?certificateNumber= GET parameter (cert number
// ONLY — never names, never sensitive fields). If the portal ignores it,
// harmless. The src base is ALWAYS the pinned countries.ts portalUrl, never
// user-supplied. Cross-origin onload failure detection is unreliable, so a
// visible fallback line + portal link always accompanies the frame.
export function RegistryEmbeddedPortal({
  country,
  prefill,
  defaultOpen = false,
}: {
  country: CountryEntry;
  /** The assist prefill record — only the non-sensitive certNumber is used. */
  prefill?: Record<string, string>;
  /**
   * /verify card entry path: the box opens immediately (no second click) and
   * no prefill is passed — the user types into the official form directly.
   */
  defaultOpen?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(defaultOpen);
  if (!country.embeddable) return null;

  const cert = (prefill?.certNumber ?? "").trim();
  const src = cert
    ? `${country.portalUrl}${country.portalUrl.includes("?") ? "&" : "?"}certificateNumber=${encodeURIComponent(cert)}`
    : country.portalUrl;
  let host = country.portalUrl;
  try {
    host = new URL(country.portalUrl).hostname;
  } catch {
    /* keep the raw URL as the label */
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        data-testid="lv-iframe-toggle"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
      >
        {open ? t("emb.hide") : t("emb.open")}
      </button>
      {open && (
        <div className="mt-2 w-full max-w-full">
          {/* sandbox: allow-scripts + allow-same-origin + allow-forms are the
              minimum for the portal's own reCAPTCHA + AJAX submit to work.
              No allow-top-navigation / popups — the frame stays a frame. */}
          <iframe
            data-testid="lv-iframe"
            src={src}
            title={country.authority}
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            className="h-[600px] min-h-[600px] w-full max-w-full rounded-xl border border-slate-200 bg-white"
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            {t("emb.caption", { authority: country.authority, host })}
          </p>
          <p
            data-testid="lv-iframe-fallback"
            className="mt-1 text-xs text-slate-500"
          >
            {t("emb.fallback")}{" "}
            <a
              href={country.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-brand-600 underline hover:text-brand-800"
            >
              {t("emb.fallbackLink")}
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

// ---- prefillFromDoc (§5.3 fallback chain) --------------------------------

// (moved) codeish + prefillFromDoc live in lib/registry/prefill.ts — see the
// re-export at the top of this file.

// ---- RegistryAgentActions (agent/reviewer surfaces only) -----------------

export function RegistryAgentActions({
  doc,
  seafarer,
  reviewerName = "",
  onUpdate,
  allDocs,
}: {
  doc: Doc;
  seafarer?: Seafarer | null;
  /** Recorded on the audit trail (checkedBy / requestedBy / confirmedBy). */
  reviewerName?: string;
  onUpdate?: (d: Doc) => void;
  /**
   * All of this seafarer's docs (when the surface has them) — lets the profile
   * name helper find a STRUCTURED first/last split in a government holder
   * snapshot (vr2 item 2); falls back to [doc].
   */
  allDocs?: readonly Doc[];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // F8 — "Mark confirmed" requires a short evidence note (what the authority
  // replied / reference) stored in manualVerification.evidenceNote.
  const [evidenceNote, setEvidenceNote] = useState("");

  const entry = doc.registryCountry ? countryEntry(doc.registryCountry) : undefined;
  if (!entry) return null;
  // Machine-verified (government) and registry-confirmed (teal) docs need no
  // portal check or manual request — the registry already answered.
  if (doc.source === "government" || doc.source === "registry") return null;

  const assisted =
    entry.capability === "assisted" || entry.capability === "unverified-endpoint";
  const manual = entry.capability === "manual";
  if (!assisted && !manual) return null;

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id, ...body }),
      });
      const data = await res.json();
      if (data.ok) onUpdate?.(data.document as Doc);
      else setError(data.error ?? "Could not save.");
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const byField = reviewerName.trim() ? { checkedBy: reviewerName.trim() } : {};

  if (assisted) {
    const checked = doc.reviewerChecked && doc.checkedVia === "registry-portal";
    const assistPrefill = prefillFromDoc(entry, doc, seafarer, allDocs ?? [doc]);
    return (
      <div
        className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5"
        data-testid="registry-check-panel"
      >
        <RegistryInfo country={entry} showPortal={false} />
        {checked && (
          <p
            className="mt-1.5 text-xs font-semibold text-blue-700"
            data-testid="registry-checked-note"
          >
            Checked against registry{doc.checkedBy ? ` — ${doc.checkedBy}` : ""}
            {doc.checkedAt ? ` · ${fmtDate(doc.checkedAt)}` : ""}.
          </p>
        )}
        <a
          data-testid="check-on-registry"
          href={entry.portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpen(true)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
        >
          Check on official registry ↗
        </a>
        {open && (
          <>
            <RegistryPrefillFields
              country={entry}
              prefill={assistPrefill}
              profileName={structuredProfileName(seafarer, allDocs ?? [doc])}
            />
            {/* LV in-app iframe option (embeddable:true only) — the prefill
                copy fields above stay visible next to the framed form. */}
            <RegistryEmbeddedPortal country={entry} prefill={assistPrefill} />
            <button
              type="button"
              data-testid="confirm-registry-check"
              disabled={busy}
              onClick={() =>
                void patch({ reviewerChecked: true, checkedVia: "registry-portal", ...byField })
              }
              className="mt-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              Confirm — matched on registry
            </button>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              Records that you checked this certificate on the official portal. Shown as
              “Checked against registry” — a reviewer check, never government verification.
            </p>
          </>
        )}
        {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
      </div>
    );
  }

  // Manual-capability country: the §4.4 request / confirm / close workflow.
  const mv = doc.manualVerification;
  return (
    <div
      className="mt-3 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2.5"
      data-testid="registry-manual-panel"
    >
      <RegistryInfo country={entry} />
      {!mv && (
        <button
          type="button"
          data-testid="manual-request-btn"
          disabled={busy}
          onClick={() => void patch({ manualAction: "request", ...byField })}
          className="mt-2 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
        >
          Request manual verification
        </button>
      )}
      {mv?.status === "requested" && (
        <>
          <p
            className="mt-1.5 text-xs font-semibold text-violet-800"
            data-testid="manual-requested-note"
          >
            Verification requested — {mv.requestedBy}
            {mv.requestedAt ? ` · ${fmtDate(mv.requestedAt)}` : ""}.
          </p>
          {/* F8 — the confirmation must carry evidence: what the authority
              actually replied (email date, reference, who signed). Required —
              a bare click can no longer mint "confirmed". */}
          <input
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
            data-testid="manual-evidence-note"
            placeholder="Evidence — e.g. authority reply of 12 Jun, ref #1234"
            className="mt-2 w-full rounded-lg border border-violet-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-brand-500"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="manual-confirm-btn"
              disabled={busy || !evidenceNote.trim()}
              onClick={() =>
                void patch({ manualAction: "confirm", evidenceNote: evidenceNote.trim(), ...byField })
              }
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
            >
              Mark confirmed
            </button>
            <button
              type="button"
              data-testid="manual-close-btn"
              disabled={busy}
              onClick={() => void patch({ manualAction: "close" })}
              className="rounded-lg border border-violet-300 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-60"
            >
              Close — unavailable
            </button>
          </div>
        </>
      )}
      {mv?.status === "confirmed" && (
        <p
          className="mt-1.5 text-xs font-semibold text-blue-700"
          data-testid="manual-confirmed-note"
        >
          Confirmed by the authority
          {mv.confirmedBy ? ` — recorded by ${mv.confirmedBy}` : ""}
          {mv.confirmedAt ? ` · ${fmtDate(mv.confirmedAt)}` : ""}.
          {mv.evidenceNote ? ` Evidence: ${mv.evidenceNote}` : ""}
        </p>
      )}
      {mv?.status === "closed_unavailable" && (
        <>
          <p
            className="mt-1.5 text-xs font-semibold text-slate-600"
            data-testid="manual-closed-note"
          >
            Closed — verification unavailable from this authority.
          </p>
          <input
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
            data-testid="manual-evidence-note"
            placeholder="Evidence — e.g. authority reply of 12 Jun, ref #1234"
            className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-brand-500"
          />
          <button
            type="button"
            data-testid="manual-confirm-btn"
            disabled={busy || !evidenceNote.trim()}
            onClick={() =>
              void patch({ manualAction: "confirm", evidenceNote: evidenceNote.trim(), ...byField })
            }
            className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            Mark confirmed (late reply)
          </button>
        </>
      )}
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
