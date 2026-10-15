"use client";

// Shared copy-to-clipboard hook — extracted from ImportCrew's inline copyLink/copiedId
// so the post-import links block AND the placeholder card kebab / claim panel share ONE
// implementation (behaviour pinned in tests). Identical semantics to the original: writes
// the text, flips `copiedId` to the given id, resets after `resetMs`, and silently swallows
// a rejected clipboard (the URL stays visible for manual copy). PLUS the reset timer is held
// in a ref and cleared on unmount / re-copy so a late timer can't set state on a gone component.

import { useCallback, useEffect, useRef, useState } from "react";

export function useCopyLink(resetMs = 1500) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    async (text: string, id: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedId(id);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          setCopiedId((c) => (c === id ? null : c));
        }, resetMs);
      } catch {
        /* clipboard unavailable — the text stays visible for manual copy */
      }
    },
    [resetMs]
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return { copiedId, copy };
}
