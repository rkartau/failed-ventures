"use client";

// Multi-outcome verification box (plan §5.2). One input, every registry
// outcome rendered honestly:
//   verified        -> existing CertCard + per-country authority line
//   pending-binding -> explicit holder-confirm step (never a silent green)
//   assist          -> pinned portal deep link + copy-ready prefill fields
//   manual          -> authority + contact + "Request manual verification"
//   ambiguous       -> country picker (the ONLY dropdown), countryOverride round-trip
//   error           -> fake-registry warning / friendly rate-limit retry / plain error
//
// Verify-upload plan §6 adds a SECOND mode tab, "Upload document": anonymous
// photo/PDF upload to /api/verify-upload. Its settled outcomes reuse the exact
// renderers above (one doc = one cert — no multi-result UI); the upload adds
// only its own progress card, the deferred card, and the guided fallback.

import { useEffect, useRef, useState } from "react";
import { CertCard } from "@/components/CertCard";
import { useT } from "@/components/LanguageProvider";
import {
  RegistryEmbeddedPortal,
  RegistryInfo,
  RegistryPrefillFields,
} from "@/components/RegistryInfo";
import type { VerifiedCert } from "@/lib/cert";
import { compressImage } from "@/lib/compress";
import { COUNTRIES, countryEntry } from "@/lib/registry/countries";
import { countryDisplayName } from "@/lib/registry/display";
import type { CountryEntry, ResolveOutcome } from "@/lib/registry/types";
import { xhrUpload } from "@/lib/xhr-upload";

// The demo certificate belongs to a REAL seafarer, so its access token is NOT
// held here — shipping it would put the code in the page HTML and the client
// bundle, exactly the value the card now redacts. The button posts this
// sentinel and /api/cert resolves it to the real code server-side; the lookup
// itself is unchanged (real registry call, real result).
const SAMPLE_SENTINEL = "__docka-sample__";

// Format hint only — a shape, never a real person's verification code.
const SAMPLE_SHAPE = "A1B2C3D4E5F6G7H8";

// ---- Upload tab constants (verify-upload plan §6, server truth wave 1) -----
// The server's Content-Length gate is 10 MB for the WHOLE multipart body, the
// original part is ≤ 10 MB and the derived part ≤ 5 MB. A large original must
// therefore travel ALONE: above this threshold the derived part is dropped
// client-side so original + derived can never trip the whole-body gate
// (4.5 MB + 5 MB < 10 MB, with multipart overhead to spare).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DERIVED_PART_BYTES = 5 * 1024 * 1024;
const DERIVED_DROP_THRESHOLD = 4.5 * 1024 * 1024;

// /api/verify-upload additions riding on the /api/cert body contract.
type UploadResponse = {
  ok?: boolean;
  error?: string;
  outcome?: ResolveOutcome;
  itemId?: string;
  phase?: "completed" | "deferred";
  countryDetected?: string | null;
  /** needs-inputs settles only: the extracted code in its PRINTED form
      ("000730/24") for the prefill — outcome.code stays normalized. */
  codeDisplay?: string;
} & Partial<VerifiedCert>;

// The code an upload-born outcome round-trips with (the ambiguous country
// picker and the needs-inputs re-submit): the server-extracted code carried on
// the outcome itself — the paste input box is empty in upload mode.
function outcomeRoundTripCode(o: ResolveOutcome): string | null {
  return "code" in o && typeof o.code === "string" ? o.code : null;
}

function authorityFor(cert: VerifiedCert): string {
  return countryEntry(cert.registryCountry)?.authority ?? "the official registry";
}

