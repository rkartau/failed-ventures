// lib/email-match.ts — the SHARED email-match normalization + email HMAC for
// the outreach signup loop (go-live readiness plan 2026-08-25, item 3 + D5).
//
// normalizeEmailForMatch is the byte-exact TS mirror of the pipeline's
// `common.normalize_email` (the §I5 [R2-7] rule): trim -> Unicode NFC ->
// lowercase -> IDN domain punycode-normalized to ASCII. The FULL local part is
// kept (NO plus-address stripping); input with no usable local@domain split
// falls back to the trimmed/NFC/lowercased whole string. The contract is
// pinned by the shared golden vectors tests/fixtures/email-normalize-golden.json
// (asserted in BOTH repos) — the D5 HMAC boundary only works when the two
// implementations agree byte-for-byte.
//
// Engine caveat: Node's url.domainToASCII implements UTS46 while Python's
// `str.encode("idna")` codec is IDNA2003; divergent corners (eszett domains
// etc.) are deliberately excluded from the golden corpus. Extend the fixture
// only with vectors verified equal on both engines.
//
// hmacEmailHex feeds the D5 import-time recheck: the app exposes ONLY
// HMAC-SHA256(TRACKING_HMAC_SECRET, normalized_email) hex digests — neither
// the raw user-email list nor the raw lead list ever crosses the
// app/pipeline boundary.
//
// Pure decision logic (node:crypto + node:url) — server-side routes only.

import crypto from "crypto";
import { domainToASCII } from "url";

/** The §I5 [R2-7] email-match normalization (mirror of common.normalize_email). */
export function normalizeEmailForMatch(email: string | null | undefined): string {
  const e = (email ?? "").trim().normalize("NFC").toLowerCase();
  // Mirror Python rpartition("@"): the LAST "@" splits; an empty local part or
  // empty domain (or no "@" at all) falls back to the whole lowered string.
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return e;
  const local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const ascii = domainToASCII(domain);
  // Invalid IDN -> keep the NFC-lowered domain as-is (the Python UnicodeError
  // fallback); domainToASCII signals invalid input with "".
  if (ascii) domain = ascii.toLowerCase();
  return `${local}@${domain}`;
}

/** Lowercase-hex HMAC-SHA256 of an (already normalized) email — the D5 wire unit. */
export function hmacEmailHex(normalizedEmail: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(normalizedEmail, "utf8").digest("hex");
}
