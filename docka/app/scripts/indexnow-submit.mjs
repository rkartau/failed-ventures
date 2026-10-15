#!/usr/bin/env node
// IndexNow submission — pings Bing/Yandex (and other IndexNow participants) with the
// canonical marketing URLs after a content deploy, so the changed pages are recrawled
// quickly instead of waiting for the next organic crawl.
//
// Ownership is already established by the key FILE served at
//   https://docka.me/f845660bcf9e58c5b5f6284455f9ab50.txt   (public/<key>.txt == the key)
// This script performs the SUBMISSION half of IndexNow.
//
// It reads the LIVE sitemap.xml (the deployed source of truth for indexable URLs) and
// posts every <loc> to the IndexNow endpoint, so the URL list can never drift from what
// the site actually publishes — no hardcoded list to maintain.
//
// Usage (from app/):
//   node scripts/indexnow-submit.mjs            # submit every sitemap URL
//   node scripts/indexnow-submit.mjs --dry-run  # print what WOULD be submitted, POST nothing
//   SITE_URL=https://docka.me node scripts/indexnow-submit.mjs
//
// No dependencies — Node 18+ global fetch. Exit non-zero on failure so a deploy step can
// gate on it if desired (it is optional; a failure here never breaks the site).

const KEY = "f845660bcf9e58c5b5f6284455f9ab50";
const SITE_URL = (process.env.SITE_URL ?? "https://docka.me").replace(/\/+$/, "");
const HOST = new URL(SITE_URL).host;
const KEY_LOCATION = `${SITE_URL}/${KEY}.txt`;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const DRY_RUN = process.argv.includes("--dry-run");

async function fetchSitemapUrls() {
  const res = await fetch(`${SITE_URL}/sitemap.xml`, { headers: { accept: "application/xml" } });
  if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  // Only submit URLs on our own host (IndexNow rejects a mixed-host urlList).
  return [...new Set(locs)].filter((u) => {
    try {
      return new URL(u).host === HOST;
    } catch {
      return false;
    }
  });
}

async function main() {
  const urlList = await fetchSitemapUrls();
  if (urlList.length === 0) throw new Error("no sitemap URLs found to submit");

  console.log(`IndexNow: host=${HOST} keyLocation=${KEY_LOCATION} urls=${urlList.length}`);
  for (const u of urlList) console.log(`  - ${u}`);

  if (DRY_RUN) {
    console.log("IndexNow: --dry-run, nothing submitted.");
    return;
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList }),
  });
  // IndexNow returns 200 (accepted) or 202 (accepted, validation pending). Both are OK.
  const body = await res.text().catch(() => "");
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`IndexNow POST failed: ${res.status} ${res.statusText} ${body}`);
  }
  console.log(`IndexNow: submitted ${urlList.length} URLs — ${res.status} ${res.statusText}`);
}

main().catch((err) => {
  console.error(`IndexNow: ${err.message}`);
  process.exit(1);
});
