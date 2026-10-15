import { NextRequest, NextResponse } from "next/server";
import {
  readDB,
  updateDB,
  id,
  shareToken,
  isSeafarerState,
  type Seafarer,
  type SeafarerState,
} from "@/lib/db";
import { backfillOwnerIdentity } from "@/lib/verify";
import { assignmentBlockers, isAssignmentAdvance, SEA_STATE } from "@/lib/compliance";
import { duplicateNameIndex } from "@/lib/duplicates";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import {
  checkAccess,
  findGrant,
  setBoardHidden,
  deleteFromBoard,
  startAssignment,
  closeAssignment,
  activeAssignmentsFor,
} from "@/lib/access";
import { deleteRateLimited } from "@/lib/delete-rate-limit";
import { impersonationStampFor } from "@/lib/impersonation";
import { buildOwnerPayload } from "@/lib/owner-payload";
import { STATE_LABELS } from "@/lib/pipeline";
import { isAvailability } from "@/lib/availability";
import { requiredSetFor } from "@/lib/required-docs";
import { getConfigForAgent } from "@/lib/required-docs-store";
import { listSeafarersForAgent, listHiddenSeafarersForAgent } from "@/lib/agentData";
import { activeDocs } from "@/lib/archive";
import { normalizeReminderSettings, type ReminderSettings } from "@/lib/reminders-calendar";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
  sampleTokenRateLimited,
  SAMPLE_CACHE_CONTROL,
} from "@/lib/sample-guard";
import { UPLOAD_DIR } from "@/lib/profile-photo";
import { SELF_ACCESS_TTL_MS, isClaimed, claimStateOf, placeholderManagedBy } from "@/lib/claim-state";
import { isEmailish } from "@/lib/roster-parse";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// Seaman SELF-ACCESS token idle TTL. The `?token=` resolve below only serves the
// seaman's OWN dashboard while their token has been used within this window; idle
// beyond it falls through to the SAME 404 as an unknown token. Every valid resolve
// slides the window (throttled). NB: this bounds the shared-browser auto-replay
// window / cleans up abandoned tokens — it is NOT leaked-token revocation (the
// same value still resolves with no TTL on the untouched agent /share/<token>
// path). The 1h me-path throttle (me/route.ts) means an actively-signed-in seaman's
// effective idle window is ~24h–25h — it errs toward keeping a live token alive.
// SELF_ACCESS_TTL_MS is the SINGLE definition in lib/claim-state.ts (imported above);
// the value + the :145-147 strict-`>` boundary logic below are unchanged.
const TOKEN_STAMP_THROTTLE_MS = 5 * 60 * 1000;       // token-path slide granularity (5 min)

