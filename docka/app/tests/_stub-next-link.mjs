// Minimal next/link stand-in for the renderToString smoke tests (see
// tests/_tsx-hooks.mjs). Renders a plain anchor — the smoke assertions never
// depend on Link behaviour, only on the surrounding markup.
import React from "react";

export default function Link({ href, children, ...rest }) {
  const h = typeof href === "string" ? href : String(href ?? "");
  return React.createElement("a", { href: h, ...rest }, children);
}
