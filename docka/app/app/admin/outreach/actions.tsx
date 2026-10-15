// app/admin/outreach/actions.tsx — client island on the outreach dashboard.
//
// UploadBoard: picks a local board.json and POSTs it to the admin upload
// route, then refreshes the server-rendered page. Modeled on ProbeButton
// (verify-uploads/actions.tsx). Copy is terse by operator rule (buttons ≤2
// words); the explanations live in title tooltips.

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_UPLOAD_BYTES } from "@/lib/outreach-snapshot";
import { fmtDateTime } from "../ui";

const BTN =
  "rounded border px-2 py-1 text-xs font-medium transition disabled:opacity-40";

// Legal MOVE targets — mirrors ACTIVE_MOVE_STAGES in lib/outreach-overrides.ts
// (never suppressed/undeliverable; the server re-validates and 400s otherwise).
const MOVE_STAGES = [
  "queued",
  "email1",
  "followup",
  "breakup",
  "replied",
  "conversation",
  "trial_won",
  "closed",
] as const;

const OVERRIDES_URL = "/api/admin/outreach/overrides";

type OverrideBody =
  | { op: "hold" | "unhold"; scope: "lead" | "company"; key: string }
  | { op: "move"; sendKey: string; toStage: string };

async function postOverride(body: OverrideBody): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(OVERRIDES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: parsed?.error ?? `Failed (${res.status})` };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export function UploadBoard(): JSX.Element {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function onPick(file: File): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      if (file.size > MAX_UPLOAD_BYTES) {
        setMsg("Too large (max 10 MB)");
        return;
      }
      const body = await file.text();
      const res = await fetch("/api/admin/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.ok) {
        setMsg(null);
        router.refresh();
      } else if (res.status === 400) {
        const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
        setMsg(parsed?.error ?? `Failed (${res.status})`);
      } else {
        setMsg(`Failed (${res.status})`);
      }
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onPick(file);
          // Reset so the SAME file can be re-picked after a fix.
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        title="Upload board.json produced by the outreach pipeline (replaces the previous snapshot)"
        className={`${BTN} border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100`}
      >
        {busy ? "Uploading…" : "Upload"}
      </button>
      {msg ? <span className="text-[11px] text-rose-600">{msg}</span> : null}
    </span>
  );
}

// ---- Manual hold / move controls (feat/manual-hold) ----------------------
//
// [R10] The Held badge is rendered server-side from the APP override store; these
// buttons only MUTATE it (POST → router.refresh()). [R11] The parent decides which
// control to enable from the hold disposition; this island stays presentational.

function HoldButton({ scope, keyValue, label }: { scope: "lead" | "company"; keyValue: string; label: string }): JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          const r = await postOverride({ op: "hold", scope, key: keyValue });
          setBusy(false);
          if (r.ok) router.refresh();
          else setErr(r.error ?? "Failed");
        }}
        title={scope === "company" ? "Hold every lead at this company (pipeline pauses them next cycle)" : "Hold this lead (pipeline pauses it next cycle)"}
        className={`${BTN} border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100`}
      >
        {busy ? "…" : label}
      </button>
      {err ? <span className="text-[10px] text-rose-600">{err}</span> : null}
    </span>
  );
}

/**
 * [R13][V6] Un-hold with a DATA-BACKED confirm: first GETs held-events for the
 * lead (opt-out/bounce during the hold window) and lists them in the confirm, or
 * states none occurred. Nudge only — nothing is auto-actioned.
 */
