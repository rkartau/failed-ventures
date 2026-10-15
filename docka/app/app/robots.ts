import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

// IndexNow: the ownership key lives at /f845660bcf9e58c5b5f6284455f9ab50.txt
// (public/<key>.txt, content == the key). SEO Phase 2c wired the SUBMISSION half:
// `npm run indexnow:submit` (scripts/indexnow-submit.mjs) reads the live sitemap and
// POSTs every URL to https://api.indexnow.org/indexnow, so Bing/Yandex recrawl changed
// pages quickly after a deploy. See DEPLOY-RUNBOOK.md ("IndexNow submission").
//
// TS1: allow crawling everywhere EXCEPT infrastructure. Private app routes
// (/agent, /seafarer, /share, /verify/[uuid], /directory, /portal) are kept
// CRAWLABLE and handled by page/layout-level `robots: noindex` — a disallowed URL
// can't be crawled to SEE the noindex and still gets URL-only indexed if linked.
//
// AI / search crawler policy (deliberate, 2026-09-04): a SINGLE `userAgent: "*"` rule
// allows ALL crawlers, which INCLUDES the AI answer-engine and AI-training bots —
// GPTBot, OAI-SearchBot, ChatGPT-User (OpenAI), ClaudeBot/Claude-Web (Anthropic),
// PerplexityBot, Google-Extended (Gemini/AI-Overviews training), Bingbot, Applebot, etc.
// This is INTENTIONAL: Docka is a marketing/discovery site and wants maximum visibility
// and citation in AI answers (GEO), so we do NOT add per-bot `disallow` blocks for any of
// them. Only /api and /admin are disallowed (below). If a specific AI bot ever needs to be
// blocked, add a dedicated named-userAgent rule here — do not narrow the `*` allow.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api", "/admin"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
