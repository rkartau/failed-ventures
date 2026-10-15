"use client";

// The ONE tracked CTA link (GA4 funnel, 2026-09-07). Wraps next/link and fires the
// PII-free `cta_click` event on click — server pages (/pricing, /contact) and client
// pages (/, /verify) compose this instead of writing inline onClick variants.
// `location` is the stable placement id (e.g. "home_hero"); `cta` is the event's
// `target` param and defaults to the href's bare pathname. Both are constants
// chosen by the page author, never derived from user input. track() itself keeps
// the consent + public-path gates and the value charset (lib/analytics-events.ts),
// so a non-conforming value is simply dropped, never sent.

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { track } from "@/lib/analytics-events";

type LinkProps = ComponentProps<typeof Link>;

export type TrackedLinkProps = LinkProps & {
  /** Placement id — the cta_click `location` param (e.g. "pricing_plan"). */
  location: string;
  /** The cta_click `target` param; defaults to the href's bare pathname. */
  cta?: string;
};

function defaultTarget(href: LinkProps["href"]): string {
  if (typeof href !== "string") return "";
  return href.split("?")[0].split("#")[0];
}

export function TrackedLink({ location, cta, href, onClick, children, ...rest }: TrackedLinkProps) {
  const target = cta ?? defaultTarget(href);
  return (
    <Link
      href={href}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        track("cta_click", { location, target });
        onClick?.(e);
      }}
    >
      {children}
    </Link>
  );
}

export default TrackedLink;
