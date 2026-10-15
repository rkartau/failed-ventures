// Server-safe link to a registry's pinned OFFICIAL portal (SEO plan v3 S1). No
// "use client": the marketing/content pages (server components) compose this for
// the /registries table, the how-it-works list, the /verify "Which official portal?"
// table and the per-country registry pages, so every outbound authority link is
// derived from `countries.ts` `portalUrl` (never a hand-typed URL).
//
// `RegistryInfo` (client, agent surfaces) keeps its own inline link untouched; this
// component is the standalone primitive for public pages and accepts any object that
// carries a `portalUrl` (a `CountryEntry` or a `RegistryPublicRow`).

import type { CountryEntry } from "@/lib/registry/types";

export type RegistryPortalLinkProps = Pick<CountryEntry, "portalUrl"> & {
  /** Visible label. Defaults to `official portal (<hostname>)`. */
  label?: string;
  className?: string;
  /** Optional click hook — only a CLIENT caller can pass one (the /verify page uses it
      for the PII-free GA4 cta_click); server pages leave it undefined. */
  onClick?: () => void;
};

/** Hostname for the default label; falls back to the raw URL if it does not parse. */
export function portalHostname(portalUrl: string): string {
  try {
    return new URL(portalUrl).hostname;
  } catch {
    return portalUrl;
  }
}

export function RegistryPortalLink({ portalUrl, label, className, onClick }: RegistryPortalLinkProps) {
  return (
    <a href={portalUrl} rel="noopener noreferrer" target="_blank" className={className} onClick={onClick}>
      {label ?? `official portal (${portalHostname(portalUrl)})`}
    </a>
  );
}

export default RegistryPortalLink;
