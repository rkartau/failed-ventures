// lib/product-fit-store.ts — fs shell for the pipeline's product-fit verdicts.
//
// Server-only storage for data/product-fit.json, mirroring
// lib/outreach-snapshot-store.ts: cwd-resolved data dir, tolerant read that
// never throws (missing → empty, unreadable/garbage → corrupt), atomic
// tmp+rename write. ALL validation/coercion lives in the PURE lib/product-fit.ts
// (validateProductFit / parseStoredProductFit) — this file only touches disk.
//
// The page join wants an O(1) lookup Map that it can consult once per lead
// without re-reading a multi-MB file every request, so `loadProductFitLookup`
// memoizes the parse by (mtimeMs, size) — the SAME memo pattern as
// lib/docka-leads.ts:113-120. It also returns a `version` token so the leads
// loader can fold a product-fit refresh into its OWN memo key (a new verdict
// file must invalidate the already-projected rows).
//
// The file is box-only business data (normalized contact emails) shipped by the
// pipeline, never through git — it is gitignored (see app/.gitignore).

import fs from "fs";
import path from "path";
import {
  parseStoredProductFit,
  type ProductFitData,
  type ProductFitVerdict,
} from "@/lib/product-fit";
import { stripBom } from "@/lib/outreach-snapshot";
import { memoJsonFile, __clearFileMemo } from "@/lib/file-memo";

const DATA_DIR = path.join(process.cwd(), "data");
const PRODUCT_FIT_PATH = path.join(DATA_DIR, "product-fit.json");

export function writeProductFit(d: Omit<ProductFitData, "uploadedAt">): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const full: ProductFitData = { ...d, uploadedAt: new Date().toISOString() };
  // Atomic: full write to a sibling tmp file, then rename over the target — a
  // crash mid-write can never leave a half-written file behind the page.
  const tmp = `${PRODUCT_FIT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2), "utf-8");
  fs.renameSync(tmp, PRODUCT_FIT_PATH);
}

/** Tolerant read — never throws. Missing file = "nothing uploaded yet". */
export function readProductFit():
  | { status: "ok"; data: ProductFitData }
  | { status: "empty" }
  | { status: "corrupt" } {
  let text: string;
  try {
    text = fs.readFileSync(PRODUCT_FIT_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "empty" };
    return { status: "corrupt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    return { status: "corrupt" };
  }
  return parseStoredProductFit(parsed);
}

// ---- Memoized lookup for the page join ---------------------------------

/**
 * The page-join view of the store: an O(1) verdict Map plus a `version` token.
 * `version` is stable while the file is unchanged and distinct on every refresh
 * (or on a changed-but-still-broken file), so a caller can fold it into its own
 * memo key. `generatedAt` is null when there is no usable file.
 */
export type ProductFitLookup = {
  verdicts: Map<string, ProductFitVerdict>;
  generatedAt: string | null;
  version: string;
};

// Missing → the SAME empty lookup object every call (identity, as before).
const EMPTY_LOOKUP: ProductFitLookup = {
  verdicts: new Map(),
  generatedAt: null,
  version: "empty",
};

// One-entry adapter so a corrupt/unreadable file yields the SAME lookup object
// across calls (identity, as the old single-slot memo did): memoJsonFile hands
// back the same {status:"invalid"|"unreadable"} result on a hit, but that result
// is not a ProductFitLookup, so we cache the derived empty lookup here keyed by
// (path, mtimeMs, size).
let corruptAdapter: { key: string; lookup: ProductFitLookup } | null = null;

/** Test hook: forget the lookup memo (tests rewrite the file rapidly). */
export function __clearProductFitCache(): void {
  // The old memo was a single global slot; clearing the whole file-memo map
  // reproduces that, and tests call this with a custom seam path.
  __clearFileMemo();
  corruptAdapter = null;
}

/**
 * Load the verdict lookup for the page join. Never throws. `contentPath` is a
 * test seam; production always reads cwd-resolved data/product-fit.json. A
 * missing OR corrupt file degrades to an EMPTY lookup (the page simply renders
 * every row as "pending") — a broken verdict file must never blank the leads
 * page, exactly as a broken leads refresh must not.
 */
export function loadProductFitLookup(contentPath: string = PRODUCT_FIT_PATH): ProductFitLookup {
  const res = memoJsonFile<ProductFitLookup>(
    contentPath,
    (raw, stat) => {
      const parsed = parseStoredProductFit(raw);
      if (parsed.status !== "ok") return { ok: false, error: "corrupt product-fit envelope" };
      const verdicts = new Map<string, ProductFitVerdict>(Object.entries(parsed.data.verdicts));
      return {
        ok: true,
        value: {
          verdicts,
          generatedAt: parsed.data.generatedAt,
          version: `${stat.mtimeMs}:${stat.size}`,
        },
      };
    },
    // The product-fit store never had a size cap; keep it uncapped.
    { maxBytes: Number.POSITIVE_INFINITY }
  );

  if (res.status === "ok") return res.value; // by reference — identity pin
  if (res.status === "missing") return EMPTY_LOOKUP;

  // invalid | unreadable → a corrupt-tagged empty lookup, stable per (path, stat).
  const key = `${contentPath}:${res.mtimeMs}:${res.size}`;
  if (corruptAdapter && corruptAdapter.key === key) return corruptAdapter.lookup;
  const lookup: ProductFitLookup = {
    verdicts: new Map(),
    generatedAt: null,
    version: `corrupt:${res.mtimeMs}:${res.size}`,
  };
  corruptAdapter = { key, lookup };
  return lookup;
}
