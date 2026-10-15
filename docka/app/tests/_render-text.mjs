// Shared element-tree helpers for the harness-rendered `{ type, props }` trees that
// tests/_route-harness.mjs produces (no React: the jsx runtime stub returns plain objects).
//
// `expand` and friends are lifted verbatim from tests/seo-new-pages-e.test.mjs, where they were
// duplicated byte-for-byte in tests/seo-content-d.test.mjs; `expandShallow` is the different,
// shallow variant moved verbatim from tests/seo-guides-e2.test.mjs. Behaviour of all three
// suites is unchanged by the extraction.

import { JSX_FRAGMENT } from "./_route-harness.mjs";

/** Expand function components so the tree is plain `{ type: string, props }` nodes. */
export function expand(node, depth = 0) {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return node.map((n) => expand(n, depth)).filter((n) => n != null);
  if (depth > 60) throw new Error("expand: recursion too deep");
  const { type, props = {} } = node;
  if (typeof type === "function") return expand(type(props), depth + 1);
  const children = props.children === undefined ? undefined : expand(props.children, depth + 1);
  return { type: type === JSX_FRAGMENT ? "fragment" : type, props: { ...props, children } };
}
export const render = (mod) => expand(mod.default({}));

export function walk(node, fn) {
  if (node == null) return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn));
  if (typeof node !== "object") return;
  fn(node);
  walk(node.props?.children, fn);
}
export function collectLdJson(tree) {
  const out = [];
  walk(tree, (n) => {
    if (n.type === "script" && n.props?.dangerouslySetInnerHTML?.__html) out.push(n.props.dangerouslySetInnerHTML.__html);
  });
  return out.map((h) => JSON.parse(h));
}
export const ofType = (objs, type) => objs.filter((o) => o && o["@type"] === type);
/** Visible text (script contents excluded), whitespace-normalised. */
// `skipStrip`: the shared WhatDockaIs positioning strip (components/WhatDockaIs.tsx) is site-wide
// chrome counted on no page; the word-count gates measure the page's own prose, so they skip it.
export function textOf(tree, skipStrip = false) {
  const parts = [];
  (function rec(n) {
    if (n == null) return;
    if (typeof n === "string" || typeof n === "number") return parts.push(String(n));
    if (Array.isArray(n)) return n.forEach(rec);
    if (n.type === "script") return;
    if (skipStrip && n.props?.["data-testid"] === "what-docka-is") return;
    rec(n.props?.children);
  })(tree);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
export function collectVisibleQuestions(tree) {
  const out = [];
  walk(tree, (n) => {
    if (n.props && "data-faq-q" in n.props) out.push(textOf(n.props.children));
  });
  return out;
}
export function collectHrefs(tree) {
  const out = [];
  walk(tree, (n) => {
    if (n.type === "a" && typeof n.props?.href === "string") out.push({ href: n.props.href, rel: n.props.rel, target: n.props.target });
  });
  return out;
}
export function collectTestIds(tree) {
  const out = new Map();
  walk(tree, (n) => {
    if (n.props?.["data-testid"]) out.set(n.props["data-testid"], n);
  });
  return out;
}

// The guides suite walks per node and re-expands as it goes, so it needs a SHALLOW expand that
// returns the node itself (not a rebuilt tree). Deliberately not the same function as `expand`.
export function expandShallow(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandShallow);
  if (typeof node.type === "function") return expandShallow(node.type(node.props || {}));
  return node;
}
