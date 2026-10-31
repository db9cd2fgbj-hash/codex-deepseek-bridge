// Auth manager: caches a single DeepSeek client, dedupes concurrent creation, supports invalidation.
export function createAuthManager({ loadCredentials, createClient }) {
  let cached = null;
  let pending = null;

  function getClient(signal) {
    if (cached) return Promise.resolve(cached);
    if (pending) return pending;

    const load = (async () => {
      const credentials = await loadCredentials();
      if (!credentials?.cookie || !credentials?.bearer) {
        throw new Error("还没有 DeepSeek 登录凭证，请先登录。");
      }
      return createClient(credentials, signal);
    })();

    pending = load.then(
      (client) => {
        cached = client;
        pending = null;
        return client;
      },
      (error) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  }

  function invalidate() {
    cached = null;
    pending = null;
  }

  return { getClient, invalidate };
}