// GET /api/seafarers
//   ?id=...        -> one seafarer + their documents
//   ?token=...     -> one seafarer (by share token) + their documents
//   ?view=hidden   -> this agent's board-HIDDEN crew (the "Hidden crew" panel)
//   (no param)     -> the agent's VISIBLE board crew (board-hidden dropped)
export async function GET(req: NextRequest) {
  const db = readDB();
  const sid = req.nextUrl.searchParams.get("id");
  const token = req.nextUrl.searchParams.get("token");
  const view = req.nextUrl.searchParams.get("view");

  // Whole-roster mode for the agent dashboard — GRANT-SCOPED + fail-closed: it
  // requires an agent session and returns only the seafarers who granted THAT
  // agent access (default-deny via lib/agentData.ts). The seaman's own reads use
  // ?id / ?token below and are not affected.
  if (!sid && !token) {
    const session = await agentSession();
    const billingGate = requireBillingReadable(session);
    if (!billingGate.ok) return billingGate.response;
    if (!session?.user) {
      return NextResponse.json(
        { ok: false, error: "Sign in as an agent to list crew." },
        { status: 401 }
      );
    }
    // Bug1 — the board render drops board-hidden crew (includeHidden:false); ?view=hidden
    // lists exactly the hidden ones. Both stay grant-scoped/fail-closed.
    const base =
      view === "hidden"
        ? listHiddenSeafarersForAgent(session.agentId)
        : listSeafarersForAgent(session.agentId, false);
    const visible = base
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        ...s,
        // Hidden-crew panel needs the SERVER-computed claimed flag so the Delete
        // confirm copy never trusts a client-side guess.
        ...(view === "hidden" ? { claimed: isClaimed(s) || s.isSample === true } : null),
        // Agent board sees only ACTIVE (non-archived) docs — an archived doc is a
        // retired past doc and must not count toward completeness / validity here.
        documents: activeDocs(db.documents.filter((d) => d.seafarerId === s.id)).sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt)
        ),
      }));
    return NextResponse.json({ ok: true, seafarers: visible });
  }

  // Two distinct trust models resolve a single seafarer:
  //   ?token= : the seaman's own possession-trust self-service. The share token is
  //             an unguessable, rotatable secret — holding it IS the authorisation.
  //   ?id=    : AGENT-only, grant-scoped. A raw seafarerId is NOT a secret (it flows
  //             through agent URLs, notes and exports), so reading by id requires a
  //             signed-in agent with a LIVE grant. This closes the id-replay oracle:
  //             an unauthenticated or un-granted ?id= resolves to nothing (404).
  let seafarer: Seafarer | undefined;
  // True only for the seaman's OWN possession-trust (token) read — the path that is
  // allowed to self-heal the owner's verified identity. The agent ?id= path never is.
  let viaOwnerToken = false;
  if (token) {
    // CHOKEPOINT (sample-guard §D4): resolve via the canonical resolver, pinned to
    // TODAY'S acceptance for this route — the OPEN token only (PHASE0-CENSUS row 1).
    const subject = resolveTokenSubject(db, token, "read", ["open"]);
    if (subject !== null && subject !== SAMPLE_WRITE_DENIED && subject.isSample) {
      // PUBLIC curated sample read. READ PURITY (plan §D4 v3-1): no 24h-idle TTL
      // check, no shareTokenLastUsedAt stamp, no backfillOwnerIdentity — a public
      // GET performs ZERO writes and a sample token never idles out. Rows are the
      // curated (sample:true) set only; the seafarer is the redacted projection.
      if (sampleTokenRateLimited(token)) {
        return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
      }
      // SHARED §D8 projection (lib/owner-payload.ts): curated (sample:true) rows
      // only, flows filtered to sample agencies, propagation/appraisal-delete
      // requests never curated, seafarer through the allowlist redaction. Same
      // builder the public /sample/seafarer page renders from — the two can't drift.
      const payload = buildOwnerPayload(db, subject.seafarer.id, { curatedOnly: true });
      return NextResponse.json(
        { ok: true, ...payload },
        { headers: { "Cache-Control": SAMPLE_CACHE_CONTROL } }
      );
    }
    const found =
      subject !== null && subject !== SAMPLE_WRITE_DENIED ? subject.seafarer : undefined;
    if (found) {
      const last = found.shareTokenLastUsedAt;               // undefined on legacy
      const now = Date.now();
      // BOUNDARY: strictly greater-than 24h idle expires. Exactly 24h (now - last === TTL) still
      // SERVES. Off-by-one is intentional.
      const expired = typeof last === "number" && now - last > SELF_ACCESS_TTL_MS;
      if (expired) {
        // Idle > 24h => behave EXACTLY like an unknown token: leave `seafarer` undefined so we
        // fall through to the shared 404 below. Do NOT distinguish "expired" from "never existed".
      } else {
        seafarer = found;
        viaOwnerToken = true;
        // Sliding refresh, THROTTLED: only rewrite db.json when the stamp is absent (legacy ->
        // fresh window) or older than the throttle granularity.
        if (last === undefined || now - last > TOKEN_STAMP_THROTTLE_MS) {
          await updateDB((d) => {
            const s = d.seafarers.find((x) => x.id === found.id);
            if (s) s.shareTokenLastUsedAt = now;
          });
        }
      }
    }
  } else if (sid) {
    const session = await agentSession();
    const billingGate = requireBillingReadable(session);
    if (!billingGate.ok) return billingGate.response;
    if (session?.user && checkAccess(session.agentId, sid).allowed) {
      seafarer = db.seafarers.find((s) => s.id === sid);
    }
  }

  if (!seafarer) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  // Owner self-heal: when the seaman opens their OWN profile, back-fill the verified
  // identity from a government-verified doc if it was never populated. Strictly scoped
  // to this owner's seafarerId; the agent ?id= read is deliberately excluded. Re-read
  // after so the response reflects the freshly-populated fields.
  if (viaOwnerToken) {
    await backfillOwnerIdentity(seafarer.id);
    const fresh = readDB();
    // SHARED owner-payload projection (lib/owner-payload.ts, §D8): documents /
    // docRequests / profileChanges / seaService / flows / propagationRequests /
    // appraisalDeleteRequests exactly as this route assembled them inline before —
    // behavior-preserving (golden suite). The seaman owns this view of their data.
    const payload = buildOwnerPayload(fresh, seafarer.id);
    return NextResponse.json({
      ok: true,
      ...payload,
      // Defensive: keep the pre-extraction `?? seafarer` fallback should the row
      // vanish between the write above and the fresh read (never in practice).
      seafarer: payload.seafarer ?? seafarer,
    });
  }

  const documents = db.documents
    .filter((d) => d.seafarerId === seafarer!.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const docRequests = db.docRequests.filter((r) => r.seafarerId === seafarer!.id);
  const profileChanges = db.profileChanges.filter((r) => r.seafarerId === seafarer!.id);
  const seaService = db.seaService.filter((e) => e.seafarerId === seafarer!.id);

  return NextResponse.json({ ok: true, seafarer, documents, docRequests, profileChanges, seaService });
}

// POST /api/seafarers — REMOVED (seaman self-signup is now GOOGLE-ONLY).
//
// The anonymous (no-login) create path — name/rank form, photo-first, and the
// "paste a certificate code" bootstrap — has been removed. A seaman now signs in
// with Google first (which creates their owned profile in auth.ts), then fills that
// profile in via the AUTHENTICATED, session-scoped POST /api/seafarers/self. This
// endpoint therefore no longer creates anything: any legacy anonymous client is told
// to sign in (401). Agent-side crew creation is unaffected — it lives on
// POST /api/invite (agent-gated) and still bulk-creates placeholder seafarers.
// NB: existing anonymous seafarers already in the store are untouched and stay
// reachable via their share token.
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "Sign in with Google to create your seafarer profile." },
    { status: 401 }
  );
}

