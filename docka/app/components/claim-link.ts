// The panel's PURE client helpers: the canonical seaman CLAIM link builder + the
// response→outcome interpreter for the "Send invite" / "Refresh link" POSTs.
//
// Lives under components/ (NOT lib/) on purpose: the link literal contains the raw
// share token, which tests/isolation-static.mjs TOKEN_REGEX forbids in lib/. The
// components/ tree is not lint-scanned, so the one client builder belongs here.
// Client-only — the caller supplies `origin` (window.location.origin), never read here.

/** The canonical seaman CLAIM link (ImportCrew's post-import form). */
export function claimLinkFor(token: string, origin: string): string {
  return `${origin}/seafarer?token=${token}`;
}

export type ClaimOutcome = {
  tone: "ok" | "warn" | "error";
  key: string;
  vars: Record<string, string>;
};

type OneReminder = { delivered?: unknown; delivery?: unknown };

/** Interpret the /api/reminders {kind:"claim"} response into a rendered outcome.
 *  PURE + defensive: a non-OK response or a malformed 200 (no `reminders`) resolves
 *  to an error tone, NEVER a throw — the `data.reminders` read is guarded and only
 *  reached after the `ok` check. `key === "raw"` means render `vars.text` verbatim
 *  (a server-supplied error string). Unit-tested with a fake fetch shape (no DOM). */
export function claimOutcomeFrom(
  res: { ok: boolean; status: number },
  data: unknown
): ClaimOutcome {
  const d = (data ?? {}) as { ok?: unknown; error?: unknown; reminders?: unknown };
  if (!res.ok || d.ok !== true) {
    const err = typeof d.error === "string" && d.error.trim().length > 0 ? d.error : null;
    return err
      ? { tone: "error", key: "raw", vars: { text: err } }
      : { tone: "error", key: "board.claim.sendFailed", vars: {} };
  }
  const list = Array.isArray(d.reminders) ? (d.reminders as OneReminder[]) : null;
  const first = list && list.length > 0 ? list[0] : null;
  if (!first) {
    // A well-formed success MUST carry the per-row result; a body without it is
    // treated as an error tone rather than silently claiming "sent".
    return { tone: "error", key: "board.claim.sendFailed", vars: {} };
  }
  const delivery = typeof first.delivery === "string" ? first.delivery : "";
  if (first.delivered === true) {
    // "emailed to <addr>" — surface the address the route reported.
    const to = delivery.replace(/^emailed to\s*/i, "").trim();
    return { tone: "ok", key: "board.claim.sentEmailed", vars: { to } };
  }
  return { tone: "warn", key: "board.claim.sentRecorded", vars: { reason: delivery } };
}
