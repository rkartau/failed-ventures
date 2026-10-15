"use client";

import { useEffect, useState } from "react";
import type { Doc, Comment } from "@/lib/db";
import { docBadgeForDoc, type CertResult, type VerifiedCert } from "@/lib/cert";
import { verifiedFirst } from "@/lib/archive";
import { docNumber, duplicateOthers, type DuplicateNameIndex } from "@/lib/duplicates";
import { CertCard } from "@/components/CertCard";
import { StatusBadge } from "@/components/StatusBadge";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import { verificationLevelForDoc, docLevelTooltip } from "@/lib/verification-level";
import { DocViewer } from "@/components/DocViewer";
import { VerifyQrToggle } from "@/components/VerifyQr";
import { useT } from "@/components/LanguageProvider";
import { countryEntry } from "@/lib/registry/countries";
import { rescuedDocDisplay } from "@/lib/registry/prefill";

// MEDICAL GATING IS OFF (owner decision D3): a medical / fitness certificate is
// shown exactly like every other document — no reveal step, no lawful-basis
// selector, no redaction. A single agent role sees medical docs normally.

const NAME_KEY = "seacred:agentName";

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function AgentDocList({
  documents,
  seafarerName = "",
  duplicates = {},
  fileToken,
}: {
  documents: Doc[];
  seafarerName?: string;
  /** cert-number -> crew entries sharing it (fleet-wide duplicate index). */
  duplicates?: DuplicateNameIndex;
  /**
   * Owner share token for this seafarer (the share-view context). Threaded to the
   * file link so the server authorises the owner's own documents. File URLs carry
   * the opaque document ID, never a filename.
   */
  fileToken?: string;
}) {
  const { t } = useT();
  const [agentName, setAgentName] = useState("");

  useEffect(() => {
    setAgentName(localStorage.getItem(NAME_KEY) ?? "");
  }, []);

  function onNameChange(v: string) {
    setAgentName(v);
    localStorage.setItem(NAME_KEY, v);
  }

  if (documents.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-400">
        This seafarer has not uploaded any documents yet.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <label className="text-xs font-medium text-slate-500">{t("sh.yourName")}</label>
        <input
          value={agentName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Maria — Crewing Agent"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </div>

      <div className="space-y-4">
        {verifiedFirst(documents).map((doc) => (
          <DocCard
            key={doc.id}
            doc={doc}
            agentName={agentName}
            timeAgo={timeAgo}
            duplicateWith={duplicateOthers(doc, duplicates, seafarerName)}
            fileToken={fileToken}
          />
        ))}
      </div>
    </div>
  );
}

function DocCard({
  doc,
  agentName,
  timeAgo,
  duplicateWith = [],
  fileToken,
}: {
  doc: Doc;
  agentName: string;
  timeAgo: (iso: string) => string;
  duplicateWith?: string[];
  fileToken?: string;
}) {
  const { t } = useT();
  const [cert, setCert] = useState<VerifiedCert | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  // Comment thread is COLLAPSED by default (per-document, independent state) so the
  // card stays compact; the count stays visible in the toggle header.
  const [commentsOpen, setCommentsOpen] = useState(false);

  const number = docNumber(doc);

  useEffect(() => {
    // In the share-link context (no agent session) the owner token authorises the
    // read; on the agent dashboard fileToken is undefined and the session does.
    const q = fileToken ? `&token=${encodeURIComponent(fileToken)}` : "";
    void fetch(`/api/comments?documentId=${encodeURIComponent(doc.id)}${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setComments(d.comments);
      })
      .catch(() => {});
  }, [doc.id, fileToken]);

  async function verify() {
    if (!doc.estonianCode) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const res = await fetch(`/api/cert?code=${encodeURIComponent(doc.estonianCode)}`);
      const data = (await res.json()) as CertResult;
      if (data.ok) setCert(data);
      else {
        // The share view is a read-only surface: registry outcomes that need
        // interaction (picker / extra inputs / holder binding) happen in the
        // seafarer's own flow — translate their sentinel codes to plain words
        // instead of leaking "registry-ambiguous" to an agent.
        const FRIENDLY: Record<string, string> = {
          "registry-ambiguous":
            "This code could not be matched to one registry automatically — it can be verified from the seafarer's own profile flow.",
          "registry-assist":
            "This registry can't be checked automatically — verify it on the official authority portal.",
          "registry-manual":
            "This authority has no public lookup — verification is requested manually from the authority.",
          "registry-needs-inputs":
            "This registry needs more details than the code alone — it can be verified from the seafarer's own profile flow.",
          "registry-pending-binding":
            "This lookup uses details printed on the certificate and needs a holder check — it can be verified from the seafarer's own profile flow.",
        };
        setVerifyError(FRIENDLY[data.error] ?? data.error);
      }
    } catch {
      setVerifyError("Could not reach the verification service.");
    } finally {
      setVerifying(false);
    }
  }

  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentText.trim()) return;
    setPosting(true);
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: doc.id,
          authorName: agentName.trim() || "Anonymous",
          text: commentText.trim(),
          // Share-link context: authorise the note with the owner token (undefined on
          // the agent dashboard, where the signed-in session authorises instead).
          ...(fileToken ? { token: fileToken } : {}),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setComments((prev) => [...prev, data.comment]);
        setCommentText("");
      }
    } finally {
      setPosting(false);
    }
  }

  const fileUrl = doc.fileName
    ? `/api/files/${doc.id}${fileToken ? `?token=${encodeURIComponent(fileToken)}` : ""}`
    : null;

  const badge = docBadgeForDoc({
    verified: doc.source === "government",
    validUntil: doc.validUntil,
    expiryConfirmed: doc.expiryConfirmed,
    // Registry-era states (plan §5.1): teal registry-doc, violet requested,
    // "Checked against registry" label variant.
    source: doc.source,
    checkedVia: doc.reviewerChecked ? doc.checkedVia : null,
    manualRequested: doc.manualVerification?.status === "requested",
    noExpiry: doc.noExpiry,
  });
  const verified = doc.source === "government";
  // Persona B1 — per-doc registry attribution from countries.ts. A mixed-
  // nationality doc list must never claim "Estonian registry" on a Danish
  // certificate: the verify button and the card caption name THIS doc's
  // registry (Estonia keeps its existing localized wording).
  const registry = doc.registryCountry ? countryEntry(doc.registryCountry) : undefined;
  const verifyLabel =
    !registry || registry.country === "EE"
      ? t("sh.verify")
      : t("sh.verifyCountry", { country: registry.countryName });
  // For an unverified doc the date is not a confirmed fact — say "reads as" and
  // mark unconfirmed rather than asserting "valid until".
  const dateText = doc.validUntil
    ? `${verified || doc.expiryConfirmed ? "valid until" : "reads as"} ${new Date(
        doc.validUntil
      ).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}${
        !verified && !doc.expiryConfirmed ? " (unconfirmed)" : ""
      }`
    : "";

  return (
    <div
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      data-duplicate={duplicateWith.length > 0 ? "true" : "false"}
    >
      {duplicateWith.length > 0 && (
        <div className="flex items-start gap-2 bg-rose-600 px-5 py-2 text-xs font-semibold text-white" data-testid="duplicate-flag">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            Possible forgery — certificate number {number} also appears on{" "}
            {duplicateWith.join(", ")}. Verify before trusting this document.
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {/* vr2 item 5 — rescued registry docs name their country instead of
                a bare "Unverified document". */}
            <h3 className="font-semibold text-slate-900">
              {rescuedDocDisplay(doc)?.title ?? doc.title}
            </h3>
            {/* Registry-era states must show even without a legacy EE code or an
                expiry: an open manual request (violet) and a registry-confirmed
                doc (teal) are trust facts in their own right (plan §5.1). */}
            {(doc.estonianCode ||
              doc.validUntil ||
              doc.manualVerification ||
              doc.source === "registry") && (
              <StatusBadge status={badge.status} label={badge.label} />
            )}
            {/* #30.6 — per-doc verification level (authoritative signal). */}
            <VerificationLevelBadge
              level={verificationLevelForDoc(doc)}
              tooltip={docLevelTooltip(doc)}
              size="sm"
            />
          </div>
          <p className="text-xs text-slate-400">
            {(() => {
              // vr2 item 5 — country · code · capability state for rescued docs.
              const rescued = rescuedDocDisplay(doc);
              return rescued
                ? [rescued.countryName, rescued.code, rescued.state].filter(Boolean).join(" · ")
                : doc.docType;
            })()}
            {dateText ? ` · ${dateText}` : ""}
          </p>
          {/* Per-doc authority line (B1). Honesty audit 2026-08-13: a
              source:"registry" doc is a presence hit (teal), not a verification
              — it says "Registry-confirmed by", never "Verified against". */}
          {registry && (doc.source === "government" || doc.source === "registry") && (
            <p className="text-[11px] text-slate-400" data-testid="doc-registry-authority">
              {doc.source === "registry"
                ? t("sh.registryConfirmedBy", { authority: registry.authority })
                : t("sh.verifiedAgainst", { authority: registry.authority })}
            </p>
          )}
          {/* Persona B5 — proof link/QR reachable from the row itself, so a
              file-less (code-verified) government doc is not a dead end. */}
          {doc.source === "government" && (
            <VerifyQrToggle documentId={doc.id} token={fileToken} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {fileUrl && (
            <button
              type="button"
              onClick={() => setViewerOpen(true)}
              data-testid="agent-view-file"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              {t("sh.viewFile")}
            </button>
          )}
          {viewerOpen && (
            // VIEW-ONLY popup on the shared agent view. The file loads via the same
            // /api/files/[id]?token=... path the card link used: in open-mode the
            // owner share token authorises; in email-mode the agent is an allowed
            // signed-in viewer and the file API enforces that (token undefined).
            <DocViewer
              doc={doc}
              viewOnly
              fileToken={fileToken}
              onClose={() => setViewerOpen(false)}
            />
          )}
          {doc.estonianCode ? (
            <button
              onClick={verify}
              disabled={verifying}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {verifying ? t("sh.verifying") : cert ? t("sh.reverify") : verifyLabel}
            </button>
          ) : (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-400">
              {t("sh.noCode")}
            </span>
          )}
        </div>
      </div>

      {verifyError && (
        <div className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {verifyError}
        </div>
      )}

      {cert && (
        <div className="px-5 pb-5">
          <CertCard cert={cert} />
        </div>
      )}

      {/* Comment thread — collapsed by default; the toggle row shows the count so
          there is no need to open it just to see there are comments. */}
      <div className="border-t border-slate-100 bg-slate-50/60">
        <button
          type="button"
          onClick={() => setCommentsOpen((v) => !v)}
          aria-expanded={commentsOpen}
          data-testid="comments-toggle"
          className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left"
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {t("sh.comments")} ({comments.length})
          </span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-slate-400 transition-transform ${commentsOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {commentsOpen && (
          <div className="px-5 pb-4">
            <ul className="space-y-2">
              {comments.map((c) => (
                <li key={c.id} className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-800">{c.authorName}</span>
                    <span className="text-xs text-slate-400">{timeAgo(c.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-600">{c.text}</p>
                </li>
              ))}
              {comments.length === 0 && (
                <li className="text-sm text-slate-400">{t("sh.noComments")}</li>
              )}
            </ul>

            <form onSubmit={addComment} className="mt-3 flex flex-col gap-2">
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                rows={2}
                placeholder={t("sh.addComment")}
                className="w-full resize-y rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={posting || !commentText.trim()}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {posting ? t("sh.posting") : t("sh.post")}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