function UnholdButton({
  scope,
  keyValue,
  label,
  sendKey,
  heldSince,
}: {
  scope: "lead" | "company";
  keyValue: string;
  label: string;
  sendKey?: string;
  heldSince?: string | null;
}): JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          // Data-backed compliance nudge (per-lead un-hold only).
          let note = "Un-hold — the pipeline resumes this lead next cycle.";
          if (scope === "lead" && sendKey && heldSince) {
            try {
              const qs = new URLSearchParams({ sendKey, since: heldSince });
              const ev = await fetch(`${OVERRIDES_URL}/held-events?${qs.toString()}`);
              const j = (await ev.json().catch(() => null)) as { events?: { type: string; ts: string }[] } | null;
              const events = j?.events ?? [];
              note = events.length
                ? `This lead received ${events.length} opt-out/bounce event(s) while held — confirm you have checked compliance before un-holding.`
                : "No opt-out/bounce events during the hold window. Un-hold?";
            } catch {
              note = "Could not load held-window events. Un-hold anyway?";
            }
          }
          if (!window.confirm(note)) {
            setBusy(false);
            return;
          }
          const r = await postOverride({ op: "unhold", scope, key: keyValue });
          setBusy(false);
          if (r.ok) router.refresh();
          else setErr(r.error ?? "Failed");
        }}
        title="Un-hold (reversible)"
        className={`${BTN} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}
      >
        {busy ? "…" : label}
      </button>
      {err ? <span className="text-[10px] text-rose-600">{err}</span> : null}
    </span>
  );
}

/** Move a lead to an ACTIVE stage. [R8] Surfaces a rejected move's reason. */
function MoveSelect({
  sendKey,
  currentStage,
  moveStatus,
  moveReason,
  pendingToStage,
}: {
  sendKey: string;
  currentStage: string;
  moveStatus?: "pending" | "applied" | "rejected" | null;
  moveReason?: string | null;
  pendingToStage?: string | null;
}): JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blocked = currentStage === "suppressed" || currentStage === "undeliverable";
  return (
    <span className="inline-flex items-center gap-1">
      <select
        disabled={busy || blocked}
        defaultValue=""
        onChange={async (e) => {
          const toStage = e.target.value;
          e.target.value = "";
          if (!toStage) return;
          setBusy(true);
          setErr(null);
          const r = await postOverride({ op: "move", sendKey, toStage });
          setBusy(false);
          if (r.ok) router.refresh();
          else setErr(r.error ?? "Failed");
        }}
        title={blocked ? "Suppressed/undeliverable leads cannot be moved" : "Move this lead to a stage"}
        className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] text-slate-600 disabled:opacity-40"
      >
        <option value="">Move…</option>
        {MOVE_STAGES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {moveStatus === "pending" && pendingToStage ? (
        <span className="text-[10px] text-sky-600" title="Move pending — pipeline applies it next cycle">
          →{pendingToStage}
        </span>
      ) : null}
      {moveStatus === "rejected" ? (
        <span className="text-[10px] text-rose-600" title={moveReason ?? "rejected"}>
          move rejected
        </span>
      ) : null}
      {err ? <span className="text-[10px] text-rose-600">{err}</span> : null}
    </span>
  );
}

/**
 * Full per-lead hold + move cluster used on the outreach board. The server passes
 * the hold DISPOSITION (from lib/outreach-overrides.holdDisposition) so [R11] the
 * right un-hold control is offered.
 */
export function LeadHoldControls(props: {
  sendKey: string;
  company: string;
  currentStage: string;
  heldByLead: boolean;
  heldByCompany: boolean;
  companyCount: number;
  heldSince?: string | null;
  moveStatus?: "pending" | "applied" | "rejected" | null;
  moveReason?: string | null;
  pendingToStage?: string | null;
}): JSX.Element {
  const { sendKey, company, currentStage, heldByLead, heldByCompany, companyCount } = props;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {heldByCompany ? (
        // Held by company → per-lead unhold is a no-op; offer company unhold instead [R11].
        <>
          <span
            className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700"
            title={`Held by company (${companyCount} lead${companyCount === 1 ? "" : "s"})`}
          >
            Held · company
          </span>
          <UnholdButton scope="company" keyValue={company} label="Unhold co." />
        </>
      ) : heldByLead ? (
        <>
          <span className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
            Held
          </span>
          <UnholdButton scope="lead" keyValue={sendKey} label="Unhold" sendKey={sendKey} heldSince={props.heldSince ?? null} />
        </>
      ) : (
        <HoldButton scope="lead" keyValue={sendKey} label="Hold" />
      )}
      <MoveSelect
        sendKey={sendKey}
        currentStage={currentStage}
        moveStatus={props.moveStatus ?? null}
        moveReason={props.moveReason ?? null}
        pendingToStage={props.pendingToStage ?? null}
      />
    </span>
  );
}

// ---- Draft detail + decision (reply desk, wave 3 M2) ---------------------
//
// The operator's whole job in one control: read the inbound, read the drafted
// answer, optionally rewrite it, then Approve / Reject. Nothing here sends —
// it POSTs ONE decision to /api/admin/outreach/draft-action; the pipeline
// folds it and its guard 8 does the sending, from the thread's sticky mailbox.
//
// The footer is rendered as a READ-ONLY block outside the textarea: the
// pipeline appends the canonical footer exactly once and REFUSES an edit that
// carries footer text. The check below is the same rule client-side, as a
// nudge — the pipeline remains the authority.

const DRAFT_ACTION_URL = "/api/admin/outreach/draft-action";

type DraftDecisionBody =
  | { draftId: string; action: "approve" }
  | { draftId: string; action: "approve_edit"; editedBody: string }
  | { draftId: string; action: "reject"; reason: string | null }
  // Auto-ack handling: "the inbound this draft answers was a machine, not a
  // person" — the pipeline reclassifies it and resumes the cold sequence.
  | { draftId: string; action: "not_a_reply" };

async function postDraftAction(body: DraftDecisionBody): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(DRAFT_ACTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: parsed?.error ?? `Failed (${res.status})` };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/** The footer lines an edited body must not repeat (client-side nudge). */
function footerTextIn(body: string, footer: string | null): boolean {
  if (body.includes("docka.me/privacy")) return true;
  for (const line of (footer ?? "").split("\n")) {
    const t = line.trim();
    if (t.length >= 12 && body.includes(t)) return true;
  }
  return false;
}

export function DraftDecision(props: {
  draftId: string;
  label: string;
  company: string | null;
  sendKey: string | null;
  subject: string | null;
  body: string | null;
  bodyTruncated: boolean;
  footer: string | null;
  inboundBody: string | null;
  inboundBodyTruncated: boolean;
  inboundSubject: string | null;
  inboundFromDomain: string | null;
  inboundTs: string | null;
  ts: string | null;
  /** A decision already queued for this draft, not yet folded by the pipeline. */
  decided: { action: string; ts: string } | null;
}): JSX.Element {
  const router = useRouter();
  const original = props.body ?? "";
  const [text, setText] = useState(original);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const changed = editing && text.trim() !== original.trim();

  async function submit(body: DraftDecisionBody, tag: string): Promise<void> {
    setBusy(tag);
    setErr(null);
    const r = await postDraftAction(body);
    setBusy(null);
    if (r.ok) router.refresh();
    else setErr(r.error ?? "Failed");
  }

  async function onApprove(): Promise<void> {
    if (!changed) {
      await submit({ draftId: props.draftId, action: "approve" }, "approve");
      return;
    }
    if (props.bodyTruncated) {
      setErr("Body was truncated for display — answer by hand, don't send this edit");
      return;
    }
    if (footerTextIn(text, props.footer)) {
      setErr("Remove the footer from your text — the pipeline appends it once");
      return;
    }
    await submit(
      { draftId: props.draftId, action: "approve_edit", editedBody: text },
      "approve"
    );
  }

  async function onReject(): Promise<void> {
    const reason = window.prompt("Reject this draft — reason (optional):", "");
    if (reason === null) return; // cancelled
    await submit(
      { draftId: props.draftId, action: "reject", reason: reason.trim() || null },
      "reject"
    );
  }

  // No prompt: the decision is a plain reclassification (nothing is sent by it).
  async function onNotAReply(): Promise<void> {
    await submit({ draftId: props.draftId, action: "not_a_reply" }, "not_a_reply");
  }

  return (
    <details className="group" data-testid={`draft-detail-${props.draftId}`}>
      <summary className="cursor-pointer list-none">
        <span className="inline-flex items-center rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700">
          draft
        </span>
        <span className="ml-2 text-sm text-slate-700 group-open:font-medium">{props.label}</span>
        {props.decided ? (
          <span
            className="ml-2 text-[11px] text-emerald-700"
            title="Decision queued — the pipeline picks it up on its next tick (≤15 min)"
          >
            {props.decided.action} queued
          </span>
        ) : null}
      </summary>

      <div className="mt-2 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
        {/* the inbound this answers */}
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-400">
            Their message
            {props.inboundFromDomain ? ` · ${props.inboundFromDomain}` : ""}
            {props.inboundTs ? ` · ${fmtDateTime(Date.parse(props.inboundTs))}` : ""}
          </p>
          {props.inboundSubject ? (
            <p className="text-xs font-medium text-slate-600">{props.inboundSubject}</p>
          ) : null}
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-700">
            {props.inboundBody ?? "(not captured)"}
          </pre>
          {props.inboundBodyTruncated ? (
            <p className="text-[10px] text-amber-600">truncated for display</p>
          ) : null}
        </div>

        {/* the drafted answer */}
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-400">
            Drafted answer{props.subject ? ` · ${props.subject}` : ""}
            {props.sendKey ? ` · ${props.company ?? props.sendKey}` : ""}
          </p>
          {editing ? (
            <textarea
              value={text}
              rows={10}
              onChange={(e) => setText(e.target.value)}
              data-testid={`draft-edit-${props.draftId}`}
              className="mt-1 w-full rounded border border-slate-300 p-2 font-mono text-xs text-slate-800"
            />
          ) : (
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-800">
              {text}
            </pre>
          )}
          {props.bodyTruncated ? (
            <p className="text-[10px] text-amber-600">
              truncated for display — the pipeline ledger holds the full text
            </p>
          ) : null}
        </div>

        {/* the canonical footer — never editable, appended by the pipeline */}
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-400">
            Footer (added automatically, not editable)
          </p>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-dashed border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-400">
            {props.footer ?? "(the pipeline appends the standard footer)"}
          </pre>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setEditing((v) => !v)}
            title="Rewrite the answer before approving — your words go out verbatim"
            className={`${BTN} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}
          >
            {editing ? "Cancel edit" : "Edit"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void onApprove()}
            title="Approve — the pipeline sends it from this thread's mailbox on its next tick"
            className={`${BTN} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}
            data-testid={`draft-approve-${props.draftId}`}
          >
            {busy === "approve" ? "…" : changed ? "Send edit" : "Approve"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void onReject()}
            title="Reject — nothing is sent; the draft closes and the lead waits for you"
            className={`${BTN} border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`}
            data-testid={`draft-reject-${props.draftId}`}
          >
            {busy === "reject" ? "…" : "Reject"}
          </button>
          <button
            type="button"
            disabled={busy !== null || props.decided !== null}
            onClick={() => void onNotAReply()}
            title="Their message was an automated acknowledgement, not a person — nothing is sent; the pipeline drops this draft and resumes the cold sequence on its normal cadence"
            className={`${BTN} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}
            data-testid={`draft-not-a-reply-${props.draftId}`}
          >
            {busy === "not_a_reply" ? "…" : "Not a real reply → continue sequence"}
          </button>
          {err ? <span className="text-[11px] text-rose-600">{err}</span> : null}
        </div>
      </div>
    </details>
  );
}

