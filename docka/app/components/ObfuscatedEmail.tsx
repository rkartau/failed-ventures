"use client";

import { useEffect, useState } from "react";

// Anti-harvest email link. The address is stored ONLY as char-code arrays (never as a
// plaintext user@domain literal, and never with the "mail"+"to" scheme spelled out),
// and both the visible text and the href are assembled in the browser after mount.
// Because it is built in useEffect/useState, nothing usable is present in the
// server-rendered HTML or view-source — a scraper of the SSR output sees only the
// <noscript> fallback, which is deliberately non-harvestable (no "@", no scheme,
// not a link).
//
// user + domain are split into char codes so no substring of the source (or the SSR
// payload) spells out the harvestable address.
const USER = [105, 110, 102, 111]; // i n f o
const DOMAIN = [100, 111, 99, 107, 97, 46, 109, 101]; // d o c k a . m e

function fromCodes(codes: number[]): string {
  return String.fromCharCode(...codes);
}

export function ObfuscatedEmail({ className }: { className?: string }) {
  const [addr, setAddr] = useState<string | null>(null);

  useEffect(() => {
    // Assemble at runtime, in the browser only.
    setAddr(`${fromCodes(USER)}@${fromCodes(DOMAIN)}`);
  }, []);

  // Before hydration completes (and for no-JS clients), render a bot-unfriendly,
  // human-readable fallback inside <noscript>. This is also what the SSR HTML
  // contains, so the plaintext address is never in view-source.
  if (!addr) {
    return (
      <noscript>
        {fromCodes(USER)} [at] {fromCodes(DOMAIN).replace(".", " [dot] ")}
      </noscript>
    );
  }

  return (
    <a href={`${"mail" + "to"}:${addr}`} className={className} aria-label="Email the Docka team">
      {addr}
    </a>
  );
}
