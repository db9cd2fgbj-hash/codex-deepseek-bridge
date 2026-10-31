// TTL session store: Map-based with lazy expiry check on get and auto-delete.
export function createSessionStore({ ttlMs = 30 * 60 * 1000 } = {}) {
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  function del(key) {
    store.delete(key);
  }

  function invalidateAll() {
    store.clear();
  }

  function size() {
    return store.size;
  }

  return { get, set, delete: del, invalidateAll, size };
}
