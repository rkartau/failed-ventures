// The WRITING-STYLE-GUIDE.md §4 mechanical scan, shared by the SEO suites.
//
// Lifted verbatim from tests/seo-new-pages-e.test.mjs, where it was duplicated in
// tests/seo-content-d.test.mjs (the only textual difference there was the first regex spelling
// its six codepoints literally instead of as escapes; same characters, same behaviour).
// tests/seo-guides-e2.test.mjs keeps its own STYLE_REGEXES on purpose: that set is stricter.

// Regexes copied from the guide. The guide names four hits a reviewer may tolerate in ordinary
// use ("rather than", "represents", "certainly", "overall"); those are allowed at most once per
// page and only when they are not in prose we wrote for this WP (today: the verbatim HOME_FAQ[0]
// definition on the PSV page carries one "rather than").
export const STYLE_HARD = [
  [/[\u2014\u2013\u201C\u201D\u2018\u2019]/g, "typographic dash/quote"],
  [
    /\b(delve|delving|crucial|pivotal|robust|seamless(ly)?|landscape|tapestry|testament|navigat(e|ing)|leverag(e|ing)|harness(es|ing)?|unlock(s|ing)?|elevat(e|ing)|empower(s|ing)?|streamlin(e|ing)|cutting-edge|game-?chang(er|ing)|groundbreaking|vibrant|boasts?|bolster(s|ed|ing)?|intricate|interplay|meticulous(ly)?|underscor(e|es|ing)|foster(s|ing)?|showcas(e|es|ing)|garner(s|ed)?|enduring|ever-evolving|holistic|synergy|realm|transformative|revolutioni[sz]e)\b/gi,
    "banned vocabulary",
  ],
  [/\b(highlighting|underscoring|emphasi[sz]ing|reflecting|symboli[sz]ing|contributing to)\b/gi, "-ing tail"],
  [/\b(serves as|stands as|functions as|operates as)\b/gi, "copula substitute"],
  [/\b(not only|not just|isn't just|is not just|more than just)\b/gi, "not only / not just"],
  [/\b(in conclusion|in summary|to sum up|final thoughts|ultimately)\b/gi, "closing summary"],
  [/\b(it'?s (important|worth) (to note|noting)|notably|importantly|interestingly|essentially|additionally|furthermore|moreover)\b/gi, "hedging / glue"],
  [/\b(whether you'?re|in today'?s|in the world of|in an era of|in the (ever-)?evolving|fast-paced)\b/gi, "opener cliche"],
  [/\b(great question|i hope this helps|let'?s dive|please note|as of my last|at the time of writing|as an ai)\b/gi, "chatbot residue"],
  [/\b(experts (say|agree|argue)|industry reports|observers (note|have)|widely (recogni[sz]ed|regarded)|some critics)\b/gi, "vague attribution"],
  [/\b(world-class|state-of-the-art|best-in-class|trusted by|leading provider|nestled|in the heart of)\b/gi, "promotional filler"],
  [/(\*\*|^#{1,6} |^---$|utm_source=|\[insert|lorem ipsum|TBD)/gm, "markdown artefact / placeholder"],
];
export const STYLE_TOLERATED = [/\brather than\b/gi, /\brepresents a\b/gi, /\bcertainly\b/gi, /\boverall,/gi];

/**
 * Run the mechanical scan over one labelled string and return the failure lines.
 * Hard regexes fail on any hit; tolerated phrases fail only above `tolerated` hits
 * (default 1 = the per-page "at most once" allowance the guide grants a reviewer;
 * pass `{ tolerated: 0 }` when the input is a single string rather than a whole page).
 */
export function scanStyle(label, text, { tolerated = 1 } = {}) {
  const failures = [];
  for (const [re, name] of STYLE_HARD) {
    const hits = text.match(re);
    if (hits) failures.push(`${label}: ${name}: ${[...new Set(hits)].join(", ")}`);
  }
  for (const re of STYLE_TOLERATED) {
    const hits = text.match(re) || [];
    if (hits.length > tolerated) failures.push(`${label}: tolerated phrase used more than ${tolerated} time(s): ${hits[0]} (${hits.length})`);
  }
  return failures;
}
