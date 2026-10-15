// Auth.js v5 type augmentation. We carry a ROLE on the session/JWT so the same
// Google login can be either an AGENT session or a SEAMAN session depending on the
// context it was started from (never on the Google account itself), plus, for a
// seaman, the id of the ONE seafarer profile they own. See auth.ts callbacks.
//
// feat/password-signup (Step 4): credential (password) sessions additionally
// carry agentId (agent side), authMethod: "password", the pwdAt
// session-invalidation claim (invariant 11), and credentialSub (the owning
// CredentialUser.id — the seaman gate's identity anchor, v6 fold 1). A
// credential session NEVER carries an e-mail (D3).
import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** "agent" (crewing dashboard) or "seaman" (owns one seafarer profile). */
    role?: "agent" | "seaman";
    /** For a seaman session ONLY: the seafarer id this Google identity owns. */
    seafarerId?: string;
    /** For a credential AGENT session ONLY: the agent:p-* tenant id (D4). */
    agentId?: string;
    /** Set to "password" on credential sessions; absent on Google sessions. */
    authMethod?: "password";
    /** Credential sessions: passwordChangedAt ?? createdAt at issue time (inv. 11). */
    pwdAt?: string;
    /** Credential sessions: the owning CredentialUser.id (= token.sub) — identity anchor. */
    credentialSub?: string;
  }

  /** authorize()'s CredentialPrincipal rides into the jwt callback as `user`. */
  interface User {
    role?: "agent" | "seaman";
    seafarerId?: string;
    agentId?: string;
    pwdAt?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: "agent" | "seaman";
    seafarerId?: string;
    agentId?: string;
    authMethod?: "password";
    pwdAt?: string;
  }
}