// PATCH /api/seafarers
//   { id, state }             -> move a seafarer to another pipeline state
//   { id, rotateToken: true } -> REVOKE the current share link and mint a new one
//
// Rotating the token instantly kills the old /share/<token> link (anyone holding
// it gets "Link not found") while keeping every uploaded document intact — they
// are keyed by seafarerId, not by the token — so revoking access never orphans
// the seaman's papers. This is the explicit revoke/rotate control the seaman
// controls himself, instead of "start a whole new profile".
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    state?: string;
    /** @deprecated alias of resetOpenToken — resets the OPEN share link. */
    rotateToken?: boolean;
    /** Seaman self-service: rotate ONLY the OPEN share link (private link untouched). */
    resetOpenToken?: boolean;
    /** Seaman self-service: rotate ONLY the PRIVATE (email) share link (open link untouched). */
    resetEmailToken?: boolean;
    /** Documented override of the sea-readiness hard-block. */
    override?: boolean;
    overrideReason?: string;
    /**
     * Seaman self-service (owner) OR agent (grant) — set/override the seafarer's rank.
     * Direct save, NO shore-approval gate. Rank stays authoritative (drives the
     * required-docs matrix + board completeness).
     */
    rank?: string;
    /**
     * Seaman self-service (owner) OR agent (grant) — set/override declared availability
     * ('open' | 'open_from' | 'occupied'). Direct save, NO approval gate. `availableFrom`
     * (yyyy-mm-dd) is required for and only kept for 'open_from'.
     */
    availability?: string;
    availableFrom?: string | null;
    /** Voyage/crewing metadata edits (no state change). */
    vessel?: string | null;
    rotationEnd?: string | null;
    /** Vessel type / flag of the berth — drive the required-docs matrix add-on layers. */
    vesselType?: string | null;
    flagState?: string | null;
    /** Seaman self-service: toggle auto-archive-of-expired on the OWN profile. */
    autoArchiveExpired?: boolean;
    /** Seaman self-service: the allow-list of agent e-mails for the PRIVATE (email) link. */
    allowedEmails?: string[];
    /** Seaman self-service: expiry-reminder calendar settings on the OWN profile. */
    reminderSettings?: Partial<ReminderSettings>;
    /**
     * Seaman self-service: CLEAR the government-verified identity when no verified
     * document backs it any more. Resets identityVerified + every verified-identity
     * field to null and deletes the stored verified photo file. Leaves customPhotoFile.
     */
    clearVerifiedIdentity?: boolean;
    /** Seaman self-service authorisation: the OWNER share token (possession secret). */
    token?: string;
    /** Bug1 (agent) — remove this seaman from THIS agent's board (reversible; grant stays ACTIVE). */
    hide?: boolean;
    /** Bug1 (agent) — restore a board-hidden seaman to THIS agent's board. */
    restore?: boolean;
    /**
     * Agent (grant) — set/clear the imported CONTACT e-mail on an UNCLAIMED placeholder
     * (the fallback recipient of the PROFILE INVITE). CONTACT field only — never copied
     * into ownerEmail, never gates auth. Placeholder-only + creator-gated; a claimed row
     * 409s. `null`/blank clears it.
     */
    importedEmail?: string | null;
  };
  const sid = (body.id ?? "").trim();

  if (!sid) {
    return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  }

  // #9 — DEFAULT-DENY allow-list. A body whose mutation intent is PURELY within the
  // TOKEN-SERVICEABLE self-service set (rank / availability / auto-archive / allowed-emails
  // / reminders / clear-verified / token-rotation) routes to its owner-token branch, EACH of
  // which calls its own owner-auth (owner share token OR granted agent). Those branches must
  // therefore be EXEMPT from the central grant guard below — otherwise a stray, ungranted
  // agent cookie riding on a seaman's valid owner-token PATCH would 404 before the branch runs
  // (the #9 rank bug, which also afflicted token-rotation). Any body NOT purely in this
  // allow-list (vessel, state-move, hide, or an UNKNOWN shape) still hits the guard, so a
  // future agent-only branch added without its own check FAILS CLOSED (default-deny — no
  // silent fail-open, no tsc reliance).
  // rotateToken / resetOpenToken / resetEmailToken are OWNER-serviceable: their branch
  // (below) self-authorizes via the SAME owner-token-OR-granted-agent check as ownerAuthorised()
  // (owner holds either share token, or a signed-in agent with a live grant). They belong in
  // the token-serviceable set so a seaman rotating their OWN link while a stray, ungranted
  // agent cookie is present is not 404'd by the central guard before the self-authorizing
  // branch runs (the #9 stray-cookie bug, applied to token rotation).
  const tokenServiceablePresent =
    body.rank !== undefined ||
    body.availability !== undefined ||
    body.autoArchiveExpired !== undefined ||
    body.allowedEmails !== undefined ||
    body.reminderSettings !== undefined ||
    body.clearVerifiedIdentity === true ||
    body.rotateToken === true ||
    body.resetOpenToken === true ||
    body.resetEmailToken === true;
  const agentOnlyPresent =
    body.state !== undefined ||
    body.vessel !== undefined ||
    body.vesselType !== undefined ||
    body.flagState !== undefined ||
    body.rotationEnd !== undefined ||
    body.hide === true ||
    body.restore === true ||
    body.importedEmail !== undefined;
  const tokenServiceable = tokenServiceablePresent && !agentOnlyPresent;

  // SAMPLE GUARD (census row 1): a sample subject is READ-ONLY through every
  // self-service / metadata write — ALL SIX token-serviceable segments (rank,
  // availability, autoArchive, allowedEmails, reminderSettings,
  // clearVerifiedIdentity, rotate/reset — the public-DoS + identity-strip vectors)
  // AND the agent voyage-metadata writes DENY with one 403, regardless of whether
  // the caller authorised by token or by grant. Only the agent's OWN board
  // operations (pipeline stage move, hide/restore — per-grant state) stay allowed.
  {
    const sampleDeniedIntent =
      tokenServiceablePresent ||
      body.vessel !== undefined ||
      body.vesselType !== undefined ||
      body.flagState !== undefined ||
      body.rotationEnd !== undefined ||
      body.importedEmail !== undefined;
    if (sampleDeniedIntent && readDB().seafarers.find((s) => s.id === sid)?.isSample === true) {
      return sampleReadOnlyResponse();
    }
  }

  // CHOKEPOINT owner-token check shared by every token-serviceable branch below
  // (replaces the previous per-branch inline either-token equality finds). Pinned
  // to TODAY'S acceptance: open + email token, UNGATED (PHASE0-CENSUS row 1 audit;
  // plan R15 — behavior preserved, reported separately). intent:"write" makes a
  // sample subject's token resolve to the DENY marker, never an authorisation.
  function ownerByShareToken(): boolean {
    const t = (body.token ?? "").trim();
    if (!t) return false;
    const subject = resolveTokenSubject(readDB(), t, "write", ["open", "email"]);
    return subject !== null && subject !== SAMPLE_WRITE_DENIED && subject.seafarer.id === sid;
  }

  // GRANT-SCOPE every AGENT-initiated mutation NOT covered by the token-serviceable
  // allow-list (state move / vessel / hide / unknown). When an agent session is present
  // the target seafarer MUST be one the agent holds a live grant for; otherwise 404 with
  // no mutation — an agent cannot drive another tenant's seafarer through the pipeline.
  // (A seafarer acting in their own portal has no agent session and is unaffected. Token
  // rotation is owner-serviceable and self-authorizes in its own branch, so it is exempt.)
  const patchSession = await agentSession();
  // CANONICAL ACTOR ORDER (F3, findings 8 + 19). The gate used to fire HERE, before
  // everything — so a seaman's valid owner-token PATCH 402'd whenever the browser also
  // carried a blocked agency's session (the same stray-cookie shape the #9 fix closed
  // for the grant guard on the next line), and a blocked agent could tell a foreign id
  // from a nonexistent one. The gate now binds to the AGENT arm only, after checkAccess.
  if (patchSession?.user && !tokenServiceable) {
    if (!checkAccess(patchSession.agentId, sid).allowed) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const billingGate = requireBillingWritable(patchSession);
    if (!billingGate.ok) return billingGate.response;
  }
  // A TOKEN-SERVICEABLE body self-authorises in its own branch (owner share token OR a
  // granted agent). The billing tier binds to the AGENT arm of that authorisation only:
  // with a valid OWNER token present the request proceeds regardless of tier (R2-9).
  if (patchSession?.user && tokenServiceable && !ownerByShareToken()) {
    const billingGate = requireBillingWritable(patchSession);
    if (!billingGate.ok) return billingGate.response;
  }

  // Bug1 — AGENT board hide / restore. Agent-only, grant-scoped: the checkAccess guard
  // above already 404'd an agent with no live grant for `sid`, and setBoardHidden re-checks
  // ownership (grant.agentId === caller) inside its own transact. Hide is blocked at sea /
  // under a live assignment (409). Reversible; never revokes the grant, never touches consent.
  if (body.hide === true || body.restore === true) {
    if (!patchSession?.user) {
      return NextResponse.json(
        { ok: false, error: "Sign in as an agent to change your board." },
        { status: 401 }
      );
    }
    const grant = findGrant(readDB(), sid, patchSession.agentId);
    if (!grant) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const result = await setBoardHidden(
      grant.id,
      patchSession.agentId,
      body.hide === true,
      impersonationStampFor(patchSession)
    );
    if (!result.ok) {
      if (result.error === "at-sea") {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Can't hide a seaman who is at sea under your agency — they must stay in oversight until they return.",
            atSea: true,
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const seafarer = readDB().seafarers.find((s) => s.id === sid) ?? null;
    return NextResponse.json({
      ok: true,
      hidden: body.hide === true,
      seafarer: seafarer ? { ...seafarer, state: grant.stage ?? seafarer.state } : null,
    });
  }

  // Owner authorisation shared by the rank + availability self-service branches: the
  // OWNER share token (either link) OR a signed-in agent holding a live grant. A token
  // for another seafarer, or an un-granted agent, resolves nothing => 404, so a seaman
  // can only ever change THEIR OWN profile and an agent only a granted one. The agent
  // path goes through the SAME fail-closed checkAccess guard — never a bypass.
  function ownerAuthorised(): boolean {
    const ownerByToken = ownerByShareToken();
    const ownerByAgent = !!patchSession?.user && checkAccess(patchSession.agentId, sid).allowed;
    return ownerByToken || ownerByAgent;
  }

  // RANK — seaman (owner token) sets his own rank, or an agent (grant) overrides it.
  // Direct save, no approval gate; rank stays the authoritative required-docs driver.
  if (
    body.rank !== undefined &&
    body.state === undefined &&
    !body.rotateToken &&
    !body.resetOpenToken &&
    !body.resetEmailToken
  ) {
    if (!ownerAuthorised()) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const rank = String(body.rank ?? "").trim().slice(0, 100);
    const result = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      seafarer.rank = rank;
      return seafarer;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, seafarer: result });
  }

  // AVAILABILITY — seaman (owner token) declares his own availability, or an agent
  // (grant) overrides it. Direct save, no approval gate (marking yourself occupied
  // must be instant). `availableFrom` (yyyy-mm-dd) is required for and only stored for
  // the 'open_from' state; every other state clears it to null.
  if (
    body.availability !== undefined &&
    body.state === undefined &&
    !body.rotateToken &&
    !body.resetOpenToken &&
    !body.resetEmailToken
  ) {
    if (!ownerAuthorised()) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const availability = String(body.availability ?? "").trim();
    if (!isAvailability(availability)) {
      return NextResponse.json(
        { ok: false, error: "Choose a valid availability (Open now, Open from a date, or Occupied)." },
        { status: 400 }
      );
    }
    let availableFrom: string | null = null;
    if (availability === "open_from") {
      const raw = (body.availableFrom ?? "").trim();
      if (!raw) {
        return NextResponse.json(
          { ok: false, error: "Enter the date you become available." },
          { status: 400 }
        );
      }
      const d = new Date(raw);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ ok: false, error: "Enter a valid availability date." }, { status: 400 });
      }
      availableFrom = d.toISOString().slice(0, 10);
    }
    const result = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      seafarer.availability = availability;
      seafarer.availableFrom = availableFrom;
      return seafarer;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, seafarer: result });
  }

  // Seaman self-service: toggle the auto-archive-expired setting on the seaman's OWN
  // profile. Authorised by the OWNER share token (possession secret) OR a signed-in
  // agent with a live grant — mirrors the document-edit auth in /api/documents. A
  // token for another seafarer, or an agent without a grant, resolves nothing => 404.
  // A seaman can only ever change THEIR OWN setting.
  if (
    body.autoArchiveExpired !== undefined &&
    body.state === undefined &&
    !body.rotateToken &&
    body.vessel === undefined &&
    body.rotationEnd === undefined
  ) {
    const ownerByToken = ownerByShareToken();
    const ownerByAgent = !!patchSession?.user && checkAccess(patchSession.agentId, sid).allowed;
    if (!ownerByToken && !ownerByAgent) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const next = body.autoArchiveExpired === true;
    const result = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      seafarer.autoArchiveExpired = next;
      return seafarer;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, seafarer: result });
  }

  // Seaman self-service: set the allowed agent e-mail allow-list for the PRIVATE
  // (email) share link on the seaman's OWN profile. Same owner authorisation as the
  // auto-archive toggle above (OWNER share token — either link — OR a signed-in agent
  // holding a live grant). A token for another seafarer, or an ungranted agent,
  // resolves nothing => 404, so a seaman can only ever change THEIR OWN allow-list —
  // never another seafarer's. E-mails are trimmed, lower-cased, de-duplicated and
  // lightly validated.
  if (
    body.allowedEmails !== undefined &&
    body.state === undefined &&
    !body.rotateToken &&
    !body.resetOpenToken &&
    !body.resetEmailToken &&
    body.vessel === undefined &&
    body.rotationEnd === undefined &&
    body.autoArchiveExpired === undefined
  ) {
    const ownerByToken = ownerByShareToken();
    const ownerByAgent = !!patchSession?.user && checkAccess(patchSession.agentId, sid).allowed;
    if (!ownerByToken && !ownerByAgent) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }

    let emails: string[] | undefined;
    if (body.allowedEmails !== undefined) {
      if (!Array.isArray(body.allowedEmails)) {
        return NextResponse.json(
          { ok: false, error: "allowedEmails must be a list of e-mail addresses." },
          { status: 400 }
        );
      }
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of body.allowedEmails) {
        if (typeof raw !== "string") continue;
        const e = raw.trim().toLowerCase();
        if (!e || e.length > 254 || !emailRe.test(e) || seen.has(e)) continue;
        seen.add(e);
        cleaned.push(e);
        if (cleaned.length >= 50) break; // sane cap
      }
      emails = cleaned;
    }

    const result = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      if (emails !== undefined) seafarer.allowedEmails = emails;
      return seafarer;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, seafarer: result });
  }

  // Seaman self-service: save the EXPIRY-REMINDER calendar settings on the seaman's
  // OWN profile. Same owner authorisation as the auto-archive / allowed-emails
  // branches (OWNER share token — either link — OR a signed-in agent holding a live
  // grant). A token for another seafarer, or an ungranted agent, resolves nothing =>
  // 404. Values are clamped to safe bounds server-side so a crafted payload cannot
  // explode the generated calendar.
  if (
    body.reminderSettings !== undefined &&
    body.state === undefined &&
    !body.rotateToken &&
    !body.resetOpenToken &&
    !body.resetEmailToken &&
    body.vessel === undefined &&
    body.rotationEnd === undefined &&
    body.autoArchiveExpired === undefined &&
    body.allowedEmails === undefined
  ) {
    const ownerByToken = ownerByShareToken();
    const ownerByAgent = !!patchSession?.user && checkAccess(patchSession.agentId, sid).allowed;
    if (!ownerByToken && !ownerByAgent) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const settings = normalizeReminderSettings(body.reminderSettings);
    const result = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      seafarer.reminderLeadValue = settings.leadValue;
      seafarer.reminderLeadUnit = settings.leadUnit;
      seafarer.reminderCount = settings.count;
      seafarer.reminderIntervalDays = settings.intervalDays;
      return seafarer;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, seafarer: result });
  }

  // Seaman self-service: CLEAR the government-verified identity on the seaman's OWN
  // profile when no verified document backs it any more (all documents — or the
  // verified one specifically — were deleted). Resets identityVerified + every
  // verified-identity field to null and deletes the downloaded verified photo file
  // from uploads/; the owner's CUSTOM photo is left untouched. Same owner
  // authorisation as the other self-service branches (OWNER share token — either link
  // — OR a signed-in agent holding a live grant). A token for another seafarer, or an
  // ungranted agent, resolves nothing => 404, so a seaman can only ever clear THEIR
  // OWN identity. With no government-verified document present, the owner self-heal
  // (backfillOwnerIdentity) leaves the cleared profile as-is, so it does not repopulate.
  if (
    body.clearVerifiedIdentity === true &&
    body.state === undefined &&
    !body.rotateToken &&
    !body.resetOpenToken &&
    !body.resetEmailToken &&
    body.vessel === undefined &&
    body.rotationEnd === undefined &&
    body.autoArchiveExpired === undefined &&
    body.allowedEmails === undefined &&
    body.reminderSettings === undefined
  ) {
    const ownerByToken = ownerByShareToken();
    const ownerByAgent = !!patchSession?.user && checkAccess(patchSession.agentId, sid).allowed;
    if (!ownerByToken && !ownerByAgent) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const outcome = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      const removedPhoto = seafarer.verifiedPhotoFile ?? null;
      seafarer.identityVerified = false;
      seafarer.identityVerifiedAt = null;
      seafarer.verifiedName = null;
      seafarer.personalCode = null;
      seafarer.birthDate = null;
      seafarer.photoUrl = null;
      seafarer.issuerCountry = null;
      seafarer.verifiedPhotoFile = null;
      // customPhotoFile is the seaman's OWN upload — never touched here.
      return { seafarer, removedPhoto };
    });
    if (!outcome) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    // Best-effort: remove the downloaded verified photo file from disk (basename
    // guard). A missing/locked file must not fail the clear — the record is already
    // reset. The owner's custom photo file (if any) is untouched.
    if (outcome.removedPhoto) {
      try {
        const p = path.join(UPLOAD_DIR, path.basename(outcome.removedPhoto));
        if (p.startsWith(UPLOAD_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore — identity already cleared */
      }
    }
    return NextResponse.json({ ok: true, seafarer: outcome.seafarer });
  }

  // Agent (grant) — set/clear the imported CONTACT e-mail on an UNCLAIMED placeholder.
  // This is the fallback recipient of the PROFILE INVITE (/api/reminders kind "claim").
  // CONTACT field ONLY: written here alone, never copied into ownerEmail, gates no auth.
  // Self-authorising (#9 pattern): an anonymous / token-only caller has no agent session
  // (401); an ungranted agent 404s. Placeholder-only + creator-gated; a claimed row 409s
  // (the seafarer manages their own contact details once they own the profile).
  if (
    body.importedEmail !== undefined &&
    body.state === undefined &&
    !body.rotateToken &&
    !body.resetOpenToken &&
    !body.resetEmailToken &&
    body.vessel === undefined &&
    body.vesselType === undefined &&
    body.flagState === undefined &&
    body.rotationEnd === undefined
  ) {
    if (!patchSession?.user) {
      return NextResponse.json(
        { ok: false, error: "Sign in as an agent to edit a crew e-mail." },
        { status: 401 }
      );
    }
    if (!checkAccess(patchSession.agentId, sid).allowed) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    const s0 = readDB().seafarers.find((s) => s.id === sid);
    if (!s0) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    if (claimStateOf(s0).kind !== "placeholder") {
      return NextResponse.json(
        {
          ok: false,
          error: "This profile is claimed — the seafarer manages their own contact details.",
        },
        { status: 409 }
      );
    }
    if (!placeholderManagedBy(s0, patchSession.agentId)) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    // Value: null / blank-after-trim clears; otherwise trim FIRST (so the stored value
    // matches every later comparison + the To: header), then cap(128) + isEmailish.
    let next: string | null;
    if (body.importedEmail === null) {
      next = null;
    } else {
      const trimmed = String(body.importedEmail).trim().slice(0, 128);
      if (trimmed.length === 0) {
        next = null;
      } else if (!isEmailish(trimmed)) {
        return NextResponse.json(
          { ok: false, error: "Enter a valid e-mail address." },
          { status: 400 }
        );
      } else {
        next = trimmed.toLowerCase();
      }
    }
    const result = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      seafarer.importedEmail = next; // ONLY importedEmail — ownerEmail is never touched
      return seafarer;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, seafarer: result });
  }

  // Set voyage metadata (vessel and/or planned end-of-rotation date) without a
  // state move. rotationEnd feeds the sea-readiness check (a cert lapsing before
  // it blocks assignment) and the PSC/MLC dossier's per-vessel grouping.
  if (
    body.state === undefined &&
    !body.rotateToken &&
    (body.vessel !== undefined ||
      body.rotationEnd !== undefined ||
      body.vesselType !== undefined ||
      body.flagState !== undefined)
  ) {
    // #9 — AGENT-ONLY. Vessel / flag / rotation feed sea-readiness scoring + the PSC/MLC
    // dossier, so a seaman must NOT self-declare them (kept OUT of the token-serviceable
    // allow-list). This branch had NO auth (the confirmed anonymous IDOR write); gate it
    // behind the agent grant guard directly so it self-authorizes: an anonymous / token-only
    // caller has no agent session (401), and an ungranted agent 404s. This closes the IDOR
    // and blocks seaman self-declaration in one move.
    if (!patchSession?.user) {
      return NextResponse.json(
        { ok: false, error: "Sign in as an agent to update voyage details." },
        { status: 401 }
      );
    }
    if (!checkAccess(patchSession.agentId, sid).allowed) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    let rotationEnd: string | null | undefined;
    if (body.rotationEnd !== undefined) {
      const raw = (body.rotationEnd ?? "").trim();
      if (raw === "") {
        rotationEnd = null;
      } else {
        const d = new Date(raw);
        if (isNaN(d.getTime())) {
          return NextResponse.json({ ok: false, error: "Enter a valid rotation-end date." }, { status: 400 });
        }
        rotationEnd = d.toISOString();
      }
    }
    const vessel = body.vessel !== undefined ? (body.vessel ?? "").trim() || null : undefined;
    const vesselType = body.vesselType !== undefined ? (body.vesselType ?? "").trim() || null : undefined;
    const flagState = body.flagState !== undefined ? (body.flagState ?? "").trim() || null : undefined;
    const result = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      if (rotationEnd !== undefined) seafarer.rotationEnd = rotationEnd;
      if (vessel !== undefined) seafarer.vessel = vessel;
      if (vesselType !== undefined) seafarer.vesselType = vesselType;
      if (flagState !== undefined) seafarer.flagState = flagState;
      return seafarer;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, seafarer: result });
  }

  // Per-link RESET. Each share link rotates INDEPENDENTLY: resetting the open link
  // leaves the private link (and every document) untouched, and vice-versa. Owner-only
  // — authorised by the OWNER's possession of EITHER share token, or by a signed-in
  // agent holding a live grant. A token for another seafarer, or an un-granted agent,
  // resolves nothing => 404, so nobody can rotate another seafarer's links. (This also
  // closes the prior gap where rotateToken required no possession proof at all.)
  if (body.rotateToken || body.resetOpenToken || body.resetEmailToken) {
    const ownerByToken = ownerByShareToken();
    const ownerByAgent = !!patchSession?.user && checkAccess(patchSession.agentId, sid).allowed;
    if (!ownerByToken && !ownerByAgent) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    // `rotateToken` is the legacy alias for resetting the OPEN link.
    const resetOpen = body.resetOpenToken === true || body.rotateToken === true;
    const resetEmail = body.resetEmailToken === true;
    const result = await updateDB((db) => {
      const seafarer = db.seafarers.find((s) => s.id === sid);
      if (!seafarer) return null;
      if (resetOpen) {
        const open = shareToken();
        seafarer.openShareToken = open;
        seafarer.shareToken = open; // keep the alias in lock-step
        // #6(c) — rotating the OPEN link also revokes every carried OPEN alias of an
        // absorbed record, so the rotate-to-revoke guarantee holds across a merge.
        seafarer.priorShareTokens = (seafarer.priorShareTokens ?? []).filter(
          (p) => p.mode !== "open"
        );
      }
      if (resetEmail) {
        let email = shareToken();
        while (email === seafarer.openShareToken) email = shareToken();
        seafarer.emailShareToken = email;
        // #6(c) — rotating the PRIVATE link revokes every carried EMAIL alias too.
        seafarer.priorShareTokens = (seafarer.priorShareTokens ?? []).filter(
          (p) => p.mode !== "email"
        );
      }
      return seafarer;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, seafarer: result });
  }

  const state = body.state;
  if (!isSeafarerState(state)) {
    return NextResponse.json(
      { ok: false, error: "a valid state (or rotateToken) is required." },
      { status: 400 }
    );
  }

  // F7c: moving a pipeline stage requires an acting AGENT session (research #4: no
  // non-agent client uses this branch). This removes the silent agentId ?? "dev"
  // fallback and stamps the move to the real acting agency. The shared grant-scope
  // guard above (line ~243) already 404'd an agent with no live grant for `sid`, so a
  // present agent session here is guaranteed to hold this seaman's grant.
  if (!patchSession?.user) {
    return NextResponse.json(
      { ok: false, error: "Sign in as an agent to move a pipeline stage." },
      { status: 401 }
    );
  }
  const actingAgentId = patchSession.agentId;
  // #9 — self-authorize the state-move independent of the central guard: this branch
  // otherwise relies solely on the guard for grant-scoping (its only other check is the
  // 401 above, then it defaults the stage with NO rejection). An UNGRANTED agent must
  // never drive another tenant's seafarer through the pipeline.
  if (!checkAccess(actingAgentId, sid).allowed) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  // HARD BLOCK: advancing a seafarer FORWARD into an assignment state ("Accepted"
  // or "Sent to sea") is refused when he is not sea-ready — an expired or missing
  // required document, a possible-forgery duplicate certificate number, or a cert
  // that lapses before the rotation ends. The whole point is to stop a
  // non-compliant man being committed to a vessel, not merely warn. The only way
  // past is a DOCUMENTED override by a signed-in agent, recorded to the audit
  // trail (a seafarer-level note). Enforced here on the server so no client can
  // bypass it.
  {
    const db = readDB();
    const seafarer = db.seafarers.find((s) => s.id === sid);
    if (!seafarer) {
      return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
    }
    // Advance-gate "from" stage = the ACTING agent's per-grant stage (B.2 / F4), not
    // the deprecated global seafarer.state.
    const actingGrant = db.accessGrants.find(
      (g) => g.seafarerId === sid && g.agentId === actingAgentId
    );
    const fromStage = actingGrant?.stage ?? "review";
    if (isAssignmentAdvance(fromStage, state as SeafarerState)) {
      // Sea-readiness hard-block counts only ACTIVE docs — an archived (retired) doc
      // is not an on-file required/valid document for this gate.
      const docs = activeDocs(db.documents.filter((d) => d.seafarerId === sid));
      // Fleet-wide duplicate index so a forged/shared certificate number blocks too.
      const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
      const duplicates = duplicateNameIndex(db.documents, (i) => nameById.get(i) ?? i);
      // Config-driven required set for this seafarer's rank under the acting agent.
      // If a live assignment already froze a required-set SNAPSHOT, that snapshot
      // WINS (mid-contract rank/config changes must not silently re-scope the
      // committed voyage); otherwise compute live from the current rank + config.
      const agentId = actingAgentId;
      const liveAssignment = db.assignments.find(
        (a) => a.seafarerId === sid && a.agentId === agentId && a.returnedAt === null && a.requiredSnapshot
      );
      const req = liveAssignment?.requiredSnapshot
        ? {
            required: liveAssignment.requiredSnapshot.required,
            rankKnown: liveAssignment.requiredSnapshot.rankKnown,
          }
        : requiredSetFor({
            rank: seafarer.rank,
            config: getConfigForAgent(agentId),
            vesselType: seafarer.vesselType,
            flag: seafarer.flagState,
          });
      const block = assignmentBlockers(docs, {
        duplicates,
        ownName: seafarer.name,
        rotationEnd: seafarer.rotationEnd ?? null,
        required: req.required,
        rankIncomplete: !req.rankKnown,
        holderDOB: seafarer.birthDate ?? null,
      });
      if (block.blocked) {
        const session = patchSession;
        const overriding = body.override === true && (body.overrideReason ?? "").trim().length > 0;
        if (!overriding) {
          return NextResponse.json(
            {
              ok: false,
              error:
                `Blocked: ${seafarer.name} is not sea-ready and cannot be advanced to "${STATE_LABELS[state as SeafarerState]}". ` +
                block.reasons.join("; ") + ".",
              blocked: true,
              blockers: block,
            },
            { status: 409 }
          );
        }
        if (!session?.user) {
          return NextResponse.json(
            { ok: false, error: "Sign in as an agent to override a sea-readiness block." },
            { status: 401 }
          );
        }
        // Record the override on the audit trail before the move lands.
        const reason = (body.overrideReason ?? "").trim();
        const actor = session.user.name ?? session.user.email ?? "Agent";
        const label = STATE_LABELS[state as SeafarerState];
        await updateDB((d) => {
          d.comments.push({
            id: id(),
            documentId: null,
            seafarerId: sid,
            authorName: actor,
            text:
              `⚠ Sea-readiness block OVERRIDDEN — advanced to "${label}". Reason: ${reason}. ` +
              `Outstanding at override: ${block.reasons.join("; ")}.`,
            createdAt: new Date().toISOString(),
          });
        });
      }
    }
  }

  const result = await updateDB((db) => {
    const seafarer = db.seafarers.find((s) => s.id === sid);
    if (!seafarer) return null;
    // B.2: stamp the ACTING agent's grant (source of truth) + timestamp, then
    // dual-write the deprecated global mirror (A.3). Race-safe: runs inside the
    // re-reading updateDB mutex (research #1).
    const grant = db.accessGrants.find(
      (g) => g.seafarerId === sid && g.agentId === actingAgentId
    );
    if (grant) {
      grant.stage = state as SeafarerState;
      grant.stageUpdatedAt = Date.now();
    }
    seafarer.state = state as SeafarerState; // dual-write (deprecated global mirror)
    // Return the seaman with `state` reflecting the per-agent stage so the acting
    // agent's optimistic board update stays consistent.
    return { ...seafarer, state: grant?.stage ?? (state as SeafarerState) };
  });

  if (!result) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  // ---- Assignment lifecycle hooks (DEF-1) --------------------------------
  // Run AFTER the state write has committed (grant.stage is now = state). Each
  // primitive below is a SEPARATE transact() call that re-validates the grant in
  // its own critical section, so the state write and the assignment mutation are
  // independent, TOCTOU-safe operations.
  if (state === SEA_STATE) {
    // R2 — ENTER sent_to_sea: engage the sea-lock UNCONDITIONALLY (fires on the
    // overridden path too; lock-on-override = YES). Idempotent via R3, so a
    // re-entry or double-submit collapses to a single live assignment.
    const start = await startAssignment({
      seafarerId: sid,
      agentId: actingAgentId,
      vessel: result.vessel ?? null,
    });
    if (!start.ok) {
      // Do NOT silently claim success — surface the failure so a missing grant /
      // unreadable status is visible. R3 self-heals on the next attempt.
      console.error(
        `[seafarers PATCH] startAssignment failed for seafarer=${sid} agent=${actingAgentId}: ${start.reason ?? "unknown"}`
      );
    }
  } else {
    // R1 — LEAVE sent_to_sea: close every live assignment this agent holds. Do
    // NOT rely on the prior grant.stage (it was just clobbered to `state`); read
    // the live assignments directly. closeAssignment is idempotent + only flips
    // the grant back to CONSENT / emits UNLOCKED when no live assignment remains.
    const db = readDB();
    const liveNow = activeAssignmentsFor(sid, actingAgentId, db.assignments);
    for (const a of liveNow) {
      await closeAssignment(a.id, actingAgentId);
    }
  }

  return NextResponse.json({ ok: true, seafarer: result });
}

