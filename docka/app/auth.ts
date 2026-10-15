import NextAuth from "next-auth";
import type { Account, Profile, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { cookies } from "next/headers";
import { findOrCreateSeafarerByGoogle } from "@/lib/seaman-account";
import { authorizeCredentials } from "@/lib/credential-auth";
import { ADMIN_EMAILS } from "@/lib/admin-session";

// Read Google OAuth credentials from the environment. NEVER hardcode these.
//   AUTH_GOOGLE_ID     — OAuth client ID
//   AUTH_GOOGLE_SECRET — OAuth client secret
//   AUTH_SECRET        — used to encrypt the JWT session cookie
const googleId = process.env.AUTH_GOOGLE_ID;
const googleSecret = process.env.AUTH_GOOGLE_SECRET;

// The login is only available once the owner has added real Google credentials.
// Until then the app still builds and runs — the sign-in screens show a friendly
// "not configured yet" note instead of a broken button.
export const isGoogleConfigured = Boolean(googleId && googleSecret);

// Short-lived intent cookies set just BEFORE the OAuth redirect. They tell the
// jwt callback which CONTEXT the sign-in was started from (agent dashboard vs
// seaman portal) and, for a seaman, which anonymous local profile to adopt. The
// role is NEVER derived from the Google account — the same account can be an agent
// in one place and a seaman in another.
export const OAUTH_ROLE_COOKIE = "docka_oauth_role";
export const OAUTH_ADOPT_COOKIE = "docka_adopt_token";

/**
 * The jwt callback (feat/password-signup Step 4). Exported so the invariants
 * test can drive the REAL claim path (authorizeCredentials → this function) —
 * the NextAuth config below wires exactly this function, never a copy.
 *
 * PREREQUISITE (r2 revision 5): `user` MUST be in the destructured parameters —
 * it carries authorize()'s return value (the CredentialPrincipal) on the
 * credentials sign-in; without it every credential claim below is silently
 * `undefined` (and the Step 5 gates then fail closed on the missing pwdAt).
 */
export async function jwtCallback({
  token,
  account,
  profile,
  user,
}: {
  token: JWT;
  account?: Account | null;
  profile?: Profile;
  user?: User;
}): Promise<JWT> {
  // `account` is present ONLY on the initial sign-in — the one moment we can
  // read the intent cookie and (for a seaman) bind the owned seafarer.
  if (account) {
    if (account.provider === "credentials") {
      // CREDENTIALS-FIRST BRANCH (Step 4) — returns BEFORE the Google/admin
      // logic below, which stays byte-identical for OAuth sign-ins.
      // Role + side binding come from authorize()'s CredentialPrincipal (`user`);
      // `side` decided the active scope at sign-in (D2) — a seaman token never
      // carries agentId and vice versa (invariant 9).
      token.role = user?.role;
      if (user?.role === "seaman") {
        token.seafarerId = user.seafarerId;
        delete token.agentId;
      } else {
        token.agentId = user?.agentId;
        delete token.seafarerId;
      }
      // Session-invalidation claim (invariant 11): the account's
      // passwordChangedAt ?? createdAt at issue time. The Step 5 gates compare
      // it against the stored value and fail CLOSED when it is missing.
      token.pwdAt = user?.pwdAt;
      token.authMethod = "password";
      // D3 — a credential session NEVER carries an e-mail. Belt-and-braces:
      // authorize never returns one, but strip whatever landed on the default
      // token so the admin allowlist, agentSession e-mail resolution, and the
      // private-link allowedEmails gate all fail closed by construction.
      delete token.email;
      return token;
    }
    // HARDENING (F8): never mint an admin-capable token from an UNVERIFIED Google
    // e-mail. This only affects the admin allow-list path — a normal agent/seaman
    // Google login (email not on ADMIN_EMAILS) is unaffected. Google always sets
    // email_verified for real accounts; refusing here means a spoofed/unverified
    // profile e-mail matching an admin address can never reach adminSession().
    const adminEmailLc = (
      (profile?.email as string | undefined) ??
      token.email ??
      ""
    )
      .toString()
      .trim()
      .toLowerCase();
    if (
      ADMIN_EMAILS.has(adminEmailLc) &&
      (profile as { email_verified?: boolean } | undefined)?.email_verified !== true
    ) {
      throw new Error("Admin sign-in requires a verified Google e-mail.");
    }
    const jar = cookies();
    const roleIntent = jar.get(OAUTH_ROLE_COOKIE)?.value;
    if (roleIntent === "seaman") {
      token.role = "seaman";
      const sub = account.providerAccountId || token.sub || "";
      const email =
        (profile?.email as string | undefined) ?? token.email ?? null;
      const name = (profile?.name as string | undefined) ?? token.name ?? null;
      const adopt = jar.get(OAUTH_ADOPT_COOKIE)?.value ?? null;
      token.seafarerId = await findOrCreateSeafarerByGoogle(
        { sub, email, name },
        adopt
      );
    } else {
      // Default = agent (backward compatible with existing agent Google logins,
      // which carry no intent cookie). Never leave a stale seafarerId behind.
      token.role = "agent";
      delete token.seafarerId;
    }
  }
  return token;
}

/**
 * The session callback (Step 4) — exported for the same real-claim-path test
 * reason as jwtCallback. Surfaces the credential claims the Step 5 gates read:
 * agentId (agent side), authMethod, pwdAt, and credentialSub (the account id —
 * authorize()'s returned id lands in token.sub, the next-auth default; the
 * seaman gate's identity anchor compares it to the profile's owner, v6 fold 1).
 */
export async function sessionCallback({
  session,
  token,
}: {
  session: Session;
  token: JWT;
}): Promise<Session> {
  // Surface the role + (seaman only) the owned seafarer id so the server can
  // enforce role separation and own-profile scoping. An agent session carries
  // NO seafarerId, a seaman session gains NO agent scope (see lib/agent-session
  // and lib/seaman-session).
  session.role = token.role;
  session.seafarerId = token.role === "seaman" ? token.seafarerId : undefined;
  session.agentId = token.role === "agent" ? token.agentId : undefined;
  session.authMethod = token.authMethod;
  session.pwdAt = token.authMethod === "password" ? token.pwdAt : undefined;
  session.credentialSub = token.authMethod === "password" ? token.sub : undefined;
  return session;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // No database: sessions live entirely in an encrypted, signed cookie (JWT).
  session: { strategy: "jwt" },
  // Trust the deployment host header (localhost in dev, docka.me in prod) so we
  // don't need to hardcode AUTH_URL for each environment.
  trustHost: true,
  providers: [
    // Google — AGENTS (and any seaman who does have a Google account). Only offered
    // once real OAuth credentials are present.
    ...(isGoogleConfigured
      ? [
          Google({
            clientId: googleId,
            clientSecret: googleSecret,
          }),
        ]
      : []),
    // Username + password — BOTH roles (feat/password-signup, D1/D9). Always
    // present: needs only the existing AUTH_SECRET, no env flag. The active
    // side rides in the credential values (`side`), the claim token in
    // `adoptToken` — next-auth's signIn() serializes all values to strings,
    // which authorizeCredentials coerces defensively (Step 2).
    Credentials({
      credentials: {
        identifier: {},
        password: {},
        side: {},
        adoptToken: {},
      },
      authorize: (c, req) => authorizeCredentials(c, req),
    }),
  ],
  callbacks: {
    jwt: (params) => jwtCallback(params),
    session: ({ session, token }) => sessionCallback({ session, token }),
  },
});
