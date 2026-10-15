"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { Doc, DocRequest, ProfileChangeRequest, Seafarer, SeaServiceEntry } from "@/lib/db";
import { docStatusForDoc, docBadgeForDoc } from "@/lib/cert";
import { DocRequestChecklist } from "@/components/DocRequestChecklist";
import { SeamanEmployment } from "@/components/SeamanEmployment";
import { SeamanAppraisals } from "@/components/SeamanAppraisals";
import { SeaServiceLedger } from "@/components/SeaServiceLedger";
import { ProfileSelfService } from "@/components/ProfileSelfService";
import { verifiedFirst } from "@/lib/archive";
import { StatusBadge } from "@/components/StatusBadge";
import { DocViewer } from "@/components/DocViewer";
import { VerifyQrToggle } from "@/components/VerifyQr";
import { DocImage } from "@/components/DocImage";
import { sampleThumbSrc } from "@/lib/sample-thumbs";
import { AccessReviews } from "@/components/AccessReviews";
import { SeamanFlows, type Flow, type PropagationRequest, type AppraisalDeleteRequest } from "@/components/SeamanFlows";
import { SeamanInbox, type InboxItem } from "@/components/SeamanInbox";
import { AccountSecurity } from "@/components/AccountSecurity";
import { CvMatrix } from "@/components/CvMatrix";
import { SeamanGoogleSignIn } from "@/components/SeamanGoogleSignIn";
import { SeamanPasswordAuth } from "@/components/SeamanPasswordAuth";
import { ProfilePhotoAdjuster } from "@/components/ProfilePhotoAdjuster";
import { signOut } from "next-auth/react";
import { useT } from "@/components/LanguageProvider";
import {
  computeReminderDates,
  docHasReminderExpiry,
  settingsFromSeafarer,
  type ReminderSettings,
  type ReminderUnit,
} from "@/lib/reminders-calendar";
import { AVAILABILITY_VALUES, AVAILABILITY_LABELS, type Availability } from "@/lib/availability";
import { getToken, setToken, clearToken } from "@/lib/seamanToken";
import { countryEntry } from "@/lib/registry/countries";
import { rescuedDocDisplay } from "@/lib/registry/prefill";
import type { CountryEntry, RegistryInputField } from "@/lib/registry/types";

// Code-split the mass uploader. It (and its image-compression + IndexedDB queue
// deps) is only ever needed AFTER a profile exists, never on the first-load
// create screen. Keeping it out of the initial route chunk is what lets the very
// first paint/hydrate come up on a worse-than-3G ship link instead of stalling
// while the whole uploader downloads. ssr:false — it is a browser-only widget.
const MassUpload = dynamic(
  () => import("@/components/MassUpload").then((m) => m.MassUpload),
  {
    ssr: false,
    loading: () => (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-400 shadow-sm">
        …
      </div>
    ),
  }
);

// ---- Public sample mode (plan D3, Phase 3) -----------------------------------
//
// The /sample/seafarer server page renders THIS component with `sample` +
// `initialData`: every relevant useState seeds from initialData in its
// INITIALIZER (never an effect), so the server-rendered HTML already contains the
// full dashboard; boot() early-returns; and EVERY network call in this file goes
// through `guardedFetch` below — in sample mode it resolves to an inert 403
// Response without touching the network, so no handler can fire a real request.
// A static test (tests/sample-pages.test.mjs) fails the build on any raw fetch
// call in this file outside the wrapper definition.

/** The server-assembled initial dataset for the public sample render. */
export type SeafarerPageInitialData = {
  seafarer: Seafarer;
  documents: Doc[];
  docRequests: DocRequest[];
  profileChanges: ProfileChangeRequest[];
  seaService: SeaServiceEntry[];
  flows: Flow[];
  propagationRequests: PropagationRequest[];
  appraisalDeleteRequests: AppraisalDeleteRequest[];
  inbox: { items: InboxItem[]; unreadCount: number };
};

// Module-level flag, refreshed on every SeafarerPage render (a client navigation
// from /sample/seafarer to /seafarer must re-arm real fetches, and vice versa).
let sampleRenderActive = false;

