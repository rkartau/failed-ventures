// Minimal next/navigation stand-in for the renderToString smoke tests (see
// tests/_tsx-hooks.mjs, mirrors _stub-next-link.mjs). The REAL next/navigation's
// useRouter() throws outside a mounted app router — components rendered bare via
// react-dom/server (ReviewPanel, PlaceholderClaimPanel's parent) only ever call
// router.push/refresh/replace from an event handler, never during render, so a
// no-op router is a faithful stand-in for a server-rendered smoke test.
export function useRouter() {
  return {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    forward() {},
    prefetch() {},
  };
}

export function usePathname() {
  return "/";
}

export function useSearchParams() {
  return new URLSearchParams();
}
