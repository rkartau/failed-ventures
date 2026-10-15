// feat/password-signup (v6 fold 7) — the "signup may have committed" marker.
//
// When a signup POST fails at the NETWORK level, the server may still have
// committed the account while the response carrying the only plaintext recovery
// codes was lost. The client persists this marker in localStorage (a webview
// kill between attempts must still trigger the codes-lost path) so a retry of
// the SAME values that answers pw.errTaken can auto-sign-in and show the
// defined codes-lost warning (Step 7).
//
// SCHEMA IS A SECURITY RULE: the marker holds ONLY { usernameLower, side, ts }
// — NEVER the password or e-mail (localStorage is world-readable to anything in
// the webview's origin and survives indefinitely). "Same values" is detected by
// comparing the retyped username, not by replaying stored secrets. This module
// is PURE (no server imports) so the client bundle can use it and a unit test
// can pin the output shape.

export type SignupCommitMarker = {
  /** NFC + lower-cased username — the comparison key. */
  usernameLower: string;
  side: "seaman" | "agent";
  /** Epoch ms of the failed attempt. */
  ts: number;
};

/**
 * Build the marker from the submitted form values. Accepts (and deliberately
 * DROPS) whatever else the form holds — the output never contains password or
 * e-mail material, pinned by the Step 10 schema unit test.
 */
export function buildSignupCommitMarker(values: {
  username: string;
  side: "seaman" | "agent";
  ts?: number;
}): SignupCommitMarker {
  return {
    usernameLower: values.username.normalize("NFC").trim().toLowerCase(),
    side: values.side,
    ts: values.ts ?? Date.now(),
  };
}

/** Does a stored marker match the values the user just retyped? */
export function markerMatches(
  marker: SignupCommitMarker | null | undefined,
  values: { username: string; side: "seaman" | "agent" }
): boolean {
  if (!marker) return false;
  return (
    marker.usernameLower === values.username.normalize("NFC").trim().toLowerCase() &&
    marker.side === values.side
  );
}

/** Parse a stored marker string; null on anything malformed (fail closed). */
export function parseSignupCommitMarker(raw: string | null | undefined): SignupCommitMarker | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<SignupCommitMarker>;
    if (
      typeof p.usernameLower === "string" &&
      (p.side === "seaman" || p.side === "agent") &&
      typeof p.ts === "number"
    ) {
      return { usernameLower: p.usernameLower, side: p.side, ts: p.ts };
    }
    return null;
  } catch {
    return null;
  }
}
