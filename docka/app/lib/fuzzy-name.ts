// Transliteration-robust name matching primitives (#37) — hand-rolled, PURE, no npm
// dependency, client-safe (no Node built-ins). Exact-normalized matching misses the
// transliteration variants that make cross-agency dedup real (persona Maria):
// Aleksandr↔Alexander, Ivanov↔Ivanoff, Nguyễn↔Nguyen. These four functions supply the
// diacritic fold, edit distance, order-insensitive token overlap, and a Latin-only
// phonetic key the person-matcher combines.
//
// #4(critic) — `phoneticKey` is LATIN-ONLY. It is MEANINGLESS for CJK/Cyrillic-script
// names, so the matcher never relies on phonetics for those: it relies on
// foldDiacritics + tokenSetRatio and, decisively, on DOB / unique-code corroboration.
// A pure unit test (tests/fuzzy-name.test.mjs) gates this file before any UI wiring.

/** NFD-decompose + strip combining marks: "Nguyễn" -> "Nguyen", " Jörg" -> "Jorg". */
export function foldDiacritics(s: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Classic Levenshtein edit distance (insert/delete/substitute = 1). Two-row DP, O(n·m)
 * time / O(m) space. Callers should short-circuit on a large length delta BEFORE calling
 * (a delta > threshold can never be within it) — see the route input bounds (#3 critic).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
}

/** Fold + lower-case + split into non-empty tokens. */
function tokens(s: string): string[] {
  return foldDiacritics(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Order-insensitive token overlap in 0..1 (Jaccard over token sets): |A∩B| / |A∪B|.
 * "Ivan Petrov" vs "Petrov Ivan" -> 1; disjoint names -> 0. Empty on either side -> 0.
 */
export function tokenSetRatio(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Consonant-class map (Metaphone-ish): letters in the same articulatory class reduce to
// one representative, so spelling variants (v/f, c/k, d/t) collapse together. Vowels and
// H/Y are dropped (except a leading vowel, kept for anchoring). NULL = drop the letter.
const CLASS: Record<string, string | null> = {
  A: "*", E: "*", I: "*", O: "*", U: "*", // vowels (leading kept, else dropped)
  B: "P", P: "P",
  V: "F", F: "F", W: "F",
  C: "K", K: "K", G: "K", J: "K", Q: "K",
  S: "S", Z: "S",
  D: "T", T: "T",
  L: "L",
  M: "M",
  N: "N",
  R: "R",
  H: null,
  Y: null,
};

/**
 * A small Latin-only phonetic key: Aleksandr↔Alexander, Ivanov↔Ivanoff, Mohammed↔Muhammad
 * reduce to the SAME key; distinct names (Petrov/Popov, Johnson/Jackson) do not. Returns
 * "" for a non-Latin / empty input (so two CJK names never collide on a shared "").
 */
export function phoneticKey(s: string): string {
  let up = foldDiacritics(s).toUpperCase().replace(/[^A-Z]/g, "");
  if (!up) return "";
  up = up.replace(/X/g, "KS"); // X -> KS (Alexander == Aleksandr)
  const out: string[] = [];
  for (let i = 0; i < up.length; i++) {
    const cls = CLASS[up[i]];
    if (cls === undefined) continue; // unknown letter — drop
    if (cls === null) continue; // H / Y — drop
    if (cls === "*") {
      // vowel: keep ONLY when it is the leading character
      if (i === 0) out.push("A");
      continue;
    }
    out.push(cls);
  }
  // Collapse consecutive duplicates across the whole sequence.
  const collapsed: string[] = [];
  for (const c of out) if (collapsed[collapsed.length - 1] !== c) collapsed.push(c);
  return collapsed.join("");
}

// ---- Combined name predicates (used by the person matcher) --------------

/** Folded, lower-cased, whitespace-collapsed full name — the string edit-distance basis. */
export function normFullName(s: string): string {
  return foldDiacritics(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * NEAR-EXACT full-name match (#37.1) — a spelling/transliteration variant of the SAME
 * full name, NOT a loose token overlap: order-insensitive equality of ALL folded tokens,
 * OR Levenshtein ≤ 1 on the whole folded name. Short-circuits on a length delta > 1.
 */
export function nameNearExact(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length > 0 && ta.length === tb.length) {
    const sa = [...ta].sort();
    const sb = [...tb].sort();
    if (sa.every((t, i) => t === sb[i])) return true;
  }
  const fa = normFullName(a).replace(/\s+/g, "");
  const fb = normFullName(b).replace(/\s+/g, "");
  if (!fa || !fb) return false;
  if (Math.abs(fa.length - fb.length) > 1) return false;
  return levenshtein(fa, fb) <= 1;
}

/**
 * FUZZY full-name match (the flag-only tier): tokenSetRatio ≥ 0.8 OR equal non-empty
 * phoneticKey OR Levenshtein ≤ 2 on the folded full name. Short-circuits levenshtein on
 * a length delta > 2 (#3 critic — it can't be within the threshold).
 */
export function nameFuzzy(a: string, b: string): boolean {
  if (tokenSetRatio(a, b) >= 0.8) return true;
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  if (ka && kb && ka === kb) return true;
  const fa = normFullName(a).replace(/\s+/g, "");
  const fb = normFullName(b).replace(/\s+/g, "");
  if (!fa || !fb) return false;
  if (Math.abs(fa.length - fb.length) > 2) return false;
  return levenshtein(fa, fb) <= 2;
}
