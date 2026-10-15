import { SITE_URL, SITE_DESCRIPTION } from "@/lib/seo";
import { LLMS_SECTION_ORDER, SITE_PAGES } from "@/lib/site-pages";

// /llms.txt: a plain-text entity/link summary for AI crawlers (ChatGPT, Perplexity,
// Claude, etc.). Ignored by Google Search; purely an AI-search convenience. Reuses the
// single-source SITE_DESCRIPTION + SITE_URL so it can never drift from the site's own
// metadata, and lists the pages from `lib/site-pages.ts` that carry an `llms` entry
// (SEO plan WP-E E1), grouped by section. Static: content only changes when the source
// string/registry changes.
export const dynamic = "force-static";

function line(p: (typeof SITE_PAGES)[number]): string {
  const url = p.path === "/" ? SITE_URL : `${SITE_URL}${p.path}`;
  const llms = p.llms!;
  return `- [${llms.label}](${url})${llms.blurb ? `: ${llms.blurb}` : ""}`;
}

export function GET(): Response {
  const sections = LLMS_SECTION_ORDER.map((section) => {
    const rows = SITE_PAGES.filter((p) => p.llms && p.llms.section === section);
    if (rows.length === 0) return "";
    return `## ${section}\n${rows.map(line).join("\n")}\n`;
  }).filter(Boolean);

  const body = `# Docka

> ${SITE_DESCRIPTION}

${sections.join("\n")}`;

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
