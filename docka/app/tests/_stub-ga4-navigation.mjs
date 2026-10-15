// Mutable next/navigation stand-in for the jsdom Analytics test (tests/ga4-dom.test.mjs).
// usePathname() is a real external-store subscription so a setPathname() call from the
// test re-renders every subscribed component, exactly like an App Router navigation.
// The store lives on globalThis so the hook-resolved module and the test's direct
// import share ONE store regardless of URL casing.
import React from "react";

const store = (globalThis.__ga4TestNav ??= { path: "/", listeners: new Set() });

function subscribe(listener) {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function setPathname(next) {
  store.path = next;
  for (const l of store.listeners) l();
}

export function usePathname() {
  return React.useSyncExternalStore(subscribe, () => store.path, () => store.path);
}

export function useRouter() {
  return { push() {}, refresh() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
}

export function useSearchParams() {
  return new URLSearchParams();
}
