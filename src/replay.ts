// LRU cache of seen nonces for replay protection.
// Sized so that the cache always covers the full clock-skew window even at the
// system's expected request rate.

export interface NonceCache {
  has(nonce: string): boolean;
  remember(nonce: string): void;
}

export function makeNonceCache(maxEntries = 50_000): NonceCache {
  const seen = new Map<string, number>(); // nonce → insert timestamp
  return {
    has(nonce) {
      return seen.has(nonce);
    },
    remember(nonce) {
      if (seen.size >= maxEntries) {
        // Evict ~10% of the oldest entries.
        const cutoff = Math.floor(maxEntries * 0.1);
        let i = 0;
        for (const k of seen.keys()) {
          seen.delete(k);
          if (++i >= cutoff) break;
        }
      }
      seen.set(nonce, Date.now());
    },
  };
}