// Where hard-deleted upload files are MOVED (never unlinked) — recoverable alongside
// the archive line's `files:[...]` list.
const DELETED_FILES_DIR = path.join(process.cwd(), "data", "deleted-files");

// DELETE /api/seafarers?id=... — hidden-crew delete (agent-only, grant-scoped).
// The id comes from the QUERY ONLY (never a body read). Decision table + cascade live
// in lib/access.ts `deleteFromBoard` (one transact, guards re-checked on the fresh db):
// claimed / multi-agent => view-only removal (the caller's grant is revoked); unclaimed
// sole-grant => hard delete (archived first). Order: session -> id -> rate limit ->
// deleteFromBoard.
export async function DELETE(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json(
      { ok: false, error: "Sign in as an agent to delete crew." },
      { status: 401 }
    );
  }
  const sid = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!sid) {
    return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  }
  if (deleteRateLimited(session.agentId)) {
    return NextResponse.json(
      { ok: false, error: "Too many deletes — wait a minute and try again." },
      { status: 429 }
    );
  }
  const result = await deleteFromBoard(sid, session.agentId, impersonationStampFor(session));
  if (result === "not-found") {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  if (result === "not-hidden") {
    return NextResponse.json(
      { ok: false, error: "Only a board-hidden seaman can be deleted.", notHidden: true },
      { status: 409 }
    );
  }
  if (result === "at-sea") {
    return NextResponse.json(
      {
        ok: false,
        error: "Can't delete a seaman who is at sea — they must stay in oversight until they return.",
        atSea: true,
      },
      { status: 409 }
    );
  }
  // Post-commit: MOVE the uploaded files into data/deleted-files/<sid>/ (recoverable,
  // basename-guarded). Best-effort — the db commit already happened, so a failed move
  // is logged with path + sid and the delete still reports 200; the archive line's
  // files list makes a manual sweep possible.
  if (result.mode === "hard" && result.files.length > 0) {
    const destDir = path.join(DELETED_FILES_DIR, path.basename(sid));
    for (const f of result.files) {
      try {
        const src = path.join(UPLOAD_DIR, path.basename(f));
        if (!src.startsWith(UPLOAD_DIR) || !fs.existsSync(src)) continue;
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(src, path.join(destDir, path.basename(f)));
      } catch (err) {
        console.error(`[seafarers DELETE] file move failed path=${f} sid=${sid}:`, err);
      }
    }
  }
  return NextResponse.json({ ok: true, mode: result.mode });
}
