// Nonce store for replay protection.
//
// Semantics: a nonce is "seen" if we observed it within the past `ttlMs`
// window. The window MUST be at least as large as the accepted clock-skew
// window, otherwise a signed request can be replayed by waiting for its
// nonce to be forgotten before its timestamp expires.
//
// Storage: Map<nonce, insertTs>. On every insert we sweep entries older
// than ttlMs. There is also a hard `maxEntries` ceiling — if hit, we drop
// the oldest regardless of age (DoS-resistance). At expected traffic the
// age sweep is the only eviction path.

export interface NonceCache {
  has(nonce: string): boolean;
  remember(nonce: string): void;
  /**
   * Atomically claim a nonce: returns true if it was fresh (and is now
   * remembered), false if it was already seen within the TTL window.
   * Fully synchronous — no await/yield between the read and the write — so it
   * closes the check-then-set replay race that `has()` + `remember()` around an
   * `await` (e.g. reading the request body) would otherwise leave open.
   */
  checkAndRemember(nonce: string): boolean;
}

export function makeNonceCache(opts: { ttlMs: number; maxEntries?: number } = { ttlMs: 10 * 60_000 }): NonceCache {
  const ttlMs = opts.ttlMs;
  const maxEntries = opts.maxEntries ?? 200_000;
  const seen = new Map<string, number>();

  const sweep = () => {
    const cutoff = Date.now() - ttlMs;
    for (const [k, t] of seen) {
      if (t > cutoff) break; // Map preserves insertion order; newer entries follow.
      seen.delete(k);
    }
  };

  const isSeen = (nonce: string): boolean => {
    const t = seen.get(nonce);
    if (t === undefined) return false;
    if (t < Date.now() - ttlMs) {
      seen.delete(nonce);
      return false;
    }
    return true;
  };

  const store = (nonce: string): void => {
    sweep();
    if (seen.size >= maxEntries) {
      // Shouldn't happen under normal load — sweep kept it bounded. Defence in depth:
      // drop the oldest entries regardless of age.
      const toDrop = Math.max(1, Math.floor(maxEntries * 0.1));
      let i = 0;
      for (const k of seen.keys()) {
        seen.delete(k);
        if (++i >= toDrop) break;
      }
    }
    seen.set(nonce, Date.now());
  };

  return {
    has: isSeen,
    remember: store,
    checkAndRemember(nonce) {
      if (isSeen(nonce)) return false;
      store(nonce);
      return true;
    },
  };
}
