"use client";

// Shared dismissal behavior for the agent-toolbar popovers (Import crew, Add by
// link, Hidden crew). Spread the returned props on the `relative` container that
// wraps the TRIGGER BUTTON and its absolute popover. Two ways out while open:
//   - CLICK-OUTSIDE: any pointerdown outside the container closes IMMEDIATELY
//     (document-level listener attached only while open; pointerdowns INSIDE the
//     container — including the trigger — are ignored, so the trigger's own
//     click-toggle never double-fires through this listener);
//   - HOVER-AWAY: pointer leaves the container => close after a ~300ms grace
//     delay; re-entering cancels the timer. It is suppressed only while a TEXT
//     FIELD inside the menu has focus (typing must not lose the menu) — a focused
//     trigger BUTTON does not block it (clicking the trigger focuses it, which
//     previously made hover-away dead in real usage).
// Callers keep their own guards inside `close` (e.g. never mid-DELETE/mid-import).

import { useCallback, useEffect, useRef } from "react";

function textEntryHasFocus(container: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!container || !active || !container.contains(active)) return false;
  const tag = active.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (active as HTMLElement).isContentEditable
  );
}

export function useMenuDismiss(open: boolean, close: () => void, graceMs = 300) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Always call the LATEST close (with its caller guards) from the async paths.
  const closeRef = useRef(close);
  closeRef.current = close;

  const cancelClose = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onMouseLeave = useCallback(() => {
    if (!open) return;
    cancelClose();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (textEntryHasFocus(containerRef.current)) return;
      closeRef.current();
    }, graceMs);
  }, [open, graceMs, cancelClose]);

  // Click-outside: document-level, only while open, immediate (no grace delay).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = containerRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // A closed menu needs no pending timer; also clear on unmount.
  useEffect(() => {
    if (!open) cancelClose();
  }, [open, cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  return { ref: containerRef, onMouseEnter: cancelClose, onMouseLeave };
}