/** The ONE fetch chokepoint for this file. Inert `{ok:false}` 403 in sample mode. */
function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (sampleRenderActive) {
    return Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: "Sample data is read-only." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  return fetch(input, init);
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ISO instant -> yyyy-mm-dd for a native <input type="date">.
function dateInputValue(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function isImageFile(name?: string | null): boolean {
  return !!name && /\.(jpe?g|png|webp|gif|bmp)$/i.test(name);
}

// True when an expiry date is BEFORE today, compared in the USER'S LOCAL date (a
// doc expiring today is not yet expired). Docs with no expiry are never expired.
// Drives opt-in auto-archive of lapsed documents.
function isExpiredLocal(validUntil?: string | null): boolean {
  if (!validUntil) return false;
  const d = new Date(validUntil);
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return exp.getTime() < today.getTime();
}

// One document row. Government-verified rows are read-only. For photo/plain rows
// (which OCR often can't read) the seaman can fill in the certificate name and,
// crucially, the EXPIRY DATE — that's what makes expiry reminders possible for a
// paper certificate that carries no registry code.
function DocRow({
  doc,
  onUpdate,
  onDeleted,
  onUnarchive,
  shareToken,
}: {
  doc: Doc;
  onUpdate: (d: Doc) => void;
  /** Remove the row from the list after a successful delete. */
  onDeleted: (id: string) => void;
  /** Record a manual unarchive so auto-archive leaves that decision alone this session. */
  onUnarchive: (id: string) => void;
  /** Owner share token — authorises this seafarer's own file requests. */
  shareToken?: string;
}) {
  const { t } = useT();
  const editable = doc.source !== "government";
  const [editing, setEditing] = useState(false);
  const [titleInput, setTitleInput] = useState(doc.title);
  const [dateInput, setDateInput] = useState(dateInputValue(doc.validUntil));
  // Feature 3 — "This document has no expiry date" (perpetual). Initialised from
  // the stored flag; when checked, the date field is cleared + disabled and the
  // PATCH sends noExpiry:true (which the server treats as valid, no end date).
  const [noExpiryInput, setNoExpiryInput] = useState(!!doc.noExpiry);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Archive / unarchive this document (allowed on any doc, incl. government). Uses
  // the same owner-share-token authorisation as the edit/confirm flows above.
  async function toggleArchive(next: boolean) {
    setArchiving(true);
    setError(null);
    try {
      const res = await guardedFetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id, archived: next, token: shareToken }),
      });
      const data = await res.json();
      if (data.ok) {
        onUpdate(data.document as Doc);
        if (!next) onUnarchive(doc.id);
      } else {
        setError(data.error ?? "Could not update this document.");
      }
    } catch {
      setError("Could not update. Check your connection and try again.");
    } finally {
      setArchiving(false);
    }
  }

  // Permanently delete this document (record + file + comment thread). Seaman-scoped
  // via the owner share token — the server refuses a token for another seafarer.
  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await guardedFetch("/api/documents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id, token: shareToken }),
      });
      const data = await res.json();
      if (data.ok) {
        onDeleted(doc.id);
      } else {
        setError(data.error ?? "Could not delete this document.");
        setDeleting(false);
      }
    } catch {
      setError("Could not delete. Check your connection and try again.");
      setDeleting(false);
    }
  }

  // A photo whose title OCR could not read: the row must invite a one-tap rename
  // (a low-tech seaman can't tell "Certificate photo 4" is his fire-fighting cert)
  // rather than looking like a silent failure.
  const needsName =
    editable && (doc.docType === "Photo — not verified" || /^Certificate photo\b/i.test(doc.title));

  // An OCR-read expiry the seaman has NOT yet confirmed. Until confirmed we never
  // call the doc "Expired" — the date itself is only a machine guess.
  const expiryUnconfirmed = editable && !!doc.validUntil && !doc.expiryConfirmed;
  // The doc still needs the seaman to fill something in (name and/or confirm date).
  // Drives the single amber "Needs your details" pill and the paired task rows.
  const outstanding = needsName || expiryUnconfirmed;

  // Seed the "no expiry" checkbox from the stored flag each time the editor opens,
  // so it always reflects the current document (the open handlers seed title/date
  // imperatively; this keeps the checkbox in step without touching each of them).
  useEffect(() => {
    if (editing) setNoExpiryInput(!!doc.noExpiry);
  }, [editing, doc.noExpiry]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await guardedFetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: doc.id,
          title: titleInput.trim() || doc.title,
          // A perpetual doc clears any date; the server applies noExpiry AFTER the
          // date so validUntil is forced null regardless of what we send here.
          validUntil: noExpiryInput ? "" : dateInput || "",
          noExpiry: noExpiryInput,
          // Seaman self-service authorisation: the owner share token this device holds.
          token: shareToken,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        onUpdate(data.document as Doc);
        setEditing(false);
      } else {
        setError(data.error ?? "Could not save.");
      }
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  // One-TAP confirm of an OCR-read expiry: re-send the same date so the server
  // marks it human-confirmed. No date-editing — that hard step is exactly what an
  // older, low-tech seaman would otherwise leave undone, keeping the record wrong.
  async function confirmExpiry() {
    if (!doc.validUntil) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await guardedFetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: doc.id,
          validUntil: dateInputValue(doc.validUntil),
          // Seaman self-service authorisation: the owner share token this device holds.
          token: shareToken,
        }),
      });
      const data = await res.json();
      if (data.ok) onUpdate(data.document as Doc);
      else setError(data.error ?? "Could not save.");
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setConfirming(false);
    }
  }

  // Thumbnail (SEO plan v3 C9): curated SAMPLE docs use the committed 400px WebP
  // (public/samples/thumbs); everything else, and the viewer, keeps /api/files.
  const thumbUrl = isImageFile(doc.fileName)
    ? sampleThumbSrc(doc) ??
      `/api/files/${doc.id}${shareToken ? `?token=${encodeURIComponent(shareToken)}` : ""}`
    : null;

  return (
    <li
      data-testid="doc-item"
      className="rounded-xl border border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex items-start gap-3">
        {/* Thumbnail of the actual photo — the fastest way for the seaman to tell
            which certificate this row is, without reading any text. */}
        {thumbUrl ? (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            data-testid="doc-open-viewer"
            aria-label={`Open ${doc.title}`}
            className="h-14 w-14 flex-shrink-0 cursor-pointer overflow-hidden rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <DocImage
              src={thumbUrl}
              alt={doc.title}
              testId="doc-thumb"
              rotation={doc.rotation}
              width={400}
              height={181}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition hover:brightness-90"
            />
          </button>
        ) : null}
        {viewerOpen && (
          <DocViewer
            doc={doc}
            reviewerName=""
            fileToken={shareToken}
            onUpdate={(u) => {
              onUpdate(u);
            }}
            onClose={() => setViewerOpen(false)}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              {/* vr2 item 5 — rescued registry docs (LV/RO picker path) name
                  their country instead of a bare "Unverified document", and the
                  subtitle carries country · code · capability state. */}
              <p className="font-medium text-slate-800">
                {rescuedDocDisplay(doc)?.title ?? doc.title}
              </p>
              {/* ONE short subtitle. For an unverified photo the "not checked"
                  phrase appears here and nowhere else on the card. Outstanding
                  details live in the task rows below, not in this line. */}
              <p className="text-xs text-slate-400" data-testid="doc-subtitle">
                {(() => {
                  const rescued = rescuedDocDisplay(doc);
                  if (rescued) {
                    return (
                      <>
                        {[rescued.countryName, rescued.code, rescued.state]
                          .filter(Boolean)
                          .join(" · ")}
                        {doc.validUntil ? ` · valid until ${fmtDate(doc.validUntil)}` : ""}
                      </>
                    );
                  }
                  return !editable ? (
                    <>
                      {doc.docType}
                      {doc.validUntil ? ` · valid until ${fmtDate(doc.validUntil)}` : ""}
                      {doc.holderName ? ` · name: ${doc.holderName}` : ""}
                    </>
                  ) : outstanding ? (
                    t("row.subtitlePhoto")
                  ) : (
                    <>
                      {doc.source === "photo" ? t("row.uploadedPhoto") : doc.docType}
                      {doc.validUntil ? ` · valid until ${fmtDate(doc.validUntil)}` : ""}
                      {doc.holderName ? ` · name: ${doc.holderName}` : ""}
                    </>
                  );
                })()}
              </p>
            </div>
            {/* Status pill — ONE pill, honest. Government keeps its green
                "Verified". An unverified photo that still needs the seaman's input
                shows a single amber "Needs your details" (never "Expired" while the
                date is unconfirmed, never a repeated "not verified"). "Expired" is
                shown only once the seaman has CONFIRMED the date and it is past. */}
            {!editable ? (
              <StatusBadge status={docStatusForDoc(doc)} label="Verified" />
            ) : doc.source === "registry" || doc.manualVerification?.status === "requested" ? (
              // Registry-era honest states (plan §5.1), mirroring docBadge
              // semantics exactly: teal "Registry-confirmed — holder not
              // verified" for source:"registry" (expiry warning outranks the
              // teal inside docBadge), violet "Verification requested" for an
              // open manual request — never a neutral "On file".
              (() => {
                const rb = docBadgeForDoc({
                  verified: false,
                  validUntil: doc.validUntil,
                  expiryConfirmed: doc.expiryConfirmed,
                  source: doc.source,
                  manualRequested: doc.manualVerification?.status === "requested",
                  noExpiry: doc.noExpiry,
                });
                return <StatusBadge status={rb.status} label={rb.label} />;
              })()
            ) : outstanding ? (
              <StatusBadge status="unread" label={t("row.pillNeedsDetails")} />
            ) : doc.noExpiry ? (
              // Feature 3 — the seaman marked this document perpetual: a compliant
              // "No expiry" state, never an expiry warning or a neutral "On file".
              <StatusBadge status="none" label="No expiry" />
            ) : doc.expiryConfirmed && isExpiredLocal(doc.validUntil) ? (
              <StatusBadge status="expired" label={t("row.pillExpired")} />
            ) : docStatusForDoc(doc) === "expiring" ? (
              <StatusBadge status="expiring" label={t("row.pillExpiring")} />
            ) : (
              <StatusBadge status="unknown" label={t("row.pillOnFile")} />
            )}
          </div>

          {/* Persona B5 — the outward proof link/QR must be reachable from the
              ROW for a government-verified doc: a code-verified doc without a
              photo has no file viewer, so the DocViewer proof QR was a dead
              end for exactly those docs. */}
          {doc.source === "government" && (
            <VerifyQrToggle documentId={doc.id} token={shareToken} />
          )}

          {/* Outstanding tasks — render only the ones that apply, each a compact
              row: a short label with its OWN button(s) right beside it. No long
              paragraphs between buttons, so text and action always pair up. */}
          {editable && !editing && (
            <div className="mt-2 flex flex-col gap-2">
              {/* Name OCR couldn't read → one row: label + [Name this document]. */}
              {needsName && (
                <div className="flex flex-wrap items-center gap-2" data-testid="task-name">
                  <span className="text-xs font-medium text-slate-600">{t("row.taskName")}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setTitleInput(/^Certificate photo\b/i.test(doc.title) ? "" : doc.title);
                      setDateInput(dateInputValue(doc.validUntil));
                      setEditing(true);
                    }}
                    data-testid="doc-name"
                    className="inline-flex items-center justify-center rounded-md border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
                  >
                    {t("row.nameThisDoc")}
                  </button>
                </div>
              )}

              {/* Expiry read but unconfirmed → one row: "Expiry — <date> (not
                  confirmed)" + [Confirm] and [Change date]. */}
              {expiryUnconfirmed && (
                <div className="flex flex-wrap items-center gap-2" data-testid="task-expiry">
                  <span className="text-xs font-medium text-slate-600">
                    {t("row.taskExpiry", { date: fmtDate(doc.validUntil) })}
                  </span>
                  <button
                    type="button"
                    onClick={confirmExpiry}
                    disabled={confirming}
                    data-testid="doc-confirm-expiry"
                    className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {confirming ? t("row.confirming") : t("row.confirm")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTitleInput(doc.title);
                      setDateInput(dateInputValue(doc.validUntil));
                      setEditing(true);
                    }}
                    data-testid="doc-edit"
                    className="inline-flex items-center justify-center rounded-md border border-slate-200 px-3 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                  >
                    {t("row.changeDate")}
                  </button>
                </div>
              )}

              {/* Nothing outstanding: no task rows — just a single low-key control so
                  the seaman can still fix details or add an optional expiry reminder. */}
              {!needsName && !expiryUnconfirmed && (
                <div className="flex flex-wrap items-center gap-2">
                  {!doc.validUntil && (
                    // A doc the seaman MARKED perpetual reads a clean "No expiry";
                    // only a genuinely not-yet-set date keeps the "optional" nudge.
                    <span className="text-xs text-slate-400">
                      {doc.noExpiry ? "No expiry" : t("row.noExpiry")}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setTitleInput(doc.title);
                      setDateInput(dateInputValue(doc.validUntil));
                      setEditing(true);
                    }}
                    data-testid="doc-edit"
                    className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                  >
                    {doc.validUntil || doc.noExpiry ? t("row.editDetails") : t("row.addExpiry")}
                  </button>
                </div>
              )}
            </div>
          )}

          {editable && editing && (
            <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
          <div>
            <label className="text-xs font-medium text-slate-500">{t("row.certName")}</label>
            <input
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder={t("row.certNamePh")}
              data-testid="doc-title-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">{t("row.expiryDate")}</label>
            <input
              type="date"
              value={noExpiryInput ? "" : dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              disabled={noExpiryInput}
              data-testid="doc-expiry-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            />
          </div>
          {/* Feature 3 — mark the document as perpetual (no end date). Checking it
              clears + disables the date and sends noExpiry:true on save. i18n: an
              inline English fallback for now; a "row.noExpiryToggle" key should be
              added to lib/i18n.ts later (that file is out of this change's scope). */}
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600" data-testid="doc-no-expiry">
            <input
              type="checkbox"
              checked={noExpiryInput}
              onChange={(e) => setNoExpiryInput(e.target.checked)}
              data-testid="doc-no-expiry-input"
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            This document has no expiry date
          </label>
          {error && <p className="text-xs text-rose-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              data-testid="doc-save"
              className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {saving ? t("row.saving") : t("row.save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              {t("row.cancel")}
            </button>
          </div>
            </div>
          )}

          {/* Per-document actions — Archive/Unarchive + Delete. Kept low-key so the
              row still reads as the document first, the controls second. */}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
            {!doc.archived ? (
              <button
                type="button"
                onClick={() => toggleArchive(true)}
                disabled={archiving}
                data-testid="doc-archive"
                className="inline-flex min-h-[36px] items-center rounded-lg px-3 text-xs font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-60"
              >
                {archiving ? "Archiving…" : "Archive"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => toggleArchive(false)}
                disabled={archiving}
                data-testid="doc-unarchive"
                className="inline-flex min-h-[36px] items-center rounded-lg px-3 text-xs font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-60"
              >
                {archiving ? "…" : "Unarchive"}
              </button>
            )}
            {!confirmingDelete ? (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                data-testid="doc-delete"
                className="inline-flex min-h-[36px] items-center rounded-lg px-3 text-xs font-semibold text-rose-600 hover:bg-rose-50"
              >
                Delete
              </button>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="text-xs text-rose-700">
                  Delete this document? This cannot be undone.
                </span>
                <button
                  type="button"
                  onClick={remove}
                  disabled={deleting}
                  data-testid="doc-delete-confirm"
                  className="inline-flex min-h-[36px] items-center rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                >
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="inline-flex min-h-[36px] items-center rounded-lg px-3 text-xs font-medium text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </span>
            )}
          </div>
          {error && !editing && (
            <p className="mt-1 text-xs text-rose-600" data-testid="doc-action-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export default function SeafarerPage({
  sample = false,
  initialData,
}: {
  /** Public sample render (plan D3): props-seeded SSR, read-only, no boot fetches. */
  sample?: boolean;
  initialData?: SeafarerPageInitialData;
} = {}) {
  const { t } = useT();
  // Arm/disarm the module-level fetch guard on EVERY render (client navigation
  // between the sample page and the real dashboard must flip it back).
  sampleRenderActive = sample === true;
  // EVERY relevant state seeds from initialData in its INITIALIZER (never an
  // effect) so the sample server render already contains the full dashboard.
  const [seafarer, setSeafarer] = useState<Seafarer | null>(initialData?.seafarer ?? null);
  const [documents, setDocuments] = useState<Doc[]>(initialData?.documents ?? []);
  // Agent-raised document-request checklist shown to the seaman (read-only to-do list).
  const [docRequests, setDocRequests] = useState<DocRequest[]>(initialData?.docRequests ?? []);
  // The seaman's own self-service profile-change proposals + their shore outcomes.
  const [profileChanges, setProfileChanges] = useState<ProfileChangeRequest[]>(
    initialData?.profileChanges ?? []
  );
  // The seaman's own sea-service ledger (digital discharge book).
  const [seaService, setSeaService] = useState<SeaServiceEntry[]>(initialData?.seaService ?? []);
  // "My applications" — per-agency flow status (read-only), from the page payload.
  const [flows, setFlows] = useState<Flow[]>(initialData?.flows ?? []);
  // #38.5 — pending agent-side propagation requests for this seaman to approve/decline.
  const [propagationRequests, setPropagationRequests] = useState<PropagationRequest[]>(
    initialData?.propagationRequests ?? []
  );
  // #12 — pending agent-deleted appraisals for this seaman to keep or delete.
  const [appraisalDeleteRequests, setAppraisalDeleteRequests] = useState<AppraisalDeleteRequest[]>(
    initialData?.appraisalDeleteRequests ?? []
  );
  const [loading, setLoading] = useState(!sample);
  const [nameInput, setNameInput] = useState("");
  const [rankInput, setRankInput] = useState("");
  // Owner-editable rank + availability on the OWN profile (owner-token authorised,
  // NO shore-approval gate). Seeded once per profile from the loaded seafarer.
  const [rankDraft, setRankDraft] = useState(initialData?.seafarer?.rank ?? "");
  const [savingRank, setSavingRank] = useState(false);
  // #9 — surface a failed rank save inline instead of silently keeping the local draft.
  const [rankError, setRankError] = useState<string | null>(null);
  const [availSel, setAvailSel] = useState<"" | Availability>(
    initialData?.seafarer?.availability ?? ""
  );
  const [availFromDraft, setAvailFromDraft] = useState(initialData?.seafarer?.availableFrom ?? "");
  const [savingAvailability, setSavingAvailability] = useState(false);
  // Two independent share links. Each has its own Copy + Reset; both are always
  // active. `origin` is captured on mount so the URLs render without an SSR mismatch.
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<"open" | "email" | null>(null);
  const [resetting, setResetting] = useState<"open" | "email" | null>(null);
  const [confirmReset, setConfirmReset] = useState<"open" | "email" | null>(null);
  const [resetNote, setResetNote] = useState<{ which: "open" | "email"; text: string } | null>(null);

  // The PRIVATE (email) link's allow-list editor. Persisted on the seafarer; the list
  // is validated/normalised server-side.
  const [emailDraft, setEmailDraft] = useState("");
  const [savingShare, setSavingShare] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  // The ENTIRE share area (open link + private link + allowed-emails editor) is
  // collapsed by default so it stops eating vertical space when the seaman isn't
  // sharing. One compact toggle expands it, mirroring the archived-docs collapse.
  const [showShare, setShowShare] = useState(sample); // sample: open for the demo

  // Expiry-reminders module: same compact-toggle collapse as the share box. The
  // settings themselves live on the seafarer (persisted); this only tracks the UI
  // open state + the in-flight save.
  const [showReminders, setShowReminders] = useState(false);
  const [savingReminders, setSavingReminders] = useState(false);
  const [remindersCopied, setRemindersCopied] = useState(false);

  // Bootstrap-from-code (the secondary path): paste one code, we make the profile.
  const [bootCode, setBootCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCodeForm, setShowCodeForm] = useState(false);

  // Photo-first create: the seaman snaps his certificates, we make the profile,
  // then those photos upload themselves on the dashboard (green check each).
  const [bootFiles, setBootFiles] = useState<File[]>([]);
  const cameraRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLInputElement>(null);

  // Add-document form — paste a verification code / certificate URL only. File
  // upload is handled solely by the MassUpload control above.
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Doc | null>(null);
  const [justNote, setJustNote] = useState<string | null>(null);
  // Registry paste round-trips (§5.2): the multi-key prompt (UK/NO date of
  // birth, …), the ambiguous country picker, and the §2.5 first-set
  // holder-confirm step — each re-POSTs the same code with the extra fields.
  const [registryPrompt, setRegistryPrompt] = useState<
    | {
        kind: "needs-inputs";
        country: CountryEntry;
        missing: RegistryInputField[];
        countryOverride: string;
      }
    | { kind: "ambiguous"; candidates: string[]; unmatched?: boolean }
    | {
        kind: "confirm-holder";
        holderName: string;
        countryOverride?: string;
        inputs?: Record<string, string>;
      }
    | null
  >(null);
  const [registryVals, setRegistryVals] = useState<Record<string, string>>({});
  const [hydrated, setHydrated] = useState(false);

  // Google seaman ownership. When signed in, identity comes from the SESSION (works
  // on any device) instead of the localStorage-only share token. `googleEnabled`
  // gates the button so it only shows once Google OAuth is configured. The sample
  // render acts as the signed-in OWNER view (full dashboard, server-guarded RO).
  const [signedIn, setSignedIn] = useState(sample);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  // Credential (password) sessions only (feat/password-signup Step 13): the
  // /me payload's authMethod flag + the session display name (= the credential
  // USERNAME, which the Account section needs for the post-change re-signIn).
  const [sessionAuthMethod, setSessionAuthMethod] = useState<"password" | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  // Password sign-in availability, derived from the same /api/auth/providers
  // payload (feat/password-signup Step 7). The Credentials provider is always
  // registered (D9), so this is true whenever the providers fetch succeeds.
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  // A signed-in user opened someone's claim link (?token= not their own): the
  // token is deliberately NOT adopted (invariant 7 — already-bound users never
  // re-adopt); surface pw.alreadyOwned instead of silently ignoring it (fold 7).
  const [alreadyOwnedClaim, setAlreadyOwnedClaim] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // True only when this device landed via an emailed placeholder-claim link
  // (/seafarer?token=<shareToken>) with no owned session and no device token. It
  // relabels the sign-in banner to a "this is me / claim it" call to action; it
  // does NOT change any auth — adoption still runs through the unchanged
  // SeamanGoogleSignIn -> login-intent -> case-3 chain on the token we persisted.
  const [claimMode, setClaimMode] = useState(false);

  // Add-documents area collapse. The open/closed DEFAULT is decided ONCE, at load
  // time (see the initialiser effect below): EXPANDED for a seaman who holds zero
  // docs at load so the upload prompt is obvious; COLLAPSED once they already hold
  // ≥1 document at load. It is deliberately NOT derived from the live doc count, so
  // a fresh in-session upload (0→1 docs) does NOT auto-collapse the section and hide
  // the just-finished progress bar / per-file results. null only until the first
  // load resolves; after that it is an explicit boolean a manual toggle can flip.
  const [addOpen, setAddOpen] = useState<boolean | null>(null);
  // Freezes the load-time collapse decision so it runs exactly once per profile.
  const addOpenInitialized = useRef(false);

  // Archived documents: shown in a collapsible section, still viewable + unarchivable.
  const [showArchived, setShowArchived] = useState(false);
  // CV / certificate matrix modal (built from the seaman's own documents in state).
  const [showCv, setShowCv] = useState(false);
  const [savingAutoArchive, setSavingAutoArchive] = useState(false);
  // Profile-photo change/reset (owner-token authorised).
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // Clear-verified-identity (owner-token authorised): offered only when no
  // government-verified document backs the identity any more. Two-step inline confirm.
  const [confirmClearIdentity, setConfirmClearIdentity] = useState(false);
  const [clearingIdentity, setClearingIdentity] = useState(false);
  // The image the owner just picked, held open in the ADJUSTER modal until they save
  // (uploads the cropped/zoomed/rotated canvas blob) or cancel (no change).
  const [adjustFile, setAdjustFile] = useState<File | null>(null);
  // Docs the user manually unarchived THIS session — auto-archive must leave those
  // decisions alone (don't immediately re-archive something the user just restored).
  const manuallyUnarchived = useRef<Set<string>>(new Set());
  // Guard so the async auto-archive pass never runs concurrently with itself.
  const autoArchiveRunning = useRef(false);

  function onDocDeleted(docId: string) {
    setDocuments((prev) => prev.filter((x) => x.id !== docId));
  }
  function onDocUnarchived(docId: string) {
    manuallyUnarchived.current.add(docId);
  }

  // Seed the rank + availability editors once per loaded profile (keyed on id).
  useEffect(() => {
    if (!seafarer) return;
    setRankDraft(seafarer.rank ?? "");
    setAvailSel(seafarer.availability ?? "");
    setAvailFromDraft(seafarer.availableFrom ?? "");
  }, [seafarer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the OWN rank (owner-token authorised, no approval gate). Saves on blur
  // only when the value actually changed.
  async function saveRank() {
    if (!seafarer) return;
    const next = rankDraft.trim();
    if (next === (seafarer.rank ?? "")) return;
    setSavingRank(true);
    setRankError(null);
    try {
      const res = await guardedFetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: seafarer.id, token: seafarer.shareToken, rank: next }),
      });
      const data = await res.json().catch(() => ({}));
      // #9 — a non-ok (or a failed fetch below) must be VISIBLE: the draft is kept in the
      // field but the seaman is told the save did not land, instead of it being silently lost.
      if (data.ok) setSeafarer(data.seafarer as Seafarer);
      else setRankError(data.error ?? "Could not save your rank. Please try again.");
    } catch {
      setRankError("Could not save your rank. Check your connection and try again.");
    } finally {
      setSavingRank(false);
    }
  }

  // Persist the OWN availability (owner-token authorised, no approval gate — marking
  // yourself occupied is instant). availableFrom is sent only for the open_from state.
  async function saveAvailability(availability: Availability, availableFrom?: string) {
    if (!seafarer) return;
    setSavingAvailability(true);
    try {
      const res = await guardedFetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: seafarer.id,
          token: seafarer.shareToken,
          availability,
          availableFrom: availableFrom ?? null,
        }),
      });
      const data = await res.json();
      if (data.ok) setSeafarer(data.seafarer as Seafarer);
    } catch {
      /* leave the controls as-is on a network error */
    } finally {
      setSavingAvailability(false);
    }
  }

  // Availability select change: open/occupied save immediately; open_from waits until
  // a date is present (the server rejects open_from with no date).
  function onAvailabilityChange(v: "" | Availability) {
    setAvailSel(v);
    if (v === "open" || v === "occupied") void saveAvailability(v);
    else if (v === "open_from" && availFromDraft) void saveAvailability("open_from", availFromDraft);
  }
  function onAvailFromChange(v: string) {
    setAvailFromDraft(v);
    if (availSel === "open_from" && v) void saveAvailability("open_from", v);
  }

  // Persist the per-seafarer auto-archive-expired setting (owner-token authorised).
  async function setAutoArchive(next: boolean) {
    if (!seafarer) return;
    setSavingAutoArchive(true);
    try {
      const res = await guardedFetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: seafarer.id,
          autoArchiveExpired: next,
          token: seafarer.shareToken,
        }),
      });
      const data = await res.json();
      if (data.ok) setSeafarer(data.seafarer as Seafarer);
    } catch {
      /* leave the toggle as-is on a network error */
    } finally {
      setSavingAutoArchive(false);
    }
  }

  // Persist the expiry-reminder calendar settings on the OWN profile (owner-token
  // authorised). Takes a partial patch merged onto the current saved settings, so any
  // one control can save without racing the others. The server clamps to safe bounds
  // and returns the fresh seafarer, which we adopt.
  async function saveReminderSettings(patch: Partial<ReminderSettings>) {
    if (!seafarer) return;
    const current = settingsFromSeafarer(seafarer);
    const next: ReminderSettings = { ...current, ...patch };
    setSavingReminders(true);
    try {
      const res = await guardedFetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: seafarer.id, token: seafarer.shareToken, reminderSettings: next }),
      });
      const data = await res.json();
      if (data.ok) setSeafarer(data.seafarer as Seafarer);
    } catch {
      /* leave the controls as-is on a network error */
    } finally {
      setSavingReminders(false);
    }
  }

  // Upload a CUSTOM profile photo (owner-token authorised). The server stores it under
  // uploads/ and returns the fresh seafarer, which we adopt so the avatar swaps at once.
  async function uploadProfilePhoto(image: Blob) {
    if (!seafarer) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const fd = new FormData();
      // The adjuster hands us a JPEG blob; give the multipart part a filename so the
      // server's extension fallback is happy even though it reads the MIME type first.
      fd.append("file", image, "profile.jpg");
      fd.append("token", seafarer.shareToken);
      const res = await guardedFetch(`/api/profile-photo/${encodeURIComponent(seafarer.id)}`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setSeafarer(data.seafarer as Seafarer);
        setAdjustFile(null); // close the adjuster on success
      } else setPhotoError(data.error ?? "Could not change your photo.");
    } catch {
      setPhotoError("Could not change your photo. Check your connection and try again.");
    } finally {
      setPhotoBusy(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  // Reset to the government-verified photo (owner-token authorised): clears the custom
  // override so the verified photo shows again.
  async function resetProfilePhoto() {
    if (!seafarer) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const res = await guardedFetch(`/api/profile-photo/${encodeURIComponent(seafarer.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: seafarer.shareToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setSeafarer(data.seafarer as Seafarer);
      else setPhotoError(data.error ?? "Could not reset your photo.");
    } catch {
      setPhotoError("Could not reset your photo. Check your connection and try again.");
    } finally {
      setPhotoBusy(false);
    }
  }

  // Clear the government-verified identity (owner-token authorised). Offered only when
  // no government-verified document backs it any more. Resets identityVerified + the
  // verified fields server-side; the header then falls back to the typed/Google name.
  async function clearVerifiedIdentity() {
    if (!seafarer) return;
    setClearingIdentity(true);
    try {
      const res = await guardedFetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: seafarer.id,
          token: seafarer.shareToken,
          clearVerifiedIdentity: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) setSeafarer(data.seafarer as Seafarer);
    } catch {
      /* leave the header as-is on a network error */
    } finally {
      setClearingIdentity(false);
      setConfirmClearIdentity(false);
    }
  }

  // Persist the PRIVATE-link allowed-email allow-list (owner-token authorised). The
  // server validates + normalises the emails and returns the fresh seafarer, which we
  // adopt so the UI reflects exactly what was stored.
  async function saveShare(patch: { allowedEmails?: string[] }) {
    if (!seafarer) return;
    setSavingShare(true);
    setShareError(null);
    try {
      const res = await guardedFetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: seafarer.id, token: seafarer.shareToken, ...patch }),
      });
      const data = await res.json();
      if (data.ok) setSeafarer(data.seafarer as Seafarer);
      else setShareError(data.error ?? "Could not save your sharing settings.");
    } catch {
      setShareError("Could not save. Check your connection and try again.");
    } finally {
      setSavingShare(false);
    }
  }

  function addAllowedEmail() {
    const e = emailDraft.trim().toLowerCase();
    if (!e) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      setShareError("Enter a valid email address.");
      return;
    }
    const current = seafarer?.allowedEmails ?? [];
    setEmailDraft("");
    if (current.includes(e)) return;
    void saveShare({ allowedEmails: [...current, e] });
  }

  function removeAllowedEmail(email: string) {
    const current = seafarer?.allowedEmails ?? [];
    void saveShare({ allowedEmails: current.filter((x) => x !== email) });
  }

  // Opt-in auto-archive: when the setting is ON, archive every document that is past
  // its expiry (local date) and not already archived — evaluated on load of the view
  // and whenever the document set changes (after upload/edit) or the toggle flips on.
  // Docs the user manually unarchived this session are skipped, so a restore sticks.
  useEffect(() => {
    if (!seafarer?.autoArchiveExpired) return;
    const token = seafarer.shareToken;
    const targets = documents.filter(
      (d) => !d.archived && isExpiredLocal(d.validUntil) && !manuallyUnarchived.current.has(d.id)
    );
    if (targets.length === 0 || autoArchiveRunning.current) return;
    autoArchiveRunning.current = true;
    let cancelled = false;
    (async () => {
      for (const d of targets) {
        try {
          const res = await guardedFetch("/api/documents", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId: d.id, archived: true, token }),
          });
          const data = await res.json();
          if (!cancelled && data.ok) {
            setDocuments((prev) =>
              prev.map((x) => (x.id === (data.document as Doc).id ? (data.document as Doc) : x))
            );
          }
        } catch {
          /* best-effort — a failed archive is retried on the next evaluation */
        }
      }
      autoArchiveRunning.current = false;
    })();
    return () => {
      cancelled = true;
      autoArchiveRunning.current = false;
    };
  }, [seafarer?.autoArchiveExpired, seafarer?.shareToken, documents]);

  // The seaman authenticates to their OWN dossier by possession of their private
  // share TOKEN (unguessable, rotatable), not by their seafarerId — a raw id is not
  // a secret and reading by id is now agent-only + grant-scoped. We persist the
  // token and reload through ?token=, which returns the seafarer AND their documents.
  async function loadSeafarer(tokenValue: string) {
    const res = await guardedFetch(`/api/seafarers?token=${encodeURIComponent(tokenValue)}`);
    if (res.ok) {
      const data = await res.json();
      setSeafarer(data.seafarer);
      setDocuments(data.documents ?? []);
      setDocRequests(data.docRequests ?? []);
      setProfileChanges(data.profileChanges ?? []);
      setSeaService(data.seaService ?? []);
      setFlows(data.flows ?? []);
      setPropagationRequests(data.propagationRequests ?? []);
      // #12 — the token path (api/seafarers) delivers the pending keep/delete requests.
      setAppraisalDeleteRequests(data.appraisalDeleteRequests ?? []);
    } else {
      clearToken();
    }
    setLoading(false);
  }

  // Signed-in path: resolve the OWNED profile from the Google session (cross-device).
  // Returns true when a seaman session was found and loaded, false otherwise so the
  // caller can fall back to the anonymous localStorage token path.
  async function loadMe(): Promise<boolean> {
    try {
      const res = await guardedFetch("/api/seafarers/me");
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.ok || !data.seafarer) return false;
      setSeafarer(data.seafarer);
      setDocuments(data.documents ?? []);
      setDocRequests(data.docRequests ?? []);
      setProfileChanges(data.profileChanges ?? []);
      setSeaService(data.seaService ?? []);
      setFlows(data.flows ?? []);
      // #38.5 — wire the pending propagation requests on the SESSION path too, so a
      // Google/session-signed-in seaman sees the same pending-request cards the
      // ?token= path already shows (the /me route now returns propagationRequests).
      setPropagationRequests(data.propagationRequests ?? []);
      // #12 — mirror the appraisal keep/delete requests when the /me payload carries them.
      // (Delivery on the signed-in /me route is out of THIS change's file scope; the field
      // is consumed defensively so it lights up automatically once /me emits it.)
      setAppraisalDeleteRequests(data.appraisalDeleteRequests ?? []);
      // Persist the owner's own share token so the existing token-authorised flows
      // (upload / edit / revoke) keep working while signed in.
      setToken(data.seafarer.shareToken);
      setSignedIn(true);
      setSessionEmail(data.user?.email ?? null);
      // Step 13: password sessions unlock the Account section below.
      setSessionAuthMethod(data.authMethod === "password" ? "password" : null);
      setSessionName(data.user?.name ?? null);
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    setHydrated(true);
    setOrigin(window.location.origin);
    // Sample mode: the server already provided the whole dataset — no providers
    // probe, no session resolve, no token load (boot() early-return, plan D3).
    if (sample) return;
    let cancelled = false;
    async function boot() {
      // Is Google sign-in available on this deployment? (Also the /api/auth/providers
      // check the owner verifies.) The button only renders when it is.
      try {
        const pr = await guardedFetch("/api/auth/providers");
        if (pr.ok) {
          const providers = await pr.json();
          if (!cancelled) {
            setGoogleEnabled(!!providers?.google);
            // feat/password-signup Step 7: password auth flag from the same payload.
            setPasswordEnabled(!!providers?.credentials);
          }
        }
      } catch {
        /* leave disabled */
      }
      // Prefer the signed-in identity; fall back to the anonymous local token.
      const mine = await loadMe();
      if (cancelled) return;
      if (mine) {
        // Already signed in AND already owning a profile: a claim link carrying
        // someone's ?token= is deliberately NOT adopted (invariant 7 — a bound
        // user never re-adopts), but it must not be silently ignored either
        // (fold 7): tell the user (pw.alreadyOwned) so they can tell the agent.
        // loadMe() just persisted the OWN share token, so any differing inbound
        // token is a foreign claim link.
        const inbound = new URLSearchParams(window.location.search).get("token");
        if (inbound && inbound !== getToken()) {
          setAlreadyOwnedClaim(true);
          // Step 13c: report the ignored claim token so the server emits
          // ADOPT_SKIPPED (fold 7 — never silently ignore a claim visit).
          // Fire-and-forget: a failed report only loses a forensics line.
          void guardedFetch("/api/account/claim-report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: inbound }),
          }).catch(() => {});
        }
      }
      if (!mine) {
        // Inbound claim token from the emailed placeholder-claim link
        // (/seafarer?token=<shareToken>). Checked BEFORE the stored device
        // token so an EXPLICIT link always wins over whatever profile this
        // device happens to have saved — otherwise every link would show the
        // first profile the device ever opened. The owned-Google-session
        // short-circuit above is untouched, so a signed-in owner still wins
        // (anti-hijack): a stale or hostile ?token= can never override a
        // signed-in seaman. Persisting it with setToken makes it BOTH this
        // device's self-access token AND the adopt token
        // SeamanGoogleSignIn.getToken() forwards to login-intent ->
        // docka_adopt_token -> case-3 adoption of exactly this placeholder.
        // Loading the placeholder here (same token path the stored-token flow
        // uses) renders its name/docs/checklist for the not-yet-signed-in seaman.
        const inbound = new URLSearchParams(window.location.search).get("token");
        if (inbound) {
          setToken(inbound);
          setClaimMode(true);
          await loadSeafarer(inbound);
          return;
        }
        // No explicit link: fall back to the token this device already holds
        // (a bookmark with no ?token= still loads the saved profile).
        const stored = getToken();
        if (stored) {
          await loadSeafarer(stored);
          return;
        }
      }
      setLoading(false);
    }
    void boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sample` is fixed per mount
  }, []);

  // Cross-tab sign-out propagation (A2, hardened). When another tab CLEARS the token
  // (sign-out, resetProfile, or a 404), react here — but the next-auth SESSION, not the
  // local token, is the source of truth: a token clear alone must NOT log out a seaman
  // whose session cookie is still valid. So on a token-clear event we re-check the
  // session via loadMe() and only drop in-memory state when there is NO valid session.
  // `storage` fires only in OTHER tabs, and sessionStorage is per-tab, so shared-mode
  // tabs are unaffected. Cross-tab sign-IN is intentionally NOT propagated.
  useEffect(() => {
    if (sample) return; // sample render holds no token and no session to react to
    async function onStorage(e: StorageEvent) {
      // Only react to our token key. e.key === null is a global clear; it never fires
      // from app code (no localStorage.clear() in app/) — kept as a defensive catch-all.
      if (e.key !== "seacred:token" && e.key !== null) return;
      if (getToken() !== null) return; // token still present -> nothing to do
      // Token cleared elsewhere. Ask the server whether a valid seaman SESSION persists.
      const stillSignedIn = await loadMe(); // true repopulates + re-persists; false = no session
      if (!stillSignedIn) {
        setSeafarer(null);
        setDocuments([]);
        setDocRequests([]);
        setProfileChanges([]);
        setSeaService([]);
        setFlows([]);
        setPropagationRequests([]);
        setAppraisalDeleteRequests([]);
        setSignedIn(false);
        setSessionEmail(null);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Decide the add-documents collapse DEFAULT once, the moment a profile first loads.
  // Collapsed if the seaman already holds ≥1 document at load; expanded if 0. Freezing
  // it here (rather than reading the live doc count in render) is what stops a fresh
  // in-session upload from flipping the section closed and hiding the progress/results
  // the first-time user needs to see. A manual toggle afterwards still overrides it.
  useEffect(() => {
    if (!seafarer || addOpenInitialized.current) return;
    addOpenInitialized.current = true;
    setAddOpen(documents.length === 0);
  }, [seafarer, documents]);

  // Sign out of the Google seaman session. Keeps the local profile reachable via its
  // share token (still in localStorage) so the seaman is not locked out of a device
  // they own — signing out only drops the cross-device session, not the data.
  async function seamanSignOut() {
    setSigningOut(true);
    try {
      await signOut({ redirect: false });
    } finally {
      // Drop the local self-access token too. Runs AFTER signOut so the session cookie
      // is already gone — a cross-tab A2 loadMe re-check then correctly concludes
      // "session gone".
      clearToken();
      setSignedIn(false);
      setSessionEmail(null);
      setSigningOut(false);
    }
  }

  function onCreated(data: { seafarer: Seafarer; document?: Doc | null }) {
    setToken(data.seafarer.shareToken);
    setSeafarer(data.seafarer);
    // If the bootstrap code also produced a first document, show it right away.
    if (data.document) {
      setDocuments([data.document]);
      setJustAdded(data.document);
      setJustNote(null);
    }
  }

  // Lazy path: paste one code, the registry names the profile — no form.
  async function createFromCode(e: React.FormEvent) {
    e.preventDefault();
    if (!bootCode.trim()) {
      setCreateError("Paste a verification code or link to begin.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    const res = await guardedFetch("/api/seafarers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: bootCode.trim() }),
    });
    const data = await res.json();
    setCreating(false);
    if (data.ok) onCreated(data);
    else setCreateError(data.error ?? "Could not verify that code.");
  }

  async function createSeafarer(e: React.FormEvent) {
    e.preventDefault();
    if (!nameInput.trim()) return;
    setCreating(true);
    setCreateError(null);
    const res = await guardedFetch("/api/seafarers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nameInput.trim(), rank: rankInput.trim() }),
    });
    const data = await res.json();
    setCreating(false);
    if (data.ok) onCreated(data);
    else setCreateError(data.error ?? "Could not create your profile.");
  }

  // One submit path for the paste flow and all its registry round-trips
  // (§5.2): the optional extras carry a country-picker selection, the
  // multi-key lookup inputs, and the §2.5 "yes, this is me" confirmation.
  async function submitDoc(extra?: {
    countryOverride?: string;
    inputs?: Record<string, string>;
    holderConfirmed?: boolean;
  }) {
    if (!seafarer) return;
    if (!code.trim()) {
      setFormError("Paste a verification code or certificate link.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setJustAdded(null);

    const fd = new FormData();
    fd.append("seafarerId", seafarer.id);
    // Seaman self-service auth: a seaman authenticates by possession of their OWN
    // share token (agentSession is null for the seaman role), so the POST auth gate
    // needs it — same secret already sent on this page's PATCH/DELETE calls.
    fd.append("token", seafarer.shareToken);
    fd.append("code", code.trim());
    if (extra?.countryOverride) fd.append("countryOverride", extra.countryOverride);
    if (extra?.inputs && Object.keys(extra.inputs).length > 0) {
      fd.append("registryInputs", JSON.stringify(extra.inputs));
    }
    if (extra?.holderConfirmed) fd.append("holderConfirmed", "1");

    const res = await guardedFetch("/api/documents", { method: "POST", body: fd });
    const data = await res.json();
    setSubmitting(false);
    if (data.ok && data.duplicate) {
      // Same-seafarer duplicate: disregarded server-side. Surface it, don't re-add.
      setJustAdded(null);
      setJustNote("Already uploaded — skipped (this certificate is already on your profile).");
      setCode("");
      setRegistryPrompt(null);
    } else if (data.ok) {
      setDocuments((prev) => [...prev, data.document]);
      setJustAdded(data.document);
      // A bare upload we could read a code from is auto-verified; one we couldn't
      // is stored as a plain file with a gentle nudge instead of silence. A §2.5
      // holder mismatch is stored unverified + flagged — say so honestly.
      setJustNote(
        data.holderMismatch && data.message
          ? data.message
          : data.readFromPhoto && !data.document?.validUntil
            ? "Saved from your photo — the agent will review it. You can add an expiry date below if you'd like a reminder (optional)."
            : data.fileOnly
              ? "We couldn't read a verification code from that file, so it's saved as a plain document. You can add an expiry date below if you'd like a reminder (optional), or paste its code to verify it."
              : data.autoVerified
                ? "We found the code inside your file and verified it automatically."
                : null
      );
      setCode("");
      setRegistryPrompt(null);
      setRegistryVals({});
    } else if (data.needsHolderConfirmation) {
      // §2.5 rule 3 (first-set): show WHO the registry says holds it and require
      // an explicit "yes, this is me" before anything is stored.
      setRegistryPrompt({
        kind: "confirm-holder",
        holderName: String(data.holderName ?? ""),
        countryOverride: extra?.countryOverride,
        inputs: extra?.inputs,
      });
    } else if (data.outcome?.kind === "needs-inputs") {
      // §5.2 multi-key prompt: auto-fill from the profile where the field's
      // source allows; if EVERYTHING auto-fills, re-submit immediately (max
      // automation — prompt only for what is genuinely absent).
      const oc = data.outcome as {
        country: CountryEntry;
        missing: RegistryInputField[];
      };
      const vals: Record<string, string> = {};
      for (const f of oc.missing) {
        if (f.source === "profile.birthDate" && seafarer.birthDate) {
          vals[f.key] = seafarer.birthDate.slice(0, 10); // UTC slice — no tz math
        } else if (f.source === "profile.verifiedName") {
          vals[f.key] = (seafarer.verifiedName ?? seafarer.name ?? "").trim();
        }
      }
      const allFilled = oc.missing.every((f) => f.optional || (vals[f.key] ?? "").trim());
      if (allFilled && !extra?.inputs) {
        await submitDoc({ countryOverride: oc.country.country, inputs: vals });
        return;
      }
      setRegistryVals(vals);
      setRegistryPrompt({
        kind: "needs-inputs",
        country: oc.country,
        missing: oc.missing,
        countryOverride: oc.country.country,
      });
    } else if (data.outcome?.kind === "ambiguous") {
      // Country picker round-trip (§2.3): re-POST the same code with the pick.
      // `unmatched` (persona B2) = the code matched NO registry — full-list
      // picker with dead-end-rescue wording instead of an EE-flavored error.
      setRegistryPrompt({
        kind: "ambiguous",
        candidates: (data.outcome.candidates as string[]) ?? [],
        unmatched: (data.outcome as { unmatched?: boolean }).unmatched === true,
      });
    } else {
      setRegistryPrompt(null);
      setFormError(data.error ?? "Could not add the document.");
    }
  }

  async function addDocument(e: React.FormEvent) {
    e.preventDefault();
    setRegistryPrompt(null);
    setRegistryVals({});
    await submitDoc();
  }

  function copyLink(which: "open" | "email", url: string) {
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1800);
    });
  }

  // Reset ONE share link (open OR private) and mint a fresh token for just that link.
  // The OTHER link and every uploaded document are untouched — they belong to the
  // profile, not to a link. Owner-authorised by the open share token this device holds.
  async function resetLink(which: "open" | "email") {
    if (!seafarer) return;
    setResetting(which);
    setResetNote(null);
    try {
      const res = await guardedFetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: seafarer.id,
          token: seafarer.shareToken,
          ...(which === "open" ? { resetOpenToken: true } : { resetEmailToken: true }),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSeafarer(data.seafarer);
        // The OPEN token doubles as this device's self-access key — persist the
        // rotated one so resetting the open link never locks the seaman out.
        setToken(data.seafarer.shareToken);
        setResetNote({
          which,
          text:
            which === "open"
              ? "Open link reset. The old open link no longer works. Your private link is unchanged."
              : "Private link reset. The old private link no longer works. Your open link is unchanged.",
        });
      } else {
        setResetNote({ which, text: data.error ?? "Could not reset this link. Try again." });
      }
    } catch {
      setResetNote({ which, text: "Could not reset. Check your connection and try again." });
    } finally {
      setResetting(null);
      setConfirmReset(null);
    }
  }

  function resetProfile() {
    clearToken();
    setSeafarer(null);
    setDocuments([]);
    setNameInput("");
    setRankInput("");
    setBootCode("");
    setCreateError(null);
    setShowCodeForm(false);
    setBootFiles([]);
    setJustAdded(null);
    setJustNote(null);
    // Let the next profile that loads re-decide its own collapse default from scratch.
    addOpenInitialized.current = false;
    setAddOpen(null);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-slate-400">Loading…</div>
    );
  }

  // ---- Create-profile state -------------------------------------------
  // Photo-first: paper certificates have no code, so the biggest call-to-action
  // is "photograph your certificates". Typing a code is the small secondary path.
  if (!seafarer) {
    function addBootFiles(list: FileList | null) {
      if (!list || list.length === 0) return;
      setBootFiles((prev) => [...prev, ...Array.from(list)]);
    }
    return (
      <div
        className="mx-auto max-w-md px-4 py-12"
        data-testid="seafarer-create"
        data-hydrated={hydrated ? "true" : "false"}
      >
        <h1 className="text-2xl font-bold text-slate-900">{t("sc.title")}</h1>
        <p className="mt-2 text-sm text-slate-500">{t("sc.subtitle")}</p>
        {/* Public Sample Profiles (Phase 6): let a hesitant signed-out seafarer
            see the live fictional-data demo before creating anything. */}
        <p className="mt-2 text-sm">
          <Link
            href="/sample/seafarer"
            data-testid="seafarer-view-sample"
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            {t("sample.viewSample")} →
          </Link>
        </p>

        {/* Self-signup: Google (when configured) OR username + password
            (feat/password-signup Step 7 — always registered per D9, so it works
            in WeChat/mainland-China webviews where Google is refused). The old
            anonymous (no-login) create form stays removed. */}
        <div className="mt-8" data-testid="seaman-signin-offer">
          {googleEnabled && (
            <>
              <SeamanGoogleSignIn prominent label="Sign in with Google" />
              <p className="mt-3 text-center text-sm text-slate-500">
                Sign in to create your seafarer profile and open your documents on any device.
              </p>
            </>
          )}
          {googleEnabled && passwordEnabled && (
            <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              {t("pw.or")}
              <span className="h-px flex-1 bg-slate-200" />
            </div>
          )}
          {passwordEnabled && (
            <SeamanPasswordAuth
              claimMode={claimMode}
              onSignedIn={async () => {
                await loadMe();
              }}
            />
          )}
          {/* Dead-end box only when NEITHER option is available (practically
              never — the Credentials provider needs no configuration). */}
          {!googleEnabled && !passwordEnabled && (
            <div
              data-testid="seaman-signin-unconfigured"
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500"
            >
              Sign-in is not configured on this deployment yet. Once the owner
              completes the auth setup, seafarers sign in here to create their profile.
            </div>
          )}
        </div>

        <form onSubmit={createSeafarer} className="hidden">
          {/* Big, explicit camera button — the primary action on a phone. */}
          <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center">
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              data-testid="create-camera"
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              {t("sc.takePhoto")}
            </button>
            <button
              type="button"
              onClick={() => chooseRef.current?.click()}
              data-testid="create-choose"
              className="mt-2 block w-full text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              {t("sc.choose")}
            </button>
            {bootFiles.length > 0 && (
              <p className="mt-3 text-xs font-semibold text-emerald-700" data-testid="boot-file-count">
                {t("sc.photosReady", { n: bootFiles.length })}
              </p>
            )}
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                addBootFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={chooseRef}
              type="file"
              multiple
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                addBootFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500">{t("sc.yourName")}</label>
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={t("sc.namePh")}
              data-testid="name-input"
              className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <input
              value={rankInput}
              onChange={(e) => setRankInput(e.target.value)}
              placeholder={t("sc.rankPh")}
              data-testid="rank-input"
              className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>

          {createError && <p className="text-sm text-rose-600" data-testid="create-error">{createError}</p>}
          <button
            type="submit"
            disabled={creating}
            data-testid="create-seafarer-submit"
            className="w-full rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-60"
          >
            {creating
              ? t("sc.settingUp")
              : bootFiles.length > 0
                ? t("sc.createWith", { n: bootFiles.length })
                : t("sc.create")}
          </button>
        </form>

        {/* Legacy anonymous code-path — removed from the flow (self-signup is
            Google-only). Kept hidden so its handlers stay wired without offering the
            no-login create; the backend rejects any anonymous create with 401. */}
        <div className="hidden">
          {!showCodeForm ? (
            <button
              type="button"
              onClick={() => {
                setShowCodeForm(true);
                setCreateError(null);
              }}
              data-testid="start-with-code"
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              {t("sc.haveCode")}
            </button>
          ) : (
            <form onSubmit={createFromCode} className="space-y-3">
              <p className="text-xs font-medium text-slate-500">{t("sc.verifyWith")}</p>
              <input
                value={bootCode}
                onChange={(e) => setBootCode(e.target.value)}
                placeholder={t("sc.codePh")}
                spellCheck={false}
                data-testid="boot-code-input"
                className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
              <button
                type="submit"
                disabled={creating}
                data-testid="boot-submit"
                className="w-full rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
              >
                {creating ? t("sc.verifying") : t("sc.verifyCreate")}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ---- Profile dashboard ----------------------------------------------
  // Split the roster: ACTIVE docs stay in the main list; ARCHIVED docs drop into a
  // collapsible section where they stay viewable and can be unarchived.
  // Government-verified documents rank FIRST in the active list; the rest keep their
  // current order. Archived docs are unaffected — they stay in their own section below.
  const activeDocuments = verifiedFirst(documents.filter((d) => !d.archived));
  const archivedDocuments = documents.filter((d) => d.archived);
  // The share controls are unavailable until the seaman has uploaded at least ONE
  // document (active or archived). Below: both independent share links + the private
  // link's allow-list.
  const hasAnyDocument = documents.length > 0;
  // Expanded when the seaman has no documents yet (must see the upload prompt), else
  // collapsed by default; a manual toggle (addOpen) overrides this default.
  const addExpanded = addOpen ?? !hasAnyDocument;
  const allowedEmails = seafarer.allowedEmails ?? [];
  // Sample mode: the OPEN link is the real, working published link (render it even
  // before `origin` resolves so the server HTML already carries it); the PRIVATE
  // link stays blank — its token is redacted server-side and the half is disabled.
  const openShareUrl = origin
    ? `${origin}/share/${seafarer.openShareToken}`
    : sample
      ? `/share/${seafarer.openShareToken}`
      : "";
  const emailShareUrl =
    sample || !origin ? "" : `${origin}/share/${seafarer.emailShareToken}`;

  // ---- Expiry-reminders derived state ---------------------------------
  // Settings come off the seafarer (persisted); the preview computes PER DOCUMENT so
  // the module can show exactly which documents get reminders and how many events.
  const reminderSettings = settingsFromSeafarer(seafarer);
  const reminderPreview = documents
    .filter((d) => docHasReminderExpiry(d))
    .map((d) => ({ doc: d, dates: computeReminderDates(d.validUntil, reminderSettings) }))
    .filter((p) => p.dates.length > 0);
  const totalReminderEvents = reminderPreview.reduce((n, p) => n + p.dates.length, 0);
  // Owner-scoped .ics download (authorised by the owner's own share token).
  const calendarUrl = `${origin}/api/calendar?token=${encodeURIComponent(seafarer.shareToken)}`;
  const webcalUrl = origin ? calendarUrl.replace(/^https?:/i, "webcal:") : "";
  const fmtReminderDate = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  // Profile photo: custom upload overrides the stored verified photo; both are served
  // from the LOCAL file via the files-scoped photo API (never the expiring registry
  // URL). `v` cache-busts the <img> whenever the underlying file changes.
  const activeProfilePhoto = seafarer.customPhotoFile ?? seafarer.verifiedPhotoFile ?? null;
  // Is the verified identity still backed by a government-verified document? Counts
  // ANY government doc (incl. archived) — matching what the owner self-heal treats as
  // backing — so clearing is offered ONLY when nothing backs the identity, and once
  // cleared the backfill cannot immediately repopulate it.
  const hasGovernmentDoc = documents.some((d) => d.source === "government");
  const profilePhotoSrc = activeProfilePhoto
    ? `/api/profile-photo/${encodeURIComponent(seafarer.id)}?token=${encodeURIComponent(
        seafarer.shareToken
      )}&v=${encodeURIComponent(activeProfilePhoto)}`
    : null;
  const profileInitials =
    (seafarer.verifiedName || seafarer.name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? "")
      .join("") || "?";
  return (
    <div
      className="mx-auto max-w-3xl px-4 py-10"
      data-testid="seafarer-profile"
      data-hydrated={hydrated ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            {t("sd.eyebrow")}
          </p>
          {/* The public /sample/seafarer page carries its own H1 (SEO plan v3 C8),
              so the name is an H2 there; the real dashboard keeps the H1. */}
          {sample ? (
            <h2 className="text-2xl font-bold text-slate-900">{seafarer.name}</h2>
          ) : (
            <h1 className="text-2xl font-bold text-slate-900">{seafarer.name}</h1>
          )}
          {signedIn && seafarer.rank && <p className="text-sm text-slate-500">{seafarer.rank}</p>}
          {signedIn && !sample && (
            <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-emerald-700" data-testid="seaman-signed-in">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Signed in{sessionEmail ? ` as ${sessionEmail}` : ""} · saved to your account
            </p>
          )}
        </div>
        {sample ? null : signedIn ? (
          <button
            onClick={seamanSignOut}
            disabled={signingOut}
            data-testid="seaman-signout"
            className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:opacity-60"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        ) : claimMode ? null : (
          // A not-signed-in claim-mode seaman hasn't started anything to reset — "Start new"
          // (resetProfile → clearToken + create screen) is a confusing soft dead-end for him,
          // so the only header action stays the claim CTA below.
          <button
            onClick={resetProfile}
            className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-slate-400 hover:bg-slate-50 hover:text-slate-600"
          >
            {t("sd.startNew")}
          </button>
        )}
      </div>

      {/* In-app inbox — company messages sent to this crew member, with an unread
          badge. Read-only in this phase (the reply composer lands later). Resolves the
          seaman via the session, falling back to this device's own share token. */}
      {signedIn && (
        <SeamanInbox
          token={seafarer.shareToken}
          sample={sample}
          initialItems={sample ? initialData?.inbox.items : undefined}
        />
      )}

      {/* Rank & availability — owner self-service, saved instantly (no shore approval).
          Rank drives which documents the agent requires; availability is the seaman's
          own "am I free for a berth" signal, separate from the agent's pipeline stage. */}
      {signedIn && (
      <div
        className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        data-testid="rank-availability"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-slate-500" htmlFor="rank-edit-input">
              Your rank / position
            </label>
            <input
              id="rank-edit-input"
              value={rankDraft}
              onChange={(e) => setRankDraft(e.target.value)}
              onBlur={saveRank}
              placeholder="e.g. Chief Officer, Able Seaman"
              data-testid="rank-edit-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              {savingRank ? "Saving…" : "Used to work out which certificates you need."}
            </p>
            {rankError && (
              <p className="mt-1 text-[11px] text-rose-600" data-testid="rank-error" role="alert">
                {rankError}
              </p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500" htmlFor="availability-select">
              Availability
            </label>
            <select
              id="availability-select"
              value={availSel}
              onChange={(e) => onAvailabilityChange(e.target.value as "" | Availability)}
              disabled={savingAvailability}
              data-testid="availability-select"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Not set</option>
              {AVAILABILITY_VALUES.map((a) => (
                <option key={a} value={a}>
                  {AVAILABILITY_LABELS[a]}
                </option>
              ))}
            </select>
            {availSel === "open_from" && (
              <input
                type="date"
                value={availFromDraft}
                onChange={(e) => onAvailFromChange(e.target.value)}
                disabled={savingAvailability}
                data-testid="availability-from-date"
                aria-label="Available from date"
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            )}
            <p className="mt-1 text-[11px] text-slate-400">
              {savingAvailability
                ? "Saving…"
                : "Tell agents whether you can take a berth now."}
            </p>
          </div>
        </div>
      </div>
      )}

      {/* Account & security (feat/password-signup Step 13) — PASSWORD sessions
          only: change password + regenerate recovery codes. Google users have
          nothing to manage here, so the section stays hidden for them. */}
      {signedIn && sessionAuthMethod === "password" && sessionName && (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <AccountSecurity username={sessionName} side="seaman" />
        </div>
      )}

      {/* Verified identity — Feature: when a government verification succeeded for one
          of this seaman's documents, the registry-returned holder identity is the
          AUTHORITATIVE maritime identity. Show it in a compact header with a green
          "Verified identity" badge. Rendered ONLY when identityVerified is true; the
          plain typed/Google name in the h1 above is the fallback otherwise. */}
      {signedIn && seafarer.identityVerified && (
        <div
          className="mt-6 flex items-center gap-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm"
          data-testid="verified-identity"
        >
          {/* Avatar: the LOCAL profile photo (custom upload -> stored verified photo),
              or the seaman's initials when neither is stored yet. Served from the
              files-scoped photo API, never the expiring registry URL. */}
          {profilePhotoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element -- internal upload
            // served by /api/profile-photo; a plain <img> avoids next/image config.
            <img
              src={profilePhotoSrc}
              alt={seafarer.verifiedName ?? "Profile photo"}
              data-testid="verified-photo"
              className="h-16 w-16 flex-shrink-0 rounded-xl object-cover ring-1 ring-emerald-300"
            />
          ) : (
            <div
              data-testid="verified-photo-placeholder"
              aria-hidden="true"
              className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-lg font-bold text-emerald-700 ring-1 ring-emerald-300"
            >
              {profileInitials}
            </div>
          )}
          <div className="min-w-0">
            <span
              className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-semibold text-white"
              data-testid="verified-identity-badge"
            >
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Verified identity
            </span>
            <p className="mt-1 truncate text-lg font-bold text-slate-900" data-testid="verified-name">
              {seafarer.verifiedName}
            </p>
            {(seafarer.personalCode || seafarer.birthDate) && (
              <p className="mt-0.5 text-xs text-slate-600" data-testid="verified-details">
                {seafarer.personalCode ? `Personal code ${seafarer.personalCode}` : ""}
                {seafarer.personalCode && seafarer.birthDate ? " · " : ""}
                {seafarer.birthDate ? `Born ${fmtDate(seafarer.birthDate)}` : ""}
              </p>
            )}
            {seafarer.issuerCountry && (
              <p className="mt-0.5 text-xs text-slate-500" data-testid="verified-country">
                Issued by {seafarer.issuerCountry}
              </p>
            )}
            <p className="mt-1 text-[11px] text-emerald-700">
              From the government maritime registry — the authoritative record for this seafarer.
            </p>
            {/* Owner-only: change the profile picture, or revert to the verified photo. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <input
                ref={photoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                data-testid="profile-photo-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // Open the adjuster (crop/zoom/rotate) instead of uploading raw; the
                  // cropped canvas blob is what gets uploaded on Save.
                  if (f) {
                    setPhotoError(null);
                    setAdjustFile(f);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={photoBusy}
                data-testid="change-photo"
                className="text-xs font-semibold text-emerald-700 underline underline-offset-2 hover:text-emerald-800 disabled:opacity-60"
              >
                {photoBusy ? "Saving…" : "Change photo"}
              </button>
              {seafarer.customPhotoFile && seafarer.verifiedPhotoFile && (
                <button
                  type="button"
                  onClick={() => void resetProfilePhoto()}
                  disabled={photoBusy}
                  data-testid="use-verified-photo"
                  className="text-xs font-medium text-slate-500 underline underline-offset-2 hover:text-slate-700 disabled:opacity-60"
                >
                  Use verified photo
                </button>
              )}
            </div>
            {photoError && (
              <p className="mt-1 text-[11px] text-red-600" data-testid="profile-photo-error">
                {photoError}
              </p>
            )}
            {adjustFile && (
              <ProfilePhotoAdjuster
                file={adjustFile}
                busy={photoBusy}
                onSave={(blob) => void uploadProfilePhoto(blob)}
                onCancel={() => {
                  setAdjustFile(null);
                  setPhotoError(null);
                  if (photoInputRef.current) photoInputRef.current.value = "";
                }}
              />
            )}
            {/* Owner-only, unobtrusive: remove the verified profile data when NO
                government-verified document backs it any more (all documents, or the
                verified one specifically, were deleted). Hidden while a verified doc
                still backs the identity. Clearing falls the header back to the typed/
                Google name; the backfill will not repopulate with no verified doc. */}
            {!hasGovernmentDoc && (
              <div className="mt-2 border-t border-emerald-200/70 pt-2" data-testid="remove-verified-identity">
                {confirmClearIdentity ? (
                  <span className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-slate-600">Remove your verified profile data?</span>
                    <button
                      type="button"
                      onClick={() => void clearVerifiedIdentity()}
                      disabled={clearingIdentity}
                      data-testid="remove-verified-confirm"
                      className="font-semibold text-red-600 underline underline-offset-2 hover:text-red-700 disabled:opacity-60"
                    >
                      {clearingIdentity ? "Removing…" : "Remove"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClearIdentity(false)}
                      disabled={clearingIdentity}
                      className="text-slate-500 underline underline-offset-2 hover:text-slate-700 disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmClearIdentity(true)}
                    data-testid="remove-verified-identity-button"
                    className="text-[11px] font-medium text-slate-400 underline underline-offset-2 hover:text-slate-600"
                  >
                    Remove verified profile
                  </button>
                )}
                <p className="mt-1 text-[11px] text-slate-400">
                  No verified document backs this any more — you can clear the registry identity above.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Anonymous owner: offer to sign in and SAVE this profile so it opens on any
          device. Adoption links THIS local profile (its share token is read by both
          sign-in components) rather than creating a new one, so the seaman keeps what
          they added. feat/password-signup Step 7: password accounts adopt claim-links
          and anonymous profiles identically, so the banner shows whenever EITHER
          sign-in option is available. */}
      {!signedIn && (googleEnabled || passwordEnabled) && (
        <div
          className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          data-testid="seaman-signin-banner"
        >
          <p className="text-sm font-semibold text-slate-800">
            {claimMode
              ? "This is your profile — claim it"
              : "Save this profile to your account"}
          </p>
          <p className="mb-3 mt-0.5 text-xs text-slate-500">
            {claimMode
              ? "This profile was prepared for you. Sign in to claim it and add your certificates — everything already here stays with you."
              : "Sign in to open your profile and documents on any device. Everything you have added so far stays with you."}
          </p>
          {googleEnabled && (
            <SeamanGoogleSignIn
              label={
                claimMode
                  ? "This is me — sign in to add my certificates"
                  : "Sign in with Google to save your profile"
              }
            />
          )}
          {googleEnabled && passwordEnabled && (
            <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              {t("pw.or")}
              <span className="h-px flex-1 bg-slate-200" />
            </div>
          )}
          {passwordEnabled && (
            <div className={googleEnabled ? "" : "mt-1"}>
              <SeamanPasswordAuth
                claimMode={claimMode}
                onSignedIn={async () => {
                  await loadMe();
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* A signed-in user arrived via a claim link that is not theirs: the token
          was NOT adopted (invariant 7) — say so instead of silently ignoring it
          (fold 7). */}
      {signedIn && alreadyOwnedClaim && (
        <div
          className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          data-testid="pw-already-owned"
        >
          {t("pw.alreadyOwned")}
        </div>
      )}

      {/* Share link — Feature 1: unavailable until at least one document exists.
          Owner-only: hidden from not-signed-in link/claim visitors. */}
      {signedIn && (!hasAnyDocument ? (
        <div
          className="mt-6 rounded-2xl border border-dashed border-brand-300 bg-brand-50 p-4"
          data-testid="share-locked"
        >
          <p className="text-sm font-semibold text-brand-900">Your share links</p>
          <p className="mt-1 text-sm text-brand-800" data-testid="share-locked-msg">
            Upload a document first — then you&rsquo;ll get your two share links (open and private).
          </p>
        </div>
      ) : (
        <div className="mt-6" data-testid="share-section">
          {/* Collapsed by default: one compact row. Expands to reveal BOTH links
              (open + private) and the allowed-emails editor, mirroring the
              archived-docs collapse pattern below. */}
          <button
            type="button"
            onClick={() => setShowShare((v) => !v)}
            data-testid="share-toggle"
            aria-expanded={showShare}
            className="flex w-full items-center justify-between rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-left hover:bg-brand-100"
          >
            <span className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <svg
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                >
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
              </span>
              <span className="text-sm font-semibold text-brand-900">Share my documents</span>
            </span>
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`text-brand-400 transition-transform ${showShare ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showShare && (
          <div className="mt-2 space-y-4">
          {/* Intro — TWO independent links, both always active. */}
          <div className="rounded-2xl border border-brand-200 bg-brand-50 p-4">
            <p className="text-sm font-semibold text-brand-900">Your two share links</p>
            <p className="mt-1 text-xs text-brand-700">
              You have two separate links, and both work at the same time. Send whichever one
              fits: the <span className="font-semibold">open link</span> lets anyone who has it
              open your documents with no sign-in, while the{" "}
              <span className="font-semibold">private link</span> only opens for the specific
              people you list, after they sign in with Google. Each link has its own Reset below.
            </p>
          </div>

          {/* ---- OPEN LINK ------------------------------------------------- */}
          <div
            className="rounded-2xl border border-brand-200 bg-white p-4"
            data-testid="share-open-block"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <svg
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </span>
              <p className="text-sm font-semibold text-slate-900">
                Open link — anyone with the link
              </p>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Anyone you send this link to can open all your documents. No sign-in needed.
            </p>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                readOnly
                value={openShareUrl}
                data-testid="share-open-url"
                className="flex-1 rounded-lg border border-brand-200 bg-white px-3 py-2 font-mono text-xs text-slate-700"
              />
              <button
                type="button"
                onClick={() => copyLink("open", openShareUrl)}
                data-testid="share-open-copy"
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                {copied === "open" ? t("sd.copied") : t("sd.copy")}
              </button>
              <a
                href={openShareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-brand-300 bg-white px-4 py-2 text-center text-sm font-semibold text-brand-700 hover:bg-brand-50"
              >
                {t("sd.open")}
              </a>
            </div>

            {/* Reset is an owner control — hidden on the public sample render. */}
            {!sample && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              {confirmReset !== "open" ? (
                <div>
                  <button
                    type="button"
                    data-testid="reset-open-link"
                    onClick={() => {
                      setConfirmReset("open");
                      setResetNote(null);
                    }}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-800"
                  >
                    <svg
                      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    >
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    Reset this link
                  </button>
                  <p className="mt-1 text-xs text-slate-500">
                    Makes a new open link; the old open link stops working. Your private link is
                    not affected.
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-brand-800">
                    Reset the open link now? The current open link stops working immediately.
                  </span>
                  <button
                    type="button"
                    data-testid="reset-open-confirm"
                    onClick={() => resetLink("open")}
                    disabled={resetting === "open"}
                    className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                  >
                    {resetting === "open" ? "Resetting…" : "Yes, reset the open link"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(null)}
                    className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                  >
                    {t("sd.cancel")}
                  </button>
                </div>
              )}
              {resetNote?.which === "open" && (
                <p
                  data-testid="reset-open-note"
                  className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 ring-1 ring-brand-200"
                >
                  {resetNote.text}
                </p>
              )}
            </div>
            )}
          </div>

          {/* ---- PRIVATE (email) LINK ------------------------------------- */}
          <div
            className="rounded-2xl border border-brand-200 bg-white p-4"
            data-testid="share-email-block"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900 text-white">
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </span>
              <p className="text-sm font-semibold text-slate-900">
                Private link — only specific people (by email)
              </p>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Only the agents you list below can open this link, and only after they sign in with
              that Google account. The link on its own shows nothing.
            </p>

            {/* Sample mode: the private half is DISABLED (its token is redacted and
                never published) — tooltip explains; the open link above stays real. */}
            <div
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              title={sample ? "The private link is disabled in this sample." : undefined}
              data-testid={sample ? "share-email-disabled" : undefined}
            >
              <input
                readOnly
                disabled={sample}
                value={emailShareUrl}
                placeholder={sample ? "Private link — disabled in this sample" : undefined}
                data-testid="share-email-url"
                className="flex-1 rounded-lg border border-brand-200 bg-white px-3 py-2 font-mono text-xs text-slate-700 disabled:bg-slate-50 disabled:text-slate-400"
              />
              <button
                type="button"
                disabled={sample}
                title={sample ? "The private link is disabled in this sample." : undefined}
                onClick={() => copyLink("email", emailShareUrl)}
                data-testid="share-email-copy"
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {copied === "email" ? t("sd.copied") : t("sd.copy")}
              </button>
              {!sample && (
                <a
                  href={emailShareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-brand-300 bg-white px-4 py-2 text-center text-sm font-semibold text-brand-700 hover:bg-brand-50"
                >
                  {t("sd.open")}
                </a>
              )}
            </div>

            {/* Allowed-emails editor — who may open the private link. Owner control:
                hidden on the public sample render (the private half is disabled). */}
            {!sample && (
            <div
              className="mt-3 rounded-lg border border-brand-200 bg-brand-50/50 p-3"
              data-testid="allowed-emails"
            >
              <p className="text-xs font-medium text-slate-600">Allowed agent emails</p>
              {allowedEmails.length === 0 ? (
                <p className="mt-2 text-xs text-amber-700" data-testid="allowed-emails-empty">
                  No emails added yet — until you add one, nobody can open this private link.
                </p>
              ) : (
                <ul className="mt-2 space-y-1" data-testid="allowed-emails-list">
                  {allowedEmails.map((email) => (
                    <li
                      key={email}
                      className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5"
                    >
                      <span className="truncate text-xs text-slate-700">{email}</span>
                      <button
                        type="button"
                        onClick={() => removeAllowedEmail(email)}
                        disabled={savingShare}
                        data-testid="allowed-email-remove"
                        className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  type="email"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addAllowedEmail();
                    }
                  }}
                  placeholder="agent@example.com"
                  spellCheck={false}
                  data-testid="allowed-email-input"
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
                <button
                  type="button"
                  onClick={addAllowedEmail}
                  disabled={savingShare}
                  data-testid="allowed-email-add"
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  Add
                </button>
              </div>
              {shareError && (
                <p className="mt-2 text-xs text-rose-600" data-testid="share-error">
                  {shareError}
                </p>
              )}
            </div>
            )}

            {/* Reset is an owner control — hidden on the public sample render. */}
            {!sample && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              {confirmReset !== "email" ? (
                <div>
                  <button
                    type="button"
                    data-testid="reset-email-link"
                    onClick={() => {
                      setConfirmReset("email");
                      setResetNote(null);
                    }}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-800"
                  >
                    <svg
                      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    >
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    Reset this link
                  </button>
                  <p className="mt-1 text-xs text-slate-500">
                    Makes a new private link; the old private link stops working. Your open link
                    and your allowed-emails list are not affected.
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-brand-800">
                    Reset the private link now? The current private link stops working immediately.
                  </span>
                  <button
                    type="button"
                    data-testid="reset-email-confirm"
                    onClick={() => resetLink("email")}
                    disabled={resetting === "email"}
                    className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                  >
                    {resetting === "email" ? "Resetting…" : "Yes, reset the private link"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(null)}
                    className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                  >
                    {t("sd.cancel")}
                  </button>
                </div>
              )}
              {resetNote?.which === "email" && (
                <p
                  data-testid="reset-email-note"
                  className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 ring-1 ring-brand-200"
                >
                  {resetNote.text}
                </p>
              )}
            </div>
            )}
          </div>
          </div>
          )}
        </div>
      ))}

      {/* Expiry reminders — owner-editable reminder timing + an importable .ics of
          per-document expiry reminders. Unavailable until at least one document exists
          (like the share box). Same compact-toggle collapse pattern. */}
      {signedIn && hasAnyDocument && (
        <div className="mt-6" data-testid="reminders-section">
          <button
            type="button"
            onClick={() => setShowReminders((v) => !v)}
            data-testid="reminders-toggle"
            aria-expanded={showReminders}
            className="flex w-full items-center justify-between rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-left hover:bg-brand-100"
          >
            <span className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <svg
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </span>
              <span className="text-sm font-semibold text-brand-900">Expiry reminders</span>
            </span>
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`text-brand-400 transition-transform ${showReminders ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showReminders && (
            <div className="mt-2 space-y-4" data-testid="reminders-body">
              {/* Intro */}
              <div className="rounded-2xl border border-brand-200 bg-brand-50 p-4">
                <p className="text-sm font-semibold text-brand-900">
                  Never miss a renewal
                </p>
                <p className="mt-1 text-xs text-brand-700">
                  Add reminders for your document expiry dates to your calendar (Google Calendar
                  or any calendar). Choose the timing below, then download the calendar file and
                  open it — each reminder is added as an all-day event.
                </p>
              </div>

              {/* Dynamic settings */}
              <div
                className="rounded-2xl border border-brand-200 bg-white p-4"
                data-testid="reminder-settings"
              >
                <p className="text-sm font-semibold text-slate-900">Reminder timing</p>
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {/* First reminder: value + unit */}
                  <div>
                    <label className="text-xs font-medium text-slate-500">First reminder</label>
                    <div className="mt-1 flex gap-2">
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={reminderSettings.leadValue}
                        disabled={savingReminders}
                        data-testid="reminder-lead-value"
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (!Number.isNaN(v)) void saveReminderSettings({ leadValue: v });
                        }}
                        className="w-16 rounded-lg border border-slate-300 px-2 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      />
                      <select
                        value={reminderSettings.leadUnit}
                        disabled={savingReminders}
                        data-testid="reminder-lead-unit"
                        onChange={(e) =>
                          void saveReminderSettings({ leadUnit: e.target.value as ReminderUnit })
                        }
                        className="flex-1 rounded-lg border border-slate-300 px-2 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      >
                        <option value="months">months</option>
                        <option value="weeks">weeks</option>
                        <option value="days">days</option>
                      </select>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">before each expiry</p>
                  </div>

                  {/* How many reminders */}
                  <div>
                    <label className="text-xs font-medium text-slate-500">How many reminders</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={reminderSettings.count}
                      disabled={savingReminders}
                      data-testid="reminder-count"
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (!Number.isNaN(v)) void saveReminderSettings({ count: v });
                      }}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                    <p className="mt-1 text-[11px] text-slate-400">per document</p>
                  </div>

                  {/* Repeat every N days */}
                  <div>
                    <label className="text-xs font-medium text-slate-500">Repeat every</label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={365}
                        value={reminderSettings.intervalDays}
                        disabled={savingReminders}
                        data-testid="reminder-interval"
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (!Number.isNaN(v)) void saveReminderSettings({ intervalDays: v });
                        }}
                        className="w-20 rounded-lg border border-slate-300 px-2 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      />
                      <span className="text-sm text-slate-500">days</span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">until the expiry day</p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-slate-400">
                  A reminder whose date has already passed is created for today, so a document
                  that is already due is reminded right away.
                </p>
              </div>

              {/* Which documents get reminders */}
              <div
                className="rounded-2xl border border-slate-200 bg-white p-4"
                data-testid="reminder-preview"
              >
                {reminderPreview.length === 0 ? (
                  <p className="text-xs text-amber-700" data-testid="reminder-none">
                    No dated documents yet. Once a document has a confirmed expiry date, its
                    reminders will show up here.
                  </p>
                ) : (
                  <>
                    <p className="text-sm font-semibold text-slate-900">
                      Documents with reminders{" "}
                      <span className="font-normal text-slate-400">
                        ({reminderPreview.length} · {totalReminderEvents} events)
                      </span>
                    </p>
                    <ul className="mt-2 space-y-1.5" data-testid="reminder-doc-list">
                      {reminderPreview.map(({ doc, dates }) => (
                        <li
                          key={doc.id}
                          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-lg bg-slate-50 px-3 py-2"
                        >
                          <span className="truncate text-xs font-medium text-slate-700">
                            {doc.title}
                          </span>
                          <span className="text-[11px] text-slate-500">
                            expires {fmtDate(doc.validUntil)} · {dates.length} reminder
                            {dates.length === 1 ? "" : "s"} (first {fmtReminderDate(dates[0])})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              {/* Add to calendar */}
              <div className="rounded-2xl border border-brand-200 bg-white p-4">
                <a
                  href={reminderPreview.length > 0 ? calendarUrl : undefined}
                  download="docka-reminders.ics"
                  aria-disabled={reminderPreview.length === 0}
                  data-testid="reminder-download"
                  className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold text-white shadow-sm ${
                    reminderPreview.length > 0
                      ? "bg-brand-600 hover:bg-brand-700"
                      : "pointer-events-none bg-slate-300"
                  }`}
                >
                  <svg
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Add to my calendar
                </a>
                <p className="mt-2 text-xs text-slate-500">
                  Downloads a calendar file (.ics). To add it to{" "}
                  <span className="font-medium text-slate-700">Google Calendar</span>: open{" "}
                  Google Calendar on a computer, click the settings gear then{" "}
                  <span className="whitespace-nowrap">Settings → Import &amp; export</span>, choose
                  this file and import. On a phone, open the downloaded file and your calendar app
                  will offer to add the events.
                </p>

                {/* Optional subscribe URL */}
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <p className="text-xs font-medium text-slate-600">Calendar link (advanced)</p>
                  <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                    <input
                      readOnly
                      value={webcalUrl}
                      data-testid="reminder-webcal-url"
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!webcalUrl) return;
                        navigator.clipboard.writeText(webcalUrl).then(() => {
                          setRemindersCopied(true);
                          setTimeout(() => setRemindersCopied(false), 1800);
                        });
                      }}
                      data-testid="reminder-copy-url"
                      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      {remindersCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Some calendar apps can subscribe to this link and refresh the reminders
                    automatically. Keep it private — anyone with the link can see your reminders.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add-documents area — photo upload + add-by-code, together in ONE collapsible.
          A brand-new seaman (zero docs) sees it EXPANDED so the upload prompt is
          obvious; once they hold ≥1 document it collapses to a compact "Add more
          documents" toggle. All upload functionality is intact, just behind the fold. */}
      {signedIn && (
      <div id="add-documents" className="mt-8 scroll-mt-4" data-testid="add-docs-section">
        {hasAnyDocument && (
          <button
            type="button"
            onClick={() => setAddOpen(!addExpanded)}
            data-testid="add-docs-toggle"
            aria-expanded={addExpanded}
            className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm hover:bg-slate-50"
          >
            <span className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <svg
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              <span className="text-sm font-semibold text-slate-900">Add more documents</span>
            </span>
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`text-slate-400 transition-transform ${addExpanded ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        {addExpanded && (
        <div className={hasAnyDocument ? "mt-2 space-y-8" : "space-y-8"}>
      {/* Mass upload — many photos at once */}
      <div>
        <MassUpload
          seafarerId={seafarer.id}
          shareToken={seafarer.shareToken}
          initialFiles={bootFiles}
          onAdded={(d) => setDocuments((prev) => [...prev, d])}
          // Type-based auto-clear may have ticked a checklist item off — adopt the
          // fresh checklist the POST returned so the to-do list reacts immediately.
          onRequestsChanged={(reqs) => setDocRequests(reqs)}
        />
      </div>

      {/* Add document — one tap (code-first) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="font-semibold text-slate-900">{t("sd.addByCodeTitle")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("sd.addByCodeSub")}</p>
        <form onSubmit={addDocument} className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-500">{t("sd.codeLabel")}</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. A1B2C3D4E5F6G7H8 or a full certificate URL"
              spellCheck={false}
              data-testid="code-input"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          {formError && <p className="text-sm text-rose-600">{formError}</p>}
          {/* §5.2 multi-key prompt: the registry needs more keys than the code. */}
          {registryPrompt?.kind === "needs-inputs" && (
            <div
              data-testid="doc-needs-inputs"
              className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
                {registryPrompt.country.countryName} — {registryPrompt.country.authority}
              </p>
              <p className="mt-1">A couple more details are needed to check this certificate:</p>
              <div className="mt-2 space-y-2">
                {registryPrompt.missing.map((f) => (
                  <div key={f.key} className="flex items-center gap-2">
                    <label className="w-40 flex-shrink-0 text-xs font-medium text-sky-800">
                      {f.label}
                    </label>
                    <input
                      data-testid={`doc-registry-input-${f.key}`}
                      type={f.key === "dob" ? "date" : "text"}
                      value={registryVals[f.key] ?? ""}
                      onChange={(e) =>
                        setRegistryVals((v) => ({ ...v, [f.key]: e.target.value }))
                      }
                      className="min-w-0 flex-1 rounded-lg border border-sky-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500"
                      spellCheck={false}
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                data-testid="doc-registry-inputs-submit"
                disabled={
                  submitting ||
                  // Optional keys (FR numeroVersion) never gate the lookup (§5.2).
                  registryPrompt.missing.some(
                    (f) => !f.optional && !(registryVals[f.key] ?? "").trim()
                  )
                }
                onClick={() =>
                  void submitDoc({
                    countryOverride: registryPrompt.countryOverride,
                    inputs: registryVals,
                  })
                }
                className="mt-3 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
              >
                Check the certificate
              </button>
              <p className="mt-2 text-xs text-sky-800/80">
                Sensitive details are used only for the lookup — never stored.
              </p>
            </div>
          )}
          {/* §2.3 ambiguous code: the ONLY country dropdown in the flow. */}
          {registryPrompt?.kind === "ambiguous" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p>
                {registryPrompt.unmatched
                  ? "This code didn’t match any registry automatically — pick the issuing country and we’ll take it from there:"
                  : "This code could belong to more than one registry — pick the issuing country:"}
              </p>
              <select
                data-testid="doc-country-picker"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) void submitDoc({ countryOverride: e.target.value });
                }}
                className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-500"
              >
                <option value="" disabled>
                  Select the issuing country…
                </option>
                {registryPrompt.candidates.map((cc) => (
                  <option key={cc} value={cc}>
                    {countryEntry(cc)?.countryName ?? cc}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* §2.5 rule 3 — first-set holder confirmation, never a silent name. */}
          {registryPrompt?.kind === "confirm-holder" && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              <p>
                The registry lists this certificate as issued to{" "}
                <span className="font-semibold">{registryPrompt.holderName}</span>. Is that you?
              </p>
              <button
                type="button"
                data-testid="holder-confirm-doc"
                disabled={submitting}
                onClick={() =>
                  void submitDoc({
                    countryOverride: registryPrompt.countryOverride,
                    inputs: registryPrompt.inputs,
                    holderConfirmed: true,
                  })
                }
                className="mt-2 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
              >
                Yes, this is me — save the certificate
              </button>
            </div>
          )}
          {justAdded && (
            <div
              className={`rounded-xl border px-4 py-3 text-sm ${
                justAdded.docCategory
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-amber-200 bg-amber-50"
              }`}
            >
              <p
                className={`font-semibold ${
                  justAdded.docCategory ? "text-emerald-800" : "text-amber-800"
                }`}
              >
                {justAdded.docCategory ? "Added & verified" : "File saved"}
              </p>
              <p className={`mt-0.5 ${justAdded.docCategory ? "text-emerald-700" : "text-amber-700"}`}>
                {justAdded.title}
                {justAdded.validUntil ? ` · valid until ${fmtDate(justAdded.validUntil)}` : ""}
              </p>
              {justNote && (
                <p className={`mt-1 text-xs ${justAdded.docCategory ? "text-emerald-600" : "text-amber-600"}`}>
                  {justNote}
                </p>
              )}
            </div>
          )}
          {!justAdded && justNote && (
            <p
              data-testid="dedupe-note"
              className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
            >
              {justNote}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            data-testid="add-doc-submit"
            className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {submitting ? t("sc.verifying") : t("sd.addVerify")}
          </button>
        </form>
      </div>
        </div>
        )}
      </div>
      )}

      {/* Agent's document-request checklist — what to supply, and by when. Renders
          only when an agent has actually asked for something. Uploading each item
          ticks it off automatically. */}
      {signedIn && docRequests.some((r) => r.status === "pending") && (
        <div className="mt-8">
          <DocRequestChecklist
            requests={docRequests}
            // Interactive mode: per-row upload straight into the requested item.
            seafarerId={seafarer.id}
            shareToken={seafarer.shareToken}
            onUploaded={(resp) => {
              // A fresh (non-duplicate) doc joins the list; a duplicate is already
              // there, so skip it. Either way adopt the returned checklist.
              if (resp.document && !resp.duplicate) {
                setDocuments((prev) => [...prev, resp.document as Doc]);
              }
              if (resp.docRequests) setDocRequests(resp.docRequests);
            }}
          />
        </div>
      )}

      {/* #41 item 18 — assignment-scoped employment doc-set checklist + own-SEA download. */}
      {signedIn && (
      <div className="mt-8">
        <SeamanEmployment seafarer={seafarer} documents={documents} flows={flows} />
      </div>
      )}

      {/* #43 item 11 — appraisals filed about the seaman (projection: ratings + recommend only). */}
      {signedIn && (
      <div className="mt-8">
        <SeamanAppraisals token={seafarer.shareToken} />
      </div>
      )}

      {/* Sea-service ledger — the digital discharge book. Seaman self-service via the
          owner share token; accumulated sea time is computed server-side.
          Owner-only: hidden from not-signed-in link/claim visitors. */}
      {signedIn && (
        <SeaServiceLedger
          seafarerId={seafarer.id}
          initialEntries={seaService}
          token={seafarer.shareToken}
          documents={documents}
          holderDOB={seafarer.birthDate ?? null}
        />
      )}

      {/* Document list (active) */}
      {signedIn && (
      <div className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">
            {t("sd.docsTitle")}{" "}
            <span className="text-sm font-normal text-slate-400">({activeDocuments.length})</span>
          </h2>
          {hasAnyDocument && (
            <button
              type="button"
              data-testid="open-cv"
              onClick={() => setShowCv(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="16" y2="17" />
              </svg>
              CV / certificate matrix
            </button>
          )}
        </div>
        {showCv && (
          <CvMatrix
            seafarer={seafarer}
            documents={documents}
            onClose={() => setShowCv(false)}
            printableUrl={`/api/cv/${encodeURIComponent(seafarer.id)}?token=${encodeURIComponent(
              seafarer.shareToken
            )}`}
          />
        )}

        {/* Auto-archive setting — opt-in, off by default. Sits right above the list. */}
        <label
          className="mt-3 flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
          data-testid="auto-archive-toggle"
        >
          <input
            type="checkbox"
            checked={seafarer.autoArchiveExpired === true}
            disabled={savingAutoArchive}
            onChange={(e) => setAutoArchive(e.target.checked)}
            data-testid="auto-archive-checkbox"
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm text-slate-600">
            <span className="font-medium text-slate-800">
              Automatically archive documents once they expire
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Expired documents move to the archive below. Documents with no expiry date
              are never archived. You can always unarchive a document.
            </span>
          </span>
        </label>

        {activeDocuments.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400">
            {t("sd.docsNone")}
          </p>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="doc-list">
            {activeDocuments.map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                shareToken={seafarer.shareToken}
                onUpdate={(u) =>
                  setDocuments((prev) => prev.map((x) => (x.id === u.id ? u : x)))
                }
                onDeleted={onDocDeleted}
                onUnarchive={onDocUnarchived}
              />
            ))}
          </ul>
        )}
      </div>
      )}

      {/* Archived documents — collapsible, still viewable and unarchivable. */}
      {signedIn && archivedDocuments.length > 0 && (
        <div className="mt-6" data-testid="archived-section">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            data-testid="archived-toggle"
            aria-expanded={showArchived}
            className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left hover:bg-slate-100"
          >
            <span className="text-sm font-semibold text-slate-700">
              Archived documents{" "}
              <span className="font-normal text-slate-400">({archivedDocuments.length})</span>
            </span>
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`text-slate-400 transition-transform ${showArchived ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showArchived && (
            <ul className="mt-2 space-y-2" data-testid="archived-list">
              {archivedDocuments.map((d) => (
                <DocRow
                  key={d.id}
                  doc={d}
                  shareToken={seafarer.shareToken}
                  onUpdate={(u) =>
                    setDocuments((prev) => prev.map((x) => (x.id === u.id ? u : x)))
                  }
                  onDeleted={onDocDeleted}
                  onUnarchive={onDocUnarchived}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Self-service personal / next-of-kin / bank details — proposed changes go to
          the seaman's agent for approval before they take effect (roadmap T1.7).
          Owner-only (sensitive; also carries the docka-verified directory opt-in
          toggle): hidden from not-signed-in link/claim visitors. */}
      {signedIn && (
        <ProfileSelfService
          seafarerId={seafarer.id}
          token={seafarer.shareToken}
          profile={seafarer.selfProfile ?? {}}
          changes={profileChanges}
          onChanges={setProfileChanges}
          directoryOptIn={seafarer.directoryOptIn === true}
          identityVerified={seafarer.identityVerified === true}
          onSeafarer={setSeafarer}
        />
      )}

      {/* My applications — per-agency flow status (read-only). Rendered before the
          Access & reviews section so "where I am with each agency" comes first.
          Owner-only: hidden from not-signed-in link/claim visitors. */}
      {signedIn && (
        <SeamanFlows
          flows={flows}
          seafarerId={seafarer.id}
          token={seafarer.shareToken}
          requests={propagationRequests}
          appraisalDeleteRequests={appraisalDeleteRequests}
        />
      )}

      {/* Access & reviews — who has seen/reviewed my documents, and revoke control.
          Owner-only: hidden from not-signed-in link/claim visitors. Hidden on the
          public sample render too — its API is session-scoped (an anonymous read
          would only render an error box) and revoke is an owner decision. */}
      {signedIn && !sample && <AccessReviews seafarerId={seafarer.id} />}
    </div>
  );
}
