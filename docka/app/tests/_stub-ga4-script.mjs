// next/script stand-in for the jsdom Analytics test with Next 14 LoadCache semantics:
// onLoad fires exactly ONCE per `src` for the life of the page — a remount of the same
// <Script src> (Reject → Accept, private → public route) never re-fires it. Inline
// scripts (dangerouslySetInnerHTML, no src) render nothing and never call onLoad.
import React from "react";

const loaded = (globalThis.__ga4TestScriptLoaded ??= new Set());

export default function Script({ src, onLoad }) {
  React.useEffect(() => {
    if (!src || loaded.has(src)) return;
    loaded.add(src);
    if (typeof onLoad === "function") onLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return null;
}