// ---- "Needs a human look" card (auto-ack handling, 2026-09-08) -------------
//
// The pipeline stopped a cold sequence on an inbound that LOOKED automated
// (weak signals only) and refused to guess. The card shows why (the operator
// note) and what came in (the inbound excerpt), and offers the two answers the
// pipeline can act on — both travel down the SAME draft-action channel as
// Approve / Reject, keyed by the ledger row's draftId:
//
//   * "Not a real reply → continue sequence"  = not_a_reply — the pipeline
//     reclassifies the inbound as an auto-ack and resumes the sequence.
//   * "This is a real reply"                   = reject — dismisses the card;
//     the lead stays `replied` and the operator answers from Gmail.
//
// Nothing here sends anything.

export function NeedsHumanCard(props: {
  draftId: string;
  label: string;
  company: string | null;
  sendKey: string | null;
  subject: string | null;
  note: string | null;
  inboundBody: string | null;
  inboundBodyTruncated: boolean;
  inboundSubject: string | null;
  inboundFromDomain: string | null;
  inboundTs: string | null;
  ts: string | null;
  /** A decision already queued for this row, not yet folded by the pipeline. */
  decided: { action: string; ts: string } | null;
}): JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const locked = busy !== null || props.decided !== null;

  async function submit(body: DraftDecisionBody, tag: string): Promise<void> {
    setBusy(tag);
    setErr(null);
    const r = await postDraftAction(body);
    setBusy(null);
    if (r.ok) router.refresh();
    else setErr(r.error ?? "Failed");
  }

  return (
    <details className="group" data-testid={`needs-human-detail-${props.draftId}`}>
      <summary className="cursor-pointer list-none">
        <span className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
          needs a human look
        </span>
        <span className="ml-2 text-sm text-slate-700 group-open:font-medium">{props.label}</span>
        {props.decided ? (
          <span
            className="ml-2 text-[11px] text-emerald-700"
            title="Decision queued — the pipeline picks it up on its next tick (≤15 min)"
          >
            {props.decided.action} queued
          </span>
        ) : null}
      </summary>

      <div className="mt-2 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-400">
            Why the pipeline stopped
            {props.sendKey ? ` · ${props.company ?? props.sendKey}` : ""}
            {props.subject ? ` · ${props.subject}` : ""}
          </p>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-amber-50 p-2 text-xs text-amber-900">
            {props.note ?? "(no note from the pipeline)"}
          </pre>
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-400">
            Their message
            {props.inboundFromDomain ? ` · ${props.inboundFromDomain}` : ""}
            {props.inboundTs ? ` · ${fmtDateTime(Date.parse(props.inboundTs))}` : ""}
          </p>
          {props.inboundSubject ? (
            <p className="text-xs font-medium text-slate-600">{props.inboundSubject}</p>
          ) : null}
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-700">
            {props.inboundBody ?? "(not captured)"}
          </pre>
          {props.inboundBodyTruncated ? (
            <p className="text-[10px] text-amber-600">truncated for display</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={locked}
            onClick={() => void submit({ draftId: props.draftId, action: "not_a_reply" }, "not_a_reply")}
            title="It was an automated acknowledgement — nothing is sent; the pipeline resumes the cold sequence on its normal cadence"
            className={`${BTN} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}
            data-testid={`needs-human-not-a-reply-${props.draftId}`}
          >
            {busy === "not_a_reply" ? "…" : "Not a real reply → continue sequence"}
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => void submit({ draftId: props.draftId, action: "reject", reason: null }, "reject")}
            title="A person wrote this — the card closes, the lead stays replied, and you answer them yourself"
            className={`${BTN} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}
            data-testid={`needs-human-real-reply-${props.draftId}`}
          >
            {busy === "reject" ? "…" : "This is a real reply"}
          </button>
          <span className="text-[11px] text-slate-400">reply from Gmail</span>
          {err ? <span className="text-[11px] text-rose-600">{err}</span> : null}
        </div>
      </div>
    </details>
  );
}

/** Per-company hold cluster (used on /admin/leads, which is company-level). */
export function CompanyHoldControls(props: {
  company: string;
  held: boolean;
  companyCount: number;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      {props.held ? (
        <>
          <span
            className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700"
            title={`Held (${props.companyCount} lead${props.companyCount === 1 ? "" : "s"} in this snapshot)`}
          >
            Held
          </span>
          <UnholdButton scope="company" keyValue={props.company} label="Unhold" />
        </>
      ) : (
        <HoldButton scope="company" keyValue={props.company} label={`Hold (${props.companyCount})`} />
      )}
    </span>
  );
}
