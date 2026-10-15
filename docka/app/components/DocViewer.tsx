"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Doc, Seafarer } from "@/lib/db";
import { docStatusForDoc, docBadgeForDoc, CHECKED_AGAINST_REGISTRY_LABEL } from "@/lib/cert";
import { countryEntry } from "@/lib/registry/countries";
import { StatusBadge } from "@/components/StatusBadge";
import { DocImage } from "@/components/DocImage";
import { RegistryAgentActions } from "@/components/RegistryInfo";
import { VerifyQr } from "@/components/VerifyQr";

// A full-screen document viewer + inline verification panel.
//
// The reviewer clicks a document's image, SEES the actual certificate large
// enough to read, and — right beside it — verifies the name and expiry date.
//   • government docs   -> details are READ-ONLY, keep the emerald verified badge.
//   • photo/manual docs -> editable name + expiry and a primary "Confirm details"
//                          button that saves via PATCH /api/documents and marks
//                          the doc reviewer-checked (a DISTINCT blue label, never
//                          the green government-verified state).
//
// Layout is a single full-screen flex overlay (no nested position:fixed that
// could break inside a PDF iframe). Closes on Esc + backdrop click, and traps
// Tab focus within the dialog.

function isImageFile(name?: string | null): boolean {
  return !!name && /\.(jpe?g|png|webp|gif|bmp)$/i.test(name);
}
function isPdfFile(name?: string | null): boolean {
  return !!name && /\.pdf$/i.test(name);
}
function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function dateInputValue(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
// Breathing room (px, each edge) kept between the fitted image and the frame.
const FIT_PADDING = 16;

/**
 * The rotated + zoomable image surface for the viewer's left pane.
 *
 * The old version fit the image with `object-contain` (max-w/max-h) and applied
 * `rotate()` on top. CSS rotation does NOT change an element's layout box, so the
 * browser fit the image by its UNROTATED width/height — at 90°/270° the visual
 * footprint swaps and the image overflowed the frame, forcing the user to zoom
 * out by hand, and zoom (a wrapper width %) fought the rotation.
 *
 * This version measures the frame and the image's intrinsic size, then computes an
 * exact fit scale using the ROTATION-SWAPPED content box (rotated width = natural
 * height at 90°/270°). zoom = 1 (== 100% == "Reset") always means fit-to-frame for
 * the current orientation. The scale (fit × zoom) is baked into the image's pixel
 * width/height, and a wrapper sized to the rotated visual footprint gives correct
 * centering AND real scroll/pan when zoomed in — at any rotation. Rotating recomputes
 * the fit while the chosen zoom is preserved.
 */
function RotatableImage({
  src,
  alt,
  rotation,
  zoom,
  testId,
}: {
  src: string;
  alt: string;
  rotation: number;
  zoom: number;
  testId?: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // Track the frame's live inner size so fit recomputes on resize / panel reflow.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrame({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rotated = ((rotation % 180) + 180) % 180 !== 0; // true at 90° / 270°

  let box: CSSProperties | null = null;
  let imgStyle: CSSProperties;

  if (frame && natural) {
    const availW = Math.max(1, frame.w - FIT_PADDING * 2);
    const availH = Math.max(1, frame.h - FIT_PADDING * 2);
    // Content box AFTER rotation: 90°/270° swap width and height.
    const contentW = rotated ? natural.h : natural.w;
    const contentH = rotated ? natural.w : natural.h;
    const fitScale = Math.min(availW / contentW, availH / contentH);
    const scale = fitScale * zoom; // 100% (zoom=1) === fit-to-frame for this orientation
    const imgW = natural.w * scale;
    const imgH = natural.h * scale;
    // Wrapper takes the rotated footprint so the scroll area + centering are correct.
    const visualW = rotated ? imgH : imgW;
    const visualH = rotated ? imgW : imgH;
    box = { position: "relative", width: visualW, height: visualH, margin: "auto" };
    imgStyle = {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: imgW,
      height: imgH,
      maxWidth: "none",
      maxHeight: "none",
      // Compose rotation with the fit×zoom scale (baked into width/height); center it.
      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
      transformOrigin: "center center",
    };
  } else {
    // Pre-measurement first paint: contain-fit + rotate so nothing flashes clipped.
    imgStyle = {
      transform: `rotate(${rotation}deg) scale(${zoom})`,
      transformOrigin: "center center",
    };
  }

  return (
    // `flex` + child `margin:auto` centers when the image fits AND stays fully
    // scrollable when zoomed past the frame (avoids the justify-center clip bug).
    <div ref={frameRef} className="flex min-h-0 flex-1 overflow-auto p-4">
      {box ? (
        <div style={box}>
          <DocImage
            src={src}
            alt={alt}
            testId={testId}
            onNaturalSize={setNatural}
            style={imgStyle}
            className="rounded-lg bg-white object-contain shadow"
          />
        </div>
      ) : (
        <DocImage
          src={src}
          alt={alt}
          testId={testId}
          onNaturalSize={setNatural}
          style={imgStyle}
          className="m-auto max-h-full max-w-full rounded-lg bg-white object-contain shadow"
        />
      )}
    </div>
  );
}

export function DocViewer({
  doc,
  onClose,
  onUpdate,
  reviewer = false,
  reviewerName = "",
  seafarer,
  viewOnly = false,
  fileToken,
}: {
  doc: Doc;
  onClose: () => void;
  /** Receives the updated document after a save. */
  onUpdate?: (d: Doc) => void;
  /** True on the agent review surface: enables the "Confirm details" sign-off. */
  reviewer?: boolean;
  /** Reviewer name recorded on the audit trail when confirming. */
  reviewerName?: string;
  /**
   * Owner profile (agent review surface only) — feeds the §5.3 registry-check
   * prefill fallback chain (verifiedName → declared name / birthDate).
   */
  seafarer?: Seafarer;
  /**
   * VIEW-ONLY variant (agent's shared /share/<token> view). Left side is
   * identical — full image + zoom + "Open original". The right panel becomes
   * read-only: name / expiry / status shown as text (never inputs), header
   * "Document details", and NO Confirm/Save button or save helper text. An agent
   * must never edit the seafarer's name or expiry from the shared view.
   */
  viewOnly?: boolean;
  /**
   * Seafarer/share-context share token. When set, the file request is authorised
   * as the document owner's own view; when omitted (agent surface) the agent
   * session + grant scope authorises. The URL always carries the opaque document
   * ID, never a filename — the server resolves the ref to the file.
   */
  fileToken?: string;
}) {
  const fileUrl = doc.fileName
    ? `/api/files/${doc.id}${fileToken ? `?token=${encodeURIComponent(fileToken)}` : ""}`
    : null;
  const editable = doc.source !== "government";
  // F10d — name the ACTUAL answering authority ("Verified against
  // Søfartsstyrelsen — Danish Maritime Authority"), never a generic phrase,
  // when the doc carries its registry country.
  const authorityName =
    (doc.registryCountry ? countryEntry(doc.registryCountry)?.authority : undefined) ??
    "the government registry";

  const [titleInput, setTitleInput] = useState(doc.title);
  const [dateInput, setDateInput] = useState(dateInputValue(doc.validUntil));
  // Feature 3 "No end date" — a perpetual document has no expiry. Editable
  // (non-government) docs only; initialised from the stored flag. When on, the
  // date input is cleared/disabled and the PATCH carries noExpiry:true.
  const [noExpiry, setNoExpiry] = useState<boolean>(doc.noExpiry === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // Owner-set display rotation (0|90|180|270). Applied to the image in EVERY mode;
  // the rotate controls that change it are shown only to the owner (see canRotate).
  const [rotation, setRotation] = useState<number>(doc.rotation ?? 0);

  // Only the document OWNER (seaman-side editable viewer) may change rotation. The
  // view-only share viewer and the agent review viewer APPLY the stored rotation
  // but never expose the rotate controls.
  const canRotate = !viewOnly && !reviewer;

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc to close + a simple Tab focus trap within the dialog. Restore focus to
  // the element that opened the viewer on unmount.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    // Lock body scroll behind the overlay.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  async function save(opts: { confirmReviewer: boolean }) {
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      const body: Record<string, unknown> = {
        documentId: doc.id,
        title: titleInput.trim() || doc.title,
        // Empty string clears the expiry server-side; a value marks it confirmed.
        validUntil: dateInput || "",
        // Feature 3 — the perpetual "no end date" flag. Editable (non-government)
        // docs only; noExpiry:true clears validUntil + marks valid server-side.
        ...(editable ? { noExpiry } : {}),
        // Seaman self-service authorisation: the owner share token, when this viewer
        // is opened in the seafarer/share context. Undefined on the agent side, where
        // the signed-in agent session + live grant authorise the edit instead.
        ...(fileToken ? { token: fileToken } : {}),
      };
      if (opts.confirmReviewer) {
        body.reviewerChecked = true;
        if (reviewerName.trim()) body.checkedBy = reviewerName.trim();
      }
      const res = await fetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        onUpdate?.(data.document as Doc);
        setSavedNote(
          opts.confirmReviewer ? "Confirmed — recorded as checked by reviewer." : "Details saved."
        );
      } else {
        setError(data.error ?? "Could not save.");
      }
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  // Rotate the image a quarter-turn and persist it immediately (owner only). The
  // rotation is stored via the SAME PATCH /api/documents the name/expiry edits use
  // — owner-share-token authorised in the share/seaman context. Optimistic: the UI
  // turns at once; a failed save just leaves the last-saved rotation on reload.
  async function rotateBy(deltaDeg: number) {
    const next = (((rotation + deltaDeg) % 360) + 360) % 360;
    setRotation(next);
    try {
      const res = await fetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: doc.id,
          rotation: next,
          ...(fileToken ? { token: fileToken } : {}),
        }),
      });
      const data = await res.json();
      if (data.ok) onUpdate?.(data.document as Doc);
    } catch {
      /* keep the optimistic rotation; it re-syncs from the server on next load */
    }
  }

  // Honest status pill for the details panel.
  function statusPill() {
    if (doc.source === "government") {
      const s = docStatusForDoc(doc, doc.validUntil);
      return <StatusBadge status={s === "unknown" ? "valid" : s} label="Government-verified" />;
    }
    if (doc.source === "registry") {
      // Teal "registry-confirmed — holder not verified" (plan §5.1); the expiry
      // warning outranks the teal inside docBadge.
      const b = docBadgeForDoc({
        verified: false,
        validUntil: doc.validUntil,
        expiryConfirmed: doc.expiryConfirmed,
        source: doc.source,
        noExpiry: doc.noExpiry,
      });
      return <StatusBadge status={b.status} label={b.label} />;
    }
    if (doc.reviewerChecked) {
      return (
        <StatusBadge
          status="checked"
          label={
            doc.checkedVia === "registry-portal"
              ? CHECKED_AGAINST_REGISTRY_LABEL
              : "Checked by reviewer"
          }
        />
      );
    }
    const b = docBadgeForDoc({
      verified: false,
      validUntil: doc.validUntil,
      expiryConfirmed: doc.expiryConfirmed,
      source: doc.source,
      manualRequested: doc.manualVerification?.status === "requested",
      noExpiry: doc.noExpiry,
    });
    return <StatusBadge status={b.status} label={b.label} />;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/70 p-0 sm:p-4"
      onMouseDown={(e) => {
        // Backdrop click (outside the dialog) closes.
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="doc-viewer-overlay"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Document viewer — ${doc.title}`}
        data-testid="doc-viewer"
        className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-none bg-white shadow-xl sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{doc.title}</p>
            <p className="text-xs text-slate-400">
              {doc.source === "government"
                ? "Government-verified document"
                : doc.source === "photo"
                  ? "Photo — not government-verified"
                  : "Uploaded document"}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            data-testid="doc-viewer-close"
            aria-label="Close document viewer"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        {/* Body: document on the left, verification panel on the right */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Document */}
          <div className="flex min-h-0 flex-1 flex-col bg-slate-100">
            {isImageFile(doc.fileName) && fileUrl ? (
              <>
                <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))}
                    data-testid="doc-viewer-zoom-out"
                    aria-label="Zoom out"
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    −
                  </button>
                  <span className="w-12 text-center text-xs font-medium text-slate-500">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
                    data-testid="doc-viewer-zoom-in"
                    aria-label="Zoom in"
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom(1)}
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50"
                  >
                    Reset
                  </button>
                  {canRotate && (
                    <>
                      <button
                        type="button"
                        onClick={() => rotateBy(-90)}
                        data-testid="doc-viewer-rotate-left"
                        aria-label="Rotate left"
                        title="Rotate left"
                        className="rounded-md border border-slate-300 px-2.5 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                      >
                        ⤺
                      </button>
                      <button
                        type="button"
                        onClick={() => rotateBy(90)}
                        data-testid="doc-viewer-rotate-right"
                        aria-label="Rotate right"
                        title="Rotate right"
                        className="rounded-md border border-slate-300 px-2.5 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                      >
                        ⤻
                      </button>
                    </>
                  )}
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Open original
                  </a>
                </div>
                <RotatableImage
                  src={fileUrl}
                  alt={doc.title}
                  rotation={rotation}
                  zoom={zoom}
                  testId="doc-viewer-image"
                />
              </>
            ) : isPdfFile(doc.fileName) && fileUrl ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Open PDF in new tab
                  </a>
                  <a
                    href={fileUrl}
                    download={doc.originalName ?? doc.fileName ?? undefined}
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Download
                  </a>
                </div>
                <object
                  data={fileUrl}
                  type="application/pdf"
                  data-testid="doc-viewer-pdf"
                  className="min-h-0 flex-1"
                  aria-label={doc.title}
                >
                  <iframe src={fileUrl} title={doc.title} className="h-full w-full" />
                </object>
              </div>
            ) : fileUrl ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <p className="text-sm text-slate-500">
                  This file can’t be previewed inline.
                </p>
                <div className="flex gap-2">
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    Open file
                  </a>
                  <a
                    href={fileUrl}
                    download={doc.originalName ?? doc.fileName ?? undefined}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Download
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-sm text-slate-400">
                No file attached to this document.
              </div>
            )}
          </div>

          {/* Verification / details panel */}
          <div className="w-full shrink-0 overflow-y-auto border-t border-slate-200 bg-white p-5 md:w-96 md:border-l md:border-t-0">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">
                {viewOnly ? "Document details" : "Verify details"}
              </h3>
              {statusPill()}
            </div>

            {viewOnly ? (
              // VIEW-ONLY (agent shared view): name / expiry / status as read-only
              // text. No inputs, no Confirm/Save, no save helper. The status pill
              // above already carries the government-verified vs not state; the
              // trust note below restates it in words, read-only.
              <div className="mt-4 space-y-3" data-testid="doc-viewer-readonly">
                <div>
                  <p className="text-xs font-medium text-slate-500">Document name</p>
                  <p className="mt-0.5 font-semibold text-slate-900" data-testid="doc-viewer-name">
                    {doc.title}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500">Valid until</p>
                  <p className="mt-0.5 font-semibold text-slate-900" data-testid="doc-viewer-date">
                    {fmtDate(doc.validUntil) || "—"}
                  </p>
                </div>
                {doc.holderName && (
                  <div>
                    <p className="text-xs font-medium text-slate-500">Holder</p>
                    <p className="mt-0.5 text-sm text-slate-700">{doc.holderName}</p>
                  </div>
                )}
                {doc.source === "government" ? (
                  <>
                    <p
                      className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 ring-1 ring-emerald-200"
                      data-testid="doc-viewer-authority"
                    >
                      Verified against {authorityName}. Name and expiry come from
                      the authority.
                    </p>
                    <VerifyQr documentId={doc.id} token={fileToken} />
                  </>
                ) : (
                  <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-200">
                    Not government-verified. These details were read from the uploaded
                    document, not confirmed against an authority.
                  </p>
                )}
              </div>
            ) : doc.source === "government" ? (
              // Registry-verified: authoritative name + date, shown read-only.
              <div className="mt-4 space-y-3">
                <div>
                  <p className="text-xs font-medium text-slate-500">Document name</p>
                  <p className="mt-0.5 font-semibold text-slate-900" data-testid="doc-viewer-name">
                    {doc.title}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500">Valid until</p>
                  <p className="mt-0.5 font-semibold text-slate-900" data-testid="doc-viewer-date">
                    {fmtDate(doc.validUntil) || "—"}
                  </p>
                </div>
                {doc.holderName && (
                  <div>
                    <p className="text-xs font-medium text-slate-500">Holder</p>
                    <p className="mt-0.5 text-sm text-slate-700">{doc.holderName}</p>
                  </div>
                )}
                {doc.estonianCode && (
                  <div>
                    <p className="text-xs font-medium text-slate-500">Registry code</p>
                    <p className="mt-0.5 font-mono text-xs text-slate-600">{doc.estonianCode}</p>
                  </div>
                )}
                <p
                  className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 ring-1 ring-emerald-200"
                  data-testid="doc-viewer-authority"
                >
                  Verified against {authorityName}. Name and expiry come from
                  the authority and can’t be edited here.
                </p>
                <VerifyQr documentId={doc.id} token={fileToken} />
              </div>
            ) : (
              // Non-government: editable name + expiry the reviewer confirms.
              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-500" htmlFor="dv-name">
                    Document name
                  </label>
                  <input
                    id="dv-name"
                    value={titleInput}
                    onChange={(e) => setTitleInput(e.target.value)}
                    data-testid="doc-viewer-name-input"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-500" htmlFor="dv-date">
                    Expiry date
                  </label>
                  <input
                    id="dv-date"
                    type="date"
                    value={noExpiry ? "" : dateInput}
                    disabled={noExpiry}
                    onChange={(e) => setDateInput(e.target.value)}
                    data-testid="doc-viewer-date-input"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                  />
                  <label className="mt-2 flex items-center gap-2 text-xs font-medium text-slate-600">
                    <input
                      type="checkbox"
                      checked={noExpiry}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setNoExpiry(on);
                        if (on) setDateInput("");
                      }}
                      data-testid="doc-viewer-no-expiry"
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    This document has no expiry date
                  </label>
                </div>
                {doc.holderName && (
                  <p className="text-xs text-slate-400">Name read from photo: {doc.holderName}</p>
                )}

                {doc.reviewerChecked && (
                  <p
                    className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 ring-1 ring-blue-200"
                    data-testid="doc-viewer-checked-note"
                  >
                    {doc.checkedVia === "registry-portal"
                      ? CHECKED_AGAINST_REGISTRY_LABEL
                      : "Checked by reviewer"}
                    {doc.checkedBy ? ` — ${doc.checkedBy}` : ""}
                    {doc.checkedAt ? ` · ${fmtDate(doc.checkedAt)}` : ""}. This is a
                    reviewer check, not government verification.
                  </p>
                )}

                {/* Registry-era agent actions (plan §5.3) — assisted portal check
                    + manual-verification workflow. Agent review surface only. */}
                {reviewer && (
                  <RegistryAgentActions
                    doc={doc}
                    seafarer={seafarer}
                    reviewerName={reviewerName}
                    onUpdate={onUpdate}
                  />
                )}

                {error && <p className="text-xs text-rose-600">{error}</p>}
                {savedNote && (
                  <p className="text-xs font-semibold text-emerald-700" data-testid="doc-viewer-saved">
                    {savedNote}
                  </p>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  {reviewer ? (
                    <>
                      <button
                        type="button"
                        onClick={() => save({ confirmReviewer: true })}
                        disabled={saving}
                        data-testid="doc-viewer-confirm"
                        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                      >
                        {saving ? "Saving…" : "Confirm details"}
                      </button>
                      <button
                        type="button"
                        onClick={() => save({ confirmReviewer: false })}
                        disabled={saving}
                        data-testid="doc-viewer-save"
                        className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                      >
                        Save only
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => save({ confirmReviewer: false })}
                      disabled={saving}
                      data-testid="doc-viewer-save"
                      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                    >
                      {saving ? "Saving…" : "Save details"}
                    </button>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-slate-400">
                  {reviewer
                    ? "Confirming records that you opened the actual document and checked the name and expiry. It marks the doc “Checked by reviewer” — a reviewer sign-off, not government verification."
                    : "Saving updates the name and expiry used for reminders. It does not make the document government-verified."}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
