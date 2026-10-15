// Seaman self-access token storage — the SINGLE source of truth for WHERE the
// `seacred:token` self-access token lives. Every client read / write / clear of
// the token routes through here so the three adopt-readers (Google, OTP,
// magic-link) keep working.
//
// BROWSER-ONLY / SSR-SAFE: every function guards `typeof window === "undefined"`
// and returns a no-op / null on the server. NOTHING here imports server code, so
// this module is import-safe from any client component. Nothing is read during
// render — callers read inside effects / handlers.
//
// Storage model: the token lives in localStorage (persists across tabs + browser
// close). The 24h server token TTL + clear-on-sign-out make a per-tab "public
// computer" mode redundant, so sessionStorage is no longer used for the token.

/** Unchanged storage key — the server never sees it; tests read it directly. */
const TOKEN_KEY = "seacred:token";

/** The current self-access token, or null. */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

/** Persist the token. */
export function setToken(value: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, value);
}

/** Remove the token. */
export function clearToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}
