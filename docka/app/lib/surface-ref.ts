// Non-reversible, per-surface reference for a seafarer id (#42/#49 [R42.7/C6/V3]).
//
// A client surface (portal / directory) must NEVER carry a raw `seafarerId` — it
// would let a viewer correlate the same person across surfaces, or probe the tenant
// keyspace. Instead each row carries `ref = HMAC(seafarerId, per-surface-salt)`,
// truncated. Because the salt is a SERVER-ONLY env secret with NO committed default,
// a predictable/shared default can never make the "non-correlatable" claim false.
//
// FAIL-CLOSED is LAZY, per call [V3]: `surfaceRef` throws ONLY when invoked with an
// unset salt. It is NEVER a module-load throw — a module-eval throw would take down
// the whole single-box process that also serves registry verification + the seafarer
// platform. The portal/directory ROUTES catch `SurfaceRefSaltMissing` and return 503;
// the rest of the app stays up.

import crypto from "crypto";

export type RefSurface = "portal" | "directory";

const ENV_KEY: Record<RefSurface, string> = {
  portal: "PORTAL_REF_SALT",
  directory: "DIRECTORY_REF_SALT",
};

/** Thrown lazily by `surfaceRef` when the surface's salt env var is unset. */
export class SurfaceRefSaltMissing extends Error {
  readonly surface: RefSurface;
  readonly envKey: string;
  constructor(surface: RefSurface) {
    super(
      `${ENV_KEY[surface]} is not set — refusing to emit a ${surface} ref (fail-closed).`
    );
    this.name = "SurfaceRefSaltMissing";
    this.surface = surface;
    this.envKey = ENV_KEY[surface];
  }
}

function saltFor(surface: RefSurface): string {
  const salt = process.env[ENV_KEY[surface]];
  if (!salt || !salt.trim()) throw new SurfaceRefSaltMissing(surface);
  return salt;
}

/**
 * Deterministic per-(seafarer, surface) non-reversible ref. Stable across requests
 * for the same seaman+surface [C9], DIFFERENT across surfaces (portal vs directory
 * salts differ), and non-reversible (HMAC-SHA256, 16 base64url chars). Throws
 * `SurfaceRefSaltMissing` when the surface salt is unset — caught by the route as 503.
 */
export function surfaceRef(seafarerId: string, surface: RefSurface): string {
  return crypto
    .createHmac("sha256", saltFor(surface))
    .update(seafarerId)
    .digest("base64url")
    .slice(0, 16);
}