export function VerifyBox({
  initialCode = "",
  compact = false,
}: {
  initialCode?: string;
  compact?: boolean;
}) {
  const { t, lang } = useT();
  const [value, setValue] = useState(initialCode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ResolveOutcome | null>(null);
  const [holderConfirmed, setHolderConfirmed] = useState(false);
  const [manualRequested, setManualRequested] = useState(false);
  // §5.2 multi-key prompt (needs-inputs outcome): values typed for the missing
  // lookup keys (e.g. UK/NO date of birth), re-submitted alongside the code.
  const [extraInputVals, setExtraInputVals] = useState<Record<string, string>>({});

  // ---- Upload tab state (plan §6) ----------------------------------------
  // Mode only toggles which INPUT surface is visible; every result state below
  // is shared, so a tab switch mid-upload never drops in-flight work.
  const [mode, setMode] = useState<"paste" | "upload">("paste");
  const [upStage, setUpStage] = useState<"idle" | "preparing" | "uploading" | "waiting">("idle");
  const [upName, setUpName] = useState("");
  const [upPct, setUpPct] = useState<number | null>(null);
  const [upWaitLeft, setUpWaitLeft] = useState(0);
  const [upPending, setUpPending] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // Deferred card: the doc is SAVED, recognition queued for an admin re-run.
  const [deferredSaved, setDeferredSaved] = useState(false);
  // Guided fallback: completed but nothing verifiable was read. Carries the
  // keyword-map country when it fired, preselecting the manual entry.
  const [fallback, setFallback] = useState<{ country: string | null } | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [manualCountry, setManualCountry] = useState("");
  // Non-null ONLY while the current outcome chain was born from an upload:
  // its round-trips then use this extracted code instead of the (empty) paste
  // input. null keeps the paste path byte-for-byte on today's behavior.
  const [uploadCode, setUploadCode] = useState<string | null>(null);

  // §6 keep-and-retry: the queue RETAINS File objects across 429s — a 4-doc
  // burst persists with zero re-selection. Refs, not state: the async pump
  // must never race React batching for the bytes.
  const queueRef = useRef<File[]>([]);
  const pumpingRef = useRef(false);
  const disposedRef = useRef(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  async function run(
    code: string,
    countryOverride?: string,
    inputs?: Record<string, string>
  ) {
    const q = code.trim();
    if (!q) {
      setError("Enter a verification code or paste a certificate link.");
      return;
    }
    setLoading(true);
    setError(null);
    setOutcome(null);
    setHolderConfirmed(false);
    setManualRequested(false);
    setDeferredSaved(false);
    setFallback(null);
    try {
      const res = await fetch("/api/cert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: q,
          ...(countryOverride ? { countryOverride } : {}),
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        outcome?: ResolveOutcome;
      } & Partial<VerifiedCert>;
      if (data.outcome) {
        setOutcome(data.outcome);
      } else if (data.ok) {
        // Legacy body without an outcome payload — treat as verified.
        setOutcome({ kind: "verified", cert: data as VerifiedCert });
      } else {
        setError(data.error ?? "Could not verify that code.");
      }
    } catch {
      setError("Something went wrong reaching the verification service.");
    } finally {
      setLoading(false);
    }
  }

  // ---- Upload pipeline (plan §6) ------------------------------------------

  function enqueueFiles(list: FileList | File[] | null) {
    if (!list) return;
    const files = Array.from(list).filter((f) => f.size > 0);
    if (files.length === 0) return;
    queueRef.current.push(...files);
    setUpPending(queueRef.current.length);
    if (!pumpingRef.current) void pumpQueue();
  }

  async function pumpQueue() {
    pumpingRef.current = true;
    while (queueRef.current.length > 0 && !disposedRef.current) {
      const file = queueRef.current.shift()!;
      setUpPending(queueRef.current.length);
      await uploadOne(file);
    }
    pumpingRef.current = false;
    setUpStage("idle");
  }

  async function uploadOne(file: File) {
    // Fresh slate for THIS document's result (one doc = one cert — the shared
    // outcome area shows the most recently settled upload).
    setError(null);
    setOutcome(null);
    setHolderConfirmed(false);
    setManualRequested(false);
    setDeferredSaved(false);
    setFallback(null);
    setUpName(file.name || "");
    setUpPct(null);

    // The server would 413 this anyway — refuse client-side with the same
    // friendly message and save the user the doomed upload bytes.
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t("vu.tooLarge"));
      return;
    }

    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isJpeg = /^image\/jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name);

    // §3 derived JPEG: forceJpeg for non-JPEG rasters (the recognition worker
    // QR-decodes JPEG ONLY, so PNG/WebP/BMP/HEIC need the re-encode even when
    // it saves nothing); plain MIN_GAIN compress for JPEG inputs; PDFs never
    // get one. A createImageBitmap/decode failure inside compressImage (HEIC
    // outside iOS Safari) degrades to the untouched original — uploaded ALONE
    // and still saved server-side (the corpus point).
    let derived: File | null = null;
    if (!isPdf) {
      setUpStage("preparing");
      const res = await compressImage(file, { forceJpeg: !isJpeg });
      if (res.compressed) derived = res.file;
    }
    // §1 whole-body rule: a large original travels alone; a derived the server
    // would silently discard (> 5 MB) is dropped instead of paying for it.
    if (derived && (file.size > DERIVED_DROP_THRESHOLD || derived.size > MAX_DERIVED_PART_BYTES)) {
      derived = null;
    }

    // 429 keep-and-retry loop: the File object stays in hand, the countdown
    // runs from Retry-After, and the retry needs zero re-selection.
    for (;;) {
      if (disposedRef.current) return;
      setUpStage("uploading");
      setUpPct(0);
      const fd = new FormData();
      fd.append("file", file, file.name || "document");
      if (derived) fd.append("derived", derived, derived.name);
      const res = await xhrUpload("/api/verify-upload", fd, (loaded, total) => {
        setUpPct(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null);
      });

      if (res.status === 429) {
        const wait = res.retryAfter ?? 20;
        setUpStage("waiting");
        for (let s = wait; s > 0; s--) {
          if (disposedRef.current) return;
          setUpWaitLeft(s);
          await new Promise((r) => setTimeout(r, 1000));
        }
        continue;
      }

      // Friendly refusals. 413 may arrive as a proxy HTML page: xhrUpload
      // already degraded the body to {} non-fatally, so both shapes land on
      // the same localized message.
      if (res.status === 0) {
        setError(t("vu.genericError"));
        return;
      }
      if (res.status === 413) {
        setError(t("vu.tooLarge"));
        return;
      }
      if (res.status === 415) {
        setError(t("vu.unsupported"));
        return;
      }
      if (res.status === 503) {
        setError(t("vu.unavailable"));
        return;
      }
      if (!res.ok) {
        setError(t("vu.genericError"));
        return;
      }

      const data = res.data as UploadResponse;
      if (data.phase === "deferred") {
        // Saved + queued (plan §4): no outcome to render — the deferred card.
        setDeferredSaved(true);
        return;
      }
      if (data.outcome) {
        setOutcome(data.outcome);
        // Printed-form prefill when the server sent one (needs-inputs): both
        // forms round-trip identically (/api/cert normalizes), so the display
        // form doubles as the round-trip code.
        setUploadCode(data.codeDisplay ?? outcomeRoundTripCode(data.outcome));
        return;
      }
      if (data.ok) {
        // Legacy body without an outcome payload — same safety net as run().
        setOutcome({ kind: "verified", cert: data as VerifiedCert });
        return;
      }
      // Completed but nothing verifiable was read — guided fallback (§6):
      // retry tips + manual entry, country preselected when the keyword map
      // fired.
      setFallback({ country: data.countryDetected ?? null });
      setManualCountry(data.countryDetected ?? "");
      setManualCode("");
      return;
    }
  }

  const countryLine = (c: CountryEntry) => (
    <p data-testid="registry-country" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
      {c.countryName} — {c.authority}
    </p>
  );

  // Upload-born outcome chains round-trip with the server-extracted code;
  // paste-born chains (uploadCode === null) use the live input EXACTLY as
  // before — the paste mode's behavior is unchanged.
  const roundTripCode = uploadCode ?? value;

  const tabClass = (active: boolean) =>
    `min-h-[44px] flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
      active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
    }`;

  return (
    <div className={compact ? "" : "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"}>
      {/* ---- Mode tabs (plan §6): paste stays the first, default mode ------ */}
      <div className="mb-3 flex gap-1 rounded-xl bg-slate-100 p-1" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "paste"}
          data-testid="verify-tab-paste"
          onClick={() => setMode("paste")}
          className={tabClass(mode === "paste")}
        >
          {t("vu.tabPaste")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "upload"}
          data-testid="verify-tab-upload"
          onClick={() => setMode("upload")}
          className={tabClass(mode === "upload")}
        >
          {t("vu.tabUpload")}
        </button>
      </div>

      {mode === "paste" && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setUploadCode(null);
              void run(value);
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t("vb.placeholder", { shape: SAMPLE_SHAPE })}
              className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60"
            >
              {loading ? t("vb.verifying") : t("vb.verify")}
            </button>
          </form>

          {/* Sample CTA: a small tinted button — more visible than the old bare
              text link, clearly subordinate to the solid bg-brand-600 Verify
              submit. Brand tints only (the homepage reserves emerald for L3). */}
          {!compact && (
            <button
              type="button"
              onClick={() => {
                // Leave the input empty: filling it with the real code would put
                // the redacted value straight back on screen.
                setValue("");
                setUploadCode(null);
                void run(SAMPLE_SENTINEL);
              }}
              className="mt-3 inline-flex items-center rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 transition hover:bg-brand-100"
            >
              {t("vb.sample")}
            </button>
          )}
        </>
      )}

      {mode === "upload" && (
        <div data-testid="upload-panel">
          <div
            data-testid="upload-dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              enqueueFiles(e.dataTransfer.files);
            }}
            className={`rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm transition ${
              dragOver ? "border-brand-500 bg-brand-50" : "border-slate-300 bg-slate-50"
            }`}
          >
            <p className="text-slate-600">{t("vu.dropTitle")}</p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                data-testid="upload-choose"
                onClick={() => pickRef.current?.click()}
                className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
              >
                {t("vu.choose")}
              </button>
              <button
                type="button"
                data-testid="upload-camera"
                onClick={() => camRef.current?.click()}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                {t("vu.takePhoto")}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">{t("vu.formats")}</p>
            <input
              ref={pickRef}
              type="file"
              multiple
              accept="image/*,application/pdf,.pdf,.heic,.heif"
              className="hidden"
              data-testid="upload-input"
              onChange={(e) => {
                enqueueFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {/* `capture` opens the camera directly on phones (plan §6 —
                photographing the paper cert on the spot); desktop ignores it. */}
            <input
              ref={camRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              data-testid="upload-camera-input"
              onChange={(e) => {
                enqueueFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {/* Retention notice intentionally NOT rendered here (operator decision
              2026-08-12): the disclosure lives on /privacy instead. The vu.notice
              i18n key is kept in the dictionary for a future i18n'd privacy page. */}
        </div>
      )}

      {/* ---- Upload progress: preparing / sending / 429 countdown ---------
          Rendered in BOTH tabs — a tab switch mid-upload must not hide (let
          alone drop) in-flight state. */}
      {upStage !== "idle" && (
        <div
          data-testid="upload-progress"
          className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
        >
          {upStage === "preparing" && <p>{t("vu.preparing")}</p>}
          {upStage === "uploading" && (
            <p>
              {upPct === 100 ? t("vu.checking") : t("mu.st.uploading")}{" "}
              {upName && <span className="font-medium">{upName}</span>}
              {upPct != null && upPct < 100 ? ` — ${upPct}%` : ""}
            </p>
          )}
          {upStage === "waiting" && <p>{t("vu.retryIn", { s: upWaitLeft })}</p>}
          {upPending > 0 && (
            <p className="mt-1 text-xs text-sky-800/80">{t("vu.moreWaiting", { n: upPending })}</p>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* ---- deferred: saved + queued for a later run (upload only) -------- */}
      {deferredSaved && (
        <div
          data-testid="upload-deferred"
          className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
        >
          {t("vu.deferred")}
        </div>
      )}

      {/* ---- guided fallback: saved, nothing readable — retry tips + manual
              entry prefilled with the detected country (upload only) -------- */}
      {fallback && (
        <div
          data-testid="upload-fallback"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-semibold">{t("vu.fallbackTitle")}</p>
          <p className="mt-1">{t("vu.fallbackBody")}</p>
          {fallback.country && countryEntry(fallback.country) && (
            <p className="mt-1 font-medium" data-testid="upload-fallback-country">
              {t("vu.fallbackCountry", {
                country: countryDisplayName(
                  fallback.country,
                  lang,
                  countryEntry(fallback.country)!.countryName
                ),
              })}
            </p>
          )}
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const code = manualCode.trim();
              if (!code) return;
              // Converge onto the classic paste chain: the typed code becomes
              // the live input, so any follow-up round-trip behaves exactly
              // like a pasted lookup.
              setValue(code);
              setUploadCode(null);
              void run(code, manualCountry || undefined);
            }}
          >
            <label className="text-xs font-medium text-amber-800">{t("sd.codeLabel")}</label>
            <input
              data-testid="upload-fallback-code"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder={t("sc.codePh")}
              className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-500"
              spellCheck={false}
            />
            <label className="text-xs font-medium text-amber-800">{t("vu.countryLabel")}</label>
            <select
              data-testid="upload-fallback-country-select"
              value={manualCountry}
              onChange={(e) => setManualCountry(e.target.value)}
              className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-500"
            >
              <option value="">{t("vu.detectAuto")}</option>
              {COUNTRIES.map((c) => (
                <option key={c.country} value={c.country}>
                  {countryDisplayName(c.country, lang, c.countryName)}
                </option>
              ))}
            </select>
            <button
              type="submit"
              data-testid="upload-fallback-verify"
              disabled={loading || !manualCode.trim()}
              className="mt-1 w-fit rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
            >
              {t("vu.verify")}
            </button>
          </form>
        </div>
      )}

      {/* ---- verified: machine-verified, capability-token modes only ---- */}
      {outcome?.kind === "verified" && (
        <div className="mt-4 space-y-2">
          <CertCard cert={outcome.cert} />
          <p data-testid="registry-country" className="text-xs font-medium text-slate-500">
            Verified against {authorityFor(outcome.cert)}.
          </p>
        </div>
      )}

      {/* ---- pending-binding: explicit holder-confirm step (§2.5) ------- */}
      {outcome?.kind === "pending-binding" &&
        (holderConfirmed ? (
          <div className="mt-4 space-y-2">
            <CertCard cert={outcome.cert} />
            <p data-testid="registry-country" className="text-xs font-medium text-slate-500">
              Holder per registry: {outcome.cert.fullName || "(name not returned)"} — profile
              identity not verified. Confirmed by {outcome.country.authority}.
            </p>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            {countryLine(outcome.country)}
            <p className="mt-1">
              The {outcome.country.countryName} registry found this certificate
              {outcome.cert.hasName && outcome.cert.fullName ? (
                <>
                  {" "}
                  issued to <span className="font-semibold">{outcome.cert.fullName}</span>
                </>
              ) : null}
              . This lookup uses details printed on the certificate, so confirm the holder before
              trusting it.
            </p>
            <button
              type="button"
              data-testid="holder-confirm"
              onClick={() => setHolderConfirmed(true)}
              className="mt-2 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
            >
              Yes, this is the right person — show the certificate
            </button>
          </div>
        ))}

      {/* ---- needs-inputs: multi-key prompt (§5.2 — UK/NO dob, …) --------- */}
      {outcome?.kind === "needs-inputs" && (
        <form
          data-testid="needs-inputs-panel"
          className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
          onSubmit={(e) => {
            e.preventDefault();
            void run(roundTripCode, outcome.country.country, extraInputVals);
          }}
        >
          {countryLine(outcome.country)}
          {/* Upload-born chain (uploadCode !== null): the pipeline DID read a
              code — say so and prefill it (editable) instead of the generic
              wording; the paste-born wording stays byte-for-byte. */}
          {uploadCode !== null ? (
            <p className="mt-1" data-testid="needs-inputs-read">
              {t("vu.readCode", { code: uploadCode })}
            </p>
          ) : (
            <p className="mt-1">
              The {outcome.country.countryName} registry needs a couple more details to check this
              certificate:
            </p>
          )}
          <div className="mt-2 space-y-2">
            {uploadCode !== null && (
              <div className="flex items-center gap-2">
                <label className="w-40 flex-shrink-0 text-xs font-medium text-sky-800">
                  {t("sd.codeLabel")}
                </label>
                <input
                  data-testid="needs-inputs-code"
                  value={uploadCode}
                  onChange={(e) => setUploadCode(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-sky-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500"
                  spellCheck={false}
                />
              </div>
            )}
            {outcome.missing.map((f) => (
              <div key={f.key} className="flex items-center gap-2">
                <label className="w-40 flex-shrink-0 text-xs font-medium text-sky-800">
                  {f.label}
                </label>
                {f.options && f.options.length > 0 ? (
                  // Closed value list (UA-MARAD doctype): a select whose VALUE
                  // is the wire code the adapter posts.
                  <select
                    data-testid={`needs-input-${f.key}`}
                    value={extraInputVals[f.key] ?? ""}
                    onChange={(e) =>
                      setExtraInputVals((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                    className="min-w-0 flex-1 rounded-lg border border-sky-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500"
                  >
                    <option value="" disabled>
                      Select…
                    </option>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    data-testid={`needs-input-${f.key}`}
                    type={f.key === "dob" || f.key === "issuedOn" ? "date" : "text"}
                    value={extraInputVals[f.key] ?? ""}
                    onChange={(e) =>
                      setExtraInputVals((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                    className="min-w-0 flex-1 rounded-lg border border-sky-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500"
                    spellCheck={false}
                  />
                )}
              </div>
            ))}
          </div>
          <button
            type="submit"
            data-testid="needs-inputs-submit"
            disabled={
              loading ||
              // Upload-born chains: an emptied code field gates the submit.
              (uploadCode !== null && !uploadCode.trim()) ||
              // Optional keys (FR numeroVersion) never gate the lookup (§5.2).
              outcome.missing.some((f) => !f.optional && !(extraInputVals[f.key] ?? "").trim())
            }
            className="mt-3 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
          >
            Check the certificate
          </button>
          <p className="mt-2 text-xs text-sky-800/80">
            These details are used only for this lookup — they are not stored.
          </p>
        </form>
      )}

      {/* ---- assist: pinned portal deep link + copy-ready fields --------- */}
      {outcome?.kind === "assist" && (
        <div
          data-testid="assist-panel"
          className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
        >
          {/* Shared registry-info block (§5.3): authority, contact, notes (incl.
              fake-domain warnings). The portal CTA below stays the panel's own. */}
          <RegistryInfo country={outcome.country} showPortal={false} />
          <p className="mt-1">
            This registry can’t be checked automatically — verify it on the official portal (it
            opens in a new tab), copying the fields across:
          </p>
          <RegistryPrefillFields country={outcome.country} prefill={outcome.prefill} />
          {/* Embeddable countries (LV only): "Verify here in the box" opens the
              OFFICIAL portal in an in-page iframe; the copy fields above stay
              visible so values can be copied into the framed form. The portal
              link below remains the fallback. */}
          <RegistryEmbeddedPortal country={outcome.country} prefill={outcome.prefill} />
          <a
            data-testid="assist-open-portal"
            href={outcome.country.portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          >
            Open the official registry ↗
          </a>
        </div>
      )}

      {/* ---- manual: request workflow with the authority ----------------- */}
      {outcome?.kind === "manual" && (
        <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
          {/* Shared registry-info block (§5.3): authority, portal link, contact
              email, notes (incl. the fake-domain warnings for RO/IS). */}
          <RegistryInfo country={outcome.country} />
          <p className="mt-1">
            {outcome.country.authority} has no public lookup — verification is requested directly
            from the authority.
          </p>
          {manualRequested ? (
            <p className="mt-2 text-xs font-medium">
              To open the request, add this certificate from your seafarer profile — the document
              is stored with a “Verification requested” status your agent follows up.
            </p>
          ) : (
            <button
              type="button"
              data-testid="manual-request-btn"
              onClick={() => setManualRequested(true)}
              className="mt-2 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
            >
              Request manual verification
            </button>
          )}
        </div>
      )}

      {/* ---- ambiguous: the ONLY dropdown — countryOverride round-trip ---
          B3: the picker lists the DETECTED candidates when detection produced
          them (fan-out cap), never the full table. The full list appears ONLY
          for the B2 unmatched dead-end rescue, where the user explicitly
          chooses the issuing country (assisted/manual picks then route to
          that flow with the pasted code). */}
      {outcome?.kind === "ambiguous" &&
        (() => {
          const pickerCountries =
            !outcome.unmatched && outcome.candidates.length > 0
              ? outcome.candidates
                  .map((cc) => countryEntry(cc))
                  .filter((c): c is NonNullable<typeof c> => !!c)
              : COUNTRIES;
          return (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p>
                {outcome.unmatched
                  ? "This code didn’t match any registry automatically. Pick the issuing country and we’ll take it from there:"
                  : "This code could belong to more than one registry. Pick the issuing country to continue:"}
              </p>
              <select
                data-testid="country-picker"
                data-unmatched={outcome.unmatched ? "true" : "false"}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) void run(roundTripCode, e.target.value);
                }}
                className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-500"
              >
                <option value="" disabled>
                  Select the issuing country…
                </option>
                {pickerCountries.map((c) => (
                  <option key={c.country} value={c.country}>
                    {c.countryName}
                  </option>
                ))}
              </select>
            </div>
          );
        })()}

      {/* ---- errors: fake registry / rate limit / plain ------------------ */}
      {outcome?.kind === "error" &&
        (outcome.unpinnedDomain ? (
          <div
            data-testid="registry-warning"
            className="mt-4 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            <p className="font-semibold">
              “{outcome.unpinnedDomain}” is not the official registry domain for any supported
              country.
            </p>
            <p className="mt-1 text-xs">
              Fake “registry” websites imitate real maritime authorities. Nothing was checked
              against this address — use the certificate’s printed code or the official authority
              portal instead.
            </p>
          </div>
        ) : outcome.rateLimited ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {outcome.error}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {outcome.error}
          </div>
        ))}
    </div>
  );
}
