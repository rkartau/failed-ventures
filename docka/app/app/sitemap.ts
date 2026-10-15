import type { MetadataRoute } from "next";
import { abs, SITE_URL } from "@/lib/seo";
import { SITE_PAGES } from "@/lib/site-pages";

// Marketing URLs only, no app/private routes. The list of indexable pages and their
// lastmod dates live in ONE place, `lib/site-pages.ts` (SEO plan WP-E E1); this file is
// a pure projection of it, so the sitemap and /llms.txt can never disagree about what
// is public. lastModified is that row's STATIC hand-bumped date (bumped only when the
// page's own copy changes), never build-time new Date().
export default function sitemap(): MetadataRoute.Sitemap {
  return SITE_PAGES.map((p) => ({
    // Home loc is the bare origin (SITE_URL), NO trailing slash: byte-identical to the
    // home canonical Next actually renders (it strips the root canonical's trailing slash
    // under trailingSlash:false; see app/page.tsx). abs("/") would add a slash and reopen
    // the canonical-vs-sitemap mismatch.
    url: p.path === "/" ? SITE_URL : abs(p.path),
    lastModified: p.lastmod,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));
}
