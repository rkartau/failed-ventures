// Find-or-create a seafarer profile for a SEAMAN who signed in with Google.
//
// This is the seaman-side counterpart to the agent tenant key: a signed-in seaman
// OWNS exactly one seafarer record, resolved from their Google identity so the same
// person lands on the SAME profile from any device. Matching order:
//   1. Google `sub` (stable, primary) — a returning owner.
//   2. Owner e-mail (secondary) — the same person before their `sub` was on file;
//      the `sub` is then linked so future logins hit case 1.
//   3. ADOPT an anonymous local profile (by its share token) if one was started on
//      this device before signing in — links it instead of orphaning the docs.
//   4. Otherwise create a fresh owned profile.
//
// The whole decision runs inside ONE db.ts critical section (updateDB) so two
// near-simultaneous first logins cannot create two profiles for one identity.

import { updateDB, id, newShareTokens, type Seafarer } from "@/lib/db";

export type GoogleIdentity = {
  /** Auth.js `sub` (provider account id). */
  sub: string;
  email?: string | null;
  name?: string | null;
};

export function findOrCreateSeafarerByGoogle(
  identity: GoogleIdentity,
  adoptToken?: string | null
): Promise<string> {
  const sub = (identity.sub ?? "").trim();
  const email = (identity.email ?? "").trim().toLowerCase();
  const name = (identity.name ?? "").trim();
  const token = (adoptToken ?? "").trim();

  return updateDB((db) => {
    // 1. Returning owner by Google sub.
    let owned = sub ? db.seafarers.find((s) => s.googleSub === sub) : undefined;
    if (owned) return owned.id;

    // 2. Returning owner by e-mail — link the sub the first time.
    owned = email
      ? db.seafarers.find((s) => (s.ownerEmail ?? "").toLowerCase() === email)
      : undefined;
    if (owned) {
      if (sub && owned.googleSub !== sub) owned.googleSub = sub;
      return owned.id;
    }

    // 3. Adopt an ANONYMOUS local profile started on this device (share-token
    //    match, and only if still unowned) so the seaman keeps the documents they
    //    uploaded before signing in. "Unowned" includes NOT credential-owned
    //    (feat/password-signup, invariant 7): a Google login must never adopt a
    //    password-account-owned profile.
    if (token) {
      // Public Sample Profiles: a sample row is NEVER adoptable — its open token is
      // published on indexable pages, so without this any Google seaman could claim
      // the public flagship.
      const anon = db.seafarers.find(
        (s) =>
          s.shareToken === token &&
          !s.googleSub &&
          !s.ownerEmail &&
          !s.credentialUserId &&
          !s.isSample
      );
      if (anon) {
        anon.googleSub = sub || null;
        anon.ownerEmail = email || null;
        if (!anon.name && name) anon.name = name;
        return anon.id;
      }
    }

    // 4. Brand-new owned profile.
    const created: Seafarer = {
      id: id(),
      name: name || "My profile",
      rank: "",
      state: "review",
      ...newShareTokens(),
      createdAt: new Date().toISOString(),
      googleSub: sub || null,
      ownerEmail: email || null,
    };
    db.seafarers.push(created);
    return created.id;
  });
}
