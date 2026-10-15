"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Doc, DocRequest } from "@/lib/db";
import { compressImage, formatBytes } from "@/lib/compress";
import { xhrUpload } from "@/lib/xhr-upload";
import { useT } from "@/components/LanguageProvider";
import {
  loadUploads,
  putUpload,
  removeUpload,
  setUploadStatus,
  type QueuedUpload,
} from "@/lib/upload-queue";

type ItemStatus = "queued" | "uploading" | "verified" | "photo" | "saved" | "duplicate" | "error";

type Item = {
  key: string;
  name: string;
  status: ItemStatus;
  message: string;
  /** Kept so a failed/interrupted upload can be retried or resumed without re-picking. */
  file?: File;
  /** Bytes uploaded / total (compressed) for this file's live progress bar. */
  sent?: number;
  total?: number;
  originalSize?: number;
  /** True while an upload is making no progress — "connection slow, still trying". */
  slow?: boolean;
  /** True for a row restored from disk after a reload/reconnect. */
  restored?: boolean;
};

// A paper photo that isn't government-verified still SUCCEEDED at arriving, so it
// must never look like an error. But it must ALSO never look identical to a
// registry-verified document: only "verified" gets the emerald "verified" green.
// A saved photo gets a calm neutral BLUE "saved" — clearly arrived, clearly not
// the same thing as a registry check.
const STATUS_STYLE: Record<ItemStatus, string> = {
  queued: "bg-slate-100 text-slate-500 ring-slate-200",
  uploading: "bg-sky-100 text-sky-700 ring-sky-200",
  verified: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  photo: "bg-sky-100 text-sky-800 ring-sky-200",
  saved: "bg-sky-100 text-sky-800 ring-sky-200",
  // A recognised repeat: calm amber, clearly NOT a fresh save (blue) and NOT a
  // failure (rose) — it says "we already have this one".
  duplicate: "bg-amber-100 text-amber-800 ring-amber-200",
  error: "bg-rose-100 text-rose-800 ring-rose-200",
};
const STATUS_LABEL: Record<ItemStatus, string> = {
  queued: "Queued",
  uploading: "Sending…",
  verified: "Verified (registry)",
  photo: "Photo saved",
  saved: "Saved",
  duplicate: "Already uploaded",
  error: "Failed",
};

// The terminal-success states that show an "arrived" mark. A duplicate also
// counts as terminal (it reached the server and was recognised) so the batch
// progress can complete instead of stalling on a skipped repeat.
const DONE: ItemStatus[] = ["verified", "photo", "saved", "duplicate"];

const STALL_MS = 15_000; // no progress for this long ⇒ "connection slow" hint

