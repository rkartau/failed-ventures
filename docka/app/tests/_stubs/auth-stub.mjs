// Test stub for `@/auth` — auth() resolves globalThis.__TEST_AUTH ?? null (an
// anonymous caller by default). Only the symbols the loaded server modules import
// are stubbed; none of the NextAuth wiring runs in tests.
export async function auth() {
  return globalThis.__TEST_AUTH ?? null;
}
export const isGoogleConfigured = false;
export const OAUTH_ROLE_COOKIE = "docka_oauth_role";
export const OAUTH_ADOPT_COOKIE = "docka_adopt_token";
export const handlers = {};
export const signIn = async () => {};
export const signOut = async () => {};
