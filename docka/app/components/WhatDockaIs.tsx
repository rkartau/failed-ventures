// app/components/WhatDockaIs.tsx
import Link from "next/link";

// Shared positioning strip: the one place the CRM identity is written, rendered on
// every long-tail marketing page. Server-safe (no "use client", no hooks) so the
// route-harness expand() walkers in tests/ can render it.
export function WhatDockaIs({
  className = "",
  heading = "p",
}: {
  className?: string;
  heading?: "h2" | "p";
}) {
  const Heading = heading;
  return (
    <aside
      data-testid="what-docka-is"
      className={`mt-10 rounded-2xl border border-slate-200 bg-white p-5 ${className}`}
    >
      <Heading className="text-base font-bold text-slate-900">What Docka is</Heading>
      {/* [src:crm-features] the shipped agency CRM surface, read from code; see
          docs/seo-new-pages-claims-sources.md. Digit-free and number-word-free by
          design, so the fabrication scan has nothing to cite. */}
      <p className="mt-2 text-sm leading-relaxed text-slate-700">
        Docka is a CRM for crewing agencies. The roster holds the crew, their documents and
        their expiry dates, and Docka checks a certificate against the register of the flag
        state that issued it.
      </p>
      <p className="mt-3 text-sm">
        <Link
          href="/overview/agencies"
          className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
        >
          See how a crewing agency uses Docka
        </Link>
      </p>
    </aside>
  );
}