// A registry-verified doc gets an emerald check; a saved (unverified) photo gets
// a neutral blue image mark — arrived, but visibly NOT a verification.
function DoneMark({ status }: { status: ItemStatus }) {
  if (status === "duplicate") {
    // A "copy" glyph in amber: this photo is a repeat of one already on file.
    return (
      <svg
        width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className="shrink-0 text-amber-600" aria-hidden="true"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    );
  }
  if (status === "verified") {
    return (
      <svg
        width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
        className="shrink-0 text-emerald-600" aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 text-sky-600" aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

// Per-file XHR upload transport (real progress) now lives in @/lib/xhr-upload —
// shared with the anonymous VerifyBox upload tab (verify-upload plan §6).

// Mass upload: take or pick MANY certificate photos at once. Each photo is
// downscaled in the browser first (a 5 MP paper cert does not need 5 MB on a ship
// link), tracked with a live per-file progress bar, and PERSISTED to disk so a
// dropped connection or a reload never loses an in-progress batch — the queue
// resumes automatically when the connection returns.
export function MassUpload({
  seafarerId,
  shareToken,
  onAdded,
  onRequestsChanged,
  initialFiles,
}: {
  seafarerId: string;
  /**
   * Seaman self-service auth: the OWNER share token (possession secret). A seaman
   * authenticates by token only (no agent session), so the /api/documents POST auth
   * gate needs it — without it a seaman's photo upload 404s. Sent as the "token"
   * form field on each upload when present.
   */
  shareToken?: string;
  onAdded: (doc: Doc) => void;
  /**
   * Called after a successful (non-duplicate) upload whose response carried the
   * seafarer's fresh document-request checklist (type-based auto-clear may have
   * ticked an item off). Lets the parent update its docRequests state without a
   * full reload. Absent on duplicate-skip responses, so only fires when present.
   */
  onRequestsChanged?: (docRequests: DocRequest[]) => void;
  /** Photos chosen on the create screen, auto-uploaded once on mount. */
  initialFiles?: File[];
}) {
  const { t } = useT();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [online, setOnline] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // Live refs the async upload loop reads without re-subscribing.
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const onlineRef = useRef(true);
  // key -> compressed File, so the async loop never races React state for the bytes.
  const filesRef = useRef<Map<string, File>>(new Map());

  function setItem(key: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  // Send one already-persisted item. Compresses lazily if a File is present but
  // no stored size yet. Never throws; a failure leaves the row retry-able.
  const uploadOne = useCallback(
    async (key: string) => {
      const it = itemsRef.current.find((x) => x.key === key);
      const file = filesRef.current.get(key) ?? it?.file;
      if (!file) return;
      const name = it?.name ?? file.name;
      if (!onlineRef.current) {
        setItem(key, { status: "queued", message: "Offline — will resume when you reconnect." });
        return;
      }
      setItem(key, { status: "uploading", message: "", slow: false, sent: 0, total: file.size });

      let stalled: ReturnType<typeof setTimeout> | null = null;
      const armStall = () => {
        if (stalled) clearTimeout(stalled);
        stalled = setTimeout(() => setItem(key, { slow: true }), STALL_MS);
      };
      armStall();

      const fd = new FormData();
      fd.append("seafarerId", seafarerId);
      if (shareToken) fd.append("token", shareToken);
      fd.append("file", file, name);

      const res = await xhrUpload("/api/documents", fd, (loaded, total) => {
        setItem(key, { sent: loaded, total, slow: false });
        armStall();
      });
      if (stalled) clearTimeout(stalled);

      if (!res.ok || !res.data?.ok) {
        // A dropped connection (status 0) is a resumable interruption, not a real
        // failure — keep it on disk so it retries when the link returns.
        await setUploadStatus(key, "failed").catch(() => {});
        const offlineNow = !onlineRef.current || res.status === 0;
        setItem(key, {
          status: "error",
          slow: false,
          message: offlineNow
            ? "Connection dropped — kept safe, tap Retry or reconnect to resume."
            : res.data?.error ?? `Upload failed (${res.status}).`,
        });
        return;
      }

      // Same-seafarer duplicate: the server disregarded it. Show it as skipped and
      // do NOT add another row — the original document is already on the profile.
      if (res.data.duplicate) {
        filesRef.current.delete(key);
        await removeUpload(key).catch(() => {});
        // Distinct "duplicate" state (amber, its own badge) so the seaman sees the
        // repeat was recognised — not silently dropped and not mistaken for a
        // failure or a brand-new save.
        setItem(key, {
          status: "duplicate",
          slow: false,
          message: res.data.message ?? "Already uploaded — skipped (already on your profile).",
        });
        return;
      }

      const doc = res.data.document as Doc;
      onAdded(doc);
      // The general uploader posts no docRequestId, but the server still runs
      // type-based auto-clear — surface the fresh checklist so the seaman's
      // to-do list ticks off without a manual refresh. Absent on some flows.
      if (Array.isArray(res.data.docRequests)) {
        onRequestsChanged?.(res.data.docRequests as DocRequest[]);
      }
      filesRef.current.delete(key);
      await removeUpload(key).catch(() => {});
      if (res.data.autoVerified || doc.source === "government") {
        setItem(key, {
          status: "verified",
          slow: false,
          message: `${doc.title}${doc.validUntil ? ` · valid until ${doc.validUntil}` : ""}`,
        });
      } else if (doc.source === "photo") {
        setItem(key, {
          status: "photo",
          slow: false,
          message: `${doc.title} · saved. The agent will review it — no code was found.`,
        });
      } else {
        setItem(key, { status: "saved", slow: false, message: doc.title });
      }
    },
    [seafarerId, shareToken, onAdded, onRequestsChanged]
  );

  // Drain a set of keys with a small concurrency pool.
  const drainKeys = useCallback(
    async (keys: string[]) => {
      if (keys.length === 0) return;
      setRunning(true);
      const CONCURRENCY = 3;
      let next = 0;
      async function worker() {
        while (next < keys.length) {
          const i = next++;
          if (!onlineRef.current) break; // pause the pool while offline
          await uploadOne(keys[i]);
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker));
      setRunning(false);
    },
    [uploadOne]
  );

  // Retry a single failed/interrupted row — reuses the stored file bytes.
  async function retry(key: string) {
    await uploadOne(key);
  }

  // Add freshly-picked files: compress each, persist its bytes to disk, then upload.
  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      // Placeholder rows immediately so the user sees the batch (compression may
      // take a moment on a big photo).
      const staged = files.map((f, i) => ({
        key: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name,
        raw: f,
      }));
      setItems((prev) => [
        ...prev,
        ...staged.map((s) => ({
          key: s.key,
          name: s.name,
          status: "queued" as ItemStatus,
          message: "Preparing…",
          originalSize: s.raw.size,
        })),
      ]);

      // Compress + persist each, then collect keys to upload.
      const keys: string[] = [];
      for (const s of staged) {
        const { file, originalSize, compressedSize, compressed } = await compressImage(s.raw);
        const queued: QueuedUpload = {
          key: s.key,
          seafarerId,
          name: file.name,
          size: compressedSize,
          originalSize,
          blob: file,
          status: "pending",
          createdAt: Date.now(),
        };
        await putUpload(queued).catch(() => {});
        filesRef.current.set(s.key, file);
        setItem(s.key, {
          file,
          name: file.name,
          total: compressedSize,
          originalSize,
          message: compressed
            ? `Compressed ${formatBytes(originalSize)} → ${formatBytes(compressedSize)}`
            : "",
        });
        keys.push(s.key);
      }
      await drainKeys(keys);
    },
    [seafarerId, drainKeys]
  );

  // --- Restore any persisted (interrupted) uploads on mount ------------------
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      const saved = await loadUploads(seafarerId);
      if (saved.length === 0) return;
      const restored: Item[] = saved.map((u) => {
        const f = new File([u.blob], u.name, { type: u.blob.type || "image/jpeg" });
        filesRef.current.set(u.key, f);
        return {
          key: u.key,
          name: u.name,
          status: u.status === "failed" ? ("error" as ItemStatus) : ("queued" as ItemStatus),
          message:
            u.status === "failed"
              ? "Interrupted earlier — tap Retry to resume."
              : "Waiting to resume…",
          file: f,
          total: u.size,
          originalSize: u.originalSize,
          restored: true,
        };
      });
      setItems((prev) => {
        const have = new Set(prev.map((p) => p.key));
        return [...prev, ...restored.filter((r) => !have.has(r.key))];
      });
      // Auto-resume the ones that were still pending, if we're online.
      if (typeof navigator !== "undefined" && navigator.onLine) {
        const resumeKeys = saved.filter((u) => u.status === "pending").map((u) => u.key);
        if (resumeKeys.length) void drainKeys(resumeKeys);
      }
    })();
  }, [seafarerId, drainKeys]);

  // Auto-upload any photos the seaman already chose on the create screen.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    if (initialFiles && initialFiles.length > 0) {
      bootedRef.current = true;
      void handleFiles(initialFiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles]);

  // --- Online / offline: pause + auto-resume ---------------------------------
  useEffect(() => {
    function sync(isOnline: boolean) {
      onlineRef.current = isOnline;
      setOnline(isOnline);
      if (isOnline) {
        // Resume anything still queued or interrupted.
        const keys = itemsRef.current
          .filter((it) => it.status === "queued" || it.status === "error")
          .map((it) => it.key);
        if (keys.length) void drainKeys(keys);
      }
    }
    if (typeof navigator !== "undefined") {
      onlineRef.current = navigator.onLine;
      setOnline(navigator.onLine);
    }
    const on = () => sync(true);
    const off = () => sync(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [drainKeys]);

  const counts = items.reduce(
    (a, it) => {
      a[it.status] = (a[it.status] ?? 0) + 1;
      return a;
    },
    {} as Record<ItemStatus, number>
  );

  // Data + progress totals across the active batch.
  const totalBytes = items.reduce((a, it) => a + (it.total ?? 0), 0);
  const sentBytes = items.reduce(
    (a, it) => a + (DONE.includes(it.status) ? it.total ?? 0 : it.sent ?? 0),
    0
  );
  const savedBytes = items.reduce(
    (a, it) => a + Math.max(0, (it.originalSize ?? 0) - (it.total ?? it.originalSize ?? 0)),
    0
  );
  const anySlow = items.some((it) => it.slow);
  // Items still on-device waiting to reach the server (queued, mid-send, or
  // interrupted). Drives the always-visible sync indicator that demonstrates the
  // offline-first queue instead of only promising it.
  const pendingSync = items.filter(
    (it) => it.status === "queued" || it.status === "uploading" || it.status === "error"
  ).length;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-semibold text-slate-900">{t("mu.title")}</h2>
        {/* Always-visible ship-to-shore sync status. */}
        <span
          data-testid="sync-status"
          data-online={online ? "true" : "false"}
          data-pending={pendingSync}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${
            !online
              ? "bg-amber-100 text-amber-800 ring-amber-200"
              : pendingSync > 0
                ? "bg-sky-100 text-sky-800 ring-sky-200"
                : "bg-emerald-100 text-emerald-800 ring-emerald-200"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              !online ? "bg-amber-500" : pendingSync > 0 ? "bg-sky-500" : "bg-emerald-500"
            }`}
          />
          {!online
            ? t("mu.sync.offline")
            : pendingSync > 0
              ? t("mu.sync.waiting", { n: pendingSync })
              : t("mu.sync.online")}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-500">{t("mu.subtitle")}</p>

      {!online && (
        <div
          data-testid="offline-banner"
          className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800"
        >
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          {t("mu.offline")}
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
        data-testid="mass-upload-dropzone"
        className={`mt-4 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-8 text-center transition ${
          dragging ? "border-brand-500 bg-brand-50" : "border-slate-300 bg-slate-50"
        }`}
      >
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-400">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          data-testid="mass-upload"
          className="mt-3 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          {t("mu.add")}
        </button>
        <p className="mt-2 text-xs text-slate-400">{t("mu.formats")}</p>

        {/* Single entry point: no `capture`, so a phone offers camera AND gallery
            in one native tap while desktop shows a normal file picker. */}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          data-testid="mass-upload-input"
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = "";
          }}
          className="hidden"
        />
      </div>

      {items.length > 0 && (
        <div className="mt-4">
          {(() => {
            const total = items.length;
            const done = items.filter((it) => DONE.includes(it.status) || it.status === "error").length;
            const pct = totalBytes > 0 ? Math.round((sentBytes / totalBytes) * 100) : total ? Math.round((done / total) * 100) : 0;
            // Rough ETA from bytes remaining at the observed average throughput.
            return (
              <div className="mb-3" data-testid="upload-progress" data-done={done} data-total={total}>
                <div className="flex items-center justify-between text-xs font-medium text-slate-600">
                  <span>
                    {running ? "Adding your photos…" : "All photos added"} {done}/{total}
                  </span>
                  <span className="text-slate-400">{pct}%</span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${running ? "bg-sky-500" : "bg-emerald-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-slate-400">
                  <span data-testid="upload-data">
                    {formatBytes(sentBytes)} of {formatBytes(totalBytes)} sent
                    {savedBytes > 0 ? ` · ${formatBytes(savedBytes)} saved by shrinking` : ""}
                  </span>
                  {running &&
                    (anySlow ? (
                      <span className="font-medium text-amber-600" data-testid="upload-slow">
                        Connection slow — still trying, your photos are safe.
                      </span>
                    ) : (
                      <span>Keep this page open — you can leave and come back, uploads resume.</span>
                    ))}
                </div>
              </div>
            );
          })()}
          <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
            {(["verified", "photo", "saved", "duplicate", "error", "uploading", "queued"] as ItemStatus[])
              .filter((s) => counts[s])
              .map((s) => (
                <span key={s} className={`rounded-full px-2 py-0.5 font-semibold ring-1 ${STATUS_STYLE[s]}`}>
                  {counts[s]} {t(`mu.st.${s}`)}
                </span>
              ))}
          </div>
          <ul className="space-y-1.5" data-testid="upload-list">
            {items.map((it) => {
              const rowPct =
                it.total && it.total > 0
                  ? Math.min(100, Math.round(((DONE.includes(it.status) ? it.total : it.sent ?? 0) / it.total) * 100))
                  : 0;
              return (
                <li
                  key={it.key}
                  data-testid="upload-row"
                  data-status={it.status}
                  className="rounded-xl border border-slate-200 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {DONE.includes(it.status) && <DoneMark status={it.status} />}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{it.name}</p>
                        {it.message && <p className="truncate text-xs text-slate-400">{it.message}</p>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {it.status === "error" && (
                        <button
                          type="button"
                          onClick={() => retry(it.key)}
                          data-testid="upload-retry"
                          className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          {t("mu.retry")}
                        </button>
                      )}
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${STATUS_STYLE[it.status]}`}
                      >
                        {it.slow && it.status === "uploading" ? "Slow…" : t(`mu.st.${it.status}`)}
                      </span>
                    </div>
                  </div>
                  {it.status === "uploading" && (
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${it.slow ? "bg-amber-400" : "bg-sky-500"} transition-all duration-200`}
                        style={{ width: `${rowPct}%` }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
