"use client";

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

// useLayoutEffect on the client, useEffect on the server (avoids the SSR warning).
// The layout variant lets the reduced-motion branch commit the FINAL state before
// the browser paints, so a reduced-motion user never sees an empty first frame.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export type MountAnim = {
  /** true once the graph should be at its final (animated-to) state. */
  shown: boolean;
  /** true when the user prefers reduced motion — components then drop the tween. */
  reduced: boolean;
};

// Fallback delay when no ref / no IntersectionObserver: a TIMER, not rAF (rAF is
// paused in a hidden tab, which would leave the graph stuck at its empty state).
const FALLBACK_DELAY_MS = 40;

/**
 * Gates mount-in transitions for the overview graphs.
 *
 * - First render (server + client hydration) returns { shown:false } so there is
 *   no hydration mismatch, and no `new Date()` / matchMedia is read at render (BI1).
 * - Under prefers-reduced-motion it flips to { shown:true, reduced:true }
 *   IMMEDIATELY in a layout effect (IX1) — the FINAL numbers, with no tween.
 * - Otherwise (SEO plan v3 C6): when a `ref` to the graph's element is given, the
 *   flip waits for the element's FIRST intersection with the viewport, so the
 *   transitions run when the reader actually sees the graph instead of all twelve
 *   firing at page load. Without a ref, or where IntersectionObserver is missing,
 *   it flips on a short timer as before.
 */
export function useMountAnimation(ref?: RefObject<Element | null>): MountAnim {
  const [state, setState] = useState<MountAnim>({ shown: false, reduced: false });

  useIsoLayoutEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced) {
      setState({ shown: true, reduced: true });
      return;
    }

    const show = () => setState({ shown: true, reduced: false });
    const el = ref?.current ?? null;

    if (el && typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            show();
            io.disconnect();
          }
        },
        // Start a little before the graph is fully in view so the tween is
        // under way as it scrolls in, not after.
        { rootMargin: "0px 0px -10% 0px", threshold: 0.15 }
      );
      io.observe(el);
      return () => io.disconnect();
    }

    // No ref / no IO: the ~40ms delay lets the initial state paint first so the
    // CSS transition animates when the tab IS visible; a timer still fires in a
    // background tab, so the FINAL numbers always arrive.
    const timer = setTimeout(show, FALLBACK_DELAY_MS);
    return () => clearTimeout(timer);
    // `ref` is a stable RefObject; the effect intentionally runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
