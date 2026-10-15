// app/admin/nav.ts — the admin nav as DATA (pure, zero imports).
//
// RV7: the owner's core change (Sales vs Admin grouping) is regression-tested by importing this structure directly (see
// tests/admin-nav.test.mjs). It lives in its own module — not inline in
// layout.tsx — so the test is a clean pure-data import and never drags the
// layout's server-only auth chain (@/auth via admin-session) into a bare-node
// test. layout.tsx renders straight from these arrays; the ONE source of truth
// for what appears in the admin nav. Not a routable module (no page/layout/route
// filename), so it is outside the inverted admin static guard — same as ui.tsx.

/** One nav link. */
export type NavItem = { label: string; href: string };
/** A labeled, always-visible cluster of links. */
export type NavGroup = { group: string; items: NavItem[] };

/**
 * Grouped nav clusters, order preserved within each group.
 *   SALES — the lead-machine surfaces (Leads · Outreach · Flow · Sources · Atlas).
 *   ADMIN — the platform-operations surfaces (Overview · Seamen · Agents ·
 *           Verify uploads · Bookings).
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    group: "Sales",
    items: [
      { label: "Leads", href: "/admin/leads" },
      { label: "Outreach", href: "/admin/outreach" },
      { label: "Flow", href: "/admin/flow" },
      { label: "Sources", href: "/admin/sources" },
      { label: "Atlas", href: "/admin/atlas" },
    ],
  },
  {
    group: "Admin",
    items: [
      { label: "Overview", href: "/admin" },
      { label: "Seamen", href: "/admin/seamen" },
      { label: "Agents", href: "/admin/agents" },
      { label: "Verify uploads", href: "/admin/verify-uploads" },
      { label: "Bookings", href: "/admin/bookings" },
    ],
  },
] as const;

/** Standalone nav items (in NO group). Empty in the public archive: the one
 *  standalone item belonged to an unrelated project and was removed. */
export const NAV_STANDALONE: readonly NavItem[] = [] as const;
