// Server-side ADMIN authentication — the authoritative owner gate.
//
// An admin is a Google (Auth.js) session whose verified e-mail is on a tiny
// allowlist read from the ADMIN_EMAILS env var (comma-separated). Unset or
// empty means NO admins. This is deliberately NARROWER than the agent/seaman gates:
// there is NO dev-cookie / test-login backdoor here. Only a real Google login,
// which is the only path that populates a verified `session.user.email`, can pass.
// A phone-OTP session carries no e-mail and therefore correctly returns null.
//
// Fail closed: anything short of a signed-in, allowlisted, verified e-mail → null.

import { auth } from "@/auth";

export const ADMIN_EMAILS: Set<string> = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

export type AdminSession = {
  user: { name?: string | null; email?: string | null };
};

export async function adminSession(): Promise<AdminSession | null> {
  const s = await auth();
  const email = (s?.user?.email ?? "").trim().toLowerCase();
  if (s?.user && email && ADMIN_EMAILS.has(email)) {
    return { user: s.user };
  }
  return null;
}
