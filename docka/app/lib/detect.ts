// Server-side: try to recover an Estonian verification code from an uploaded
// file when the seafarer pasted no code — the "just upload a document" path.
//
// Real registry downloads carry the code in a machine-readable way: the
// verification PDF prints the meremees.transpordiamet.ee/<kind>/<CODE> URL as
// text (and encodes it in a QR), and the files are commonly saved named after
// the token itself (e.g. SAMPLE0SAFETY001.pdf). We scan the filename and the
// file's embedded text for either, then hand the code to the same live-verify
// path as a pasted code. A genuinely opaque photo (no embedded URL, random
// name) yields null — nothing to verify without OCR — and stays a plain file.

import { extractCode } from "@/lib/cert";

// Any http(s) URL that mentions the registry host. We then reuse extractCode to
// pull the last path segment (the access token) out of it.
const REGISTRY_URL_RE = /https?:\/\/[^\s"'<>)\]}]*transpordiamet\.ee[^\s"'<>)\]}]*/gi;

export function detectCodeFromFile(buf: Buffer, fileName: string): string | null {
  // latin1 keeps every byte 1:1, so ASCII URLs embedded in an otherwise binary
  // PDF/image are still found without throwing on invalid UTF-8.
  const text = buf.toString("latin1");
  const haystack = `${fileName}\n${text}`;

  const urls = haystack.match(REGISTRY_URL_RE);
  if (urls) {
    for (const u of urls) {
      const code = extractCode(u);
      if (code) return code;
    }
  }

  // Filename is literally the token (a very common way these are saved). Require
  // a token-shaped base (12–40 alphanumerics with at least one digit, as real
  // access tokens have) so ordinary names like "certificate.pdf" don't misfire.
  const base = fileName.replace(/\.[a-z0-9]{1,8}$/i, "").trim();
  if (/^[A-Za-z0-9]{12,40}$/.test(base) && /\d/.test(base)) {
    return base.toUpperCase();
  }

  return null;
}
