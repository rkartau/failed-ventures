// Test stub for `next/headers` (plain node has no Next request scope). Cookies are
// read from globalThis.__TEST_COOKIES ({ name: value }); headers are empty. This
// lets the REAL agentSession()/seamanSession() dev-cookie paths mint sessions in
// tests, or stay anonymous when the map is empty.
export function cookies() {
  const store = globalThis.__TEST_COOKIES ?? {};
  return {
    get(name) {
      return Object.prototype.hasOwnProperty.call(store, name)
        ? { name, value: store[name] }
        : undefined;
    },
    set() {},
    delete() {},
  };
}

export function headers() {
  return new Map();
}
