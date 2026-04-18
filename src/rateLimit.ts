// Simple in-memory token bucket per (key, action). Single-process, single-server only.
// If you ever scale horizontally, replace with Redis or a shared store.

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface Limiter {
  check(key: string, action: string): { ok: true } | { ok: false; retryAfterSec: number };
  describe(): Record<string, { capacity: number; refillPerSec: number }>;
}

export interface LimitSpec {
  capacity: number;       // max burst
  refillPerSec: number;   // sustained rate
}

export function makeLimiter(specs: Record<string, LimitSpec>): Limiter {
  const buckets = new Map<string, Bucket>();

  function refill(spec: LimitSpec, b: Bucket, now: number) {
    const dt = (now - b.updatedAt) / 1000;
    b.tokens = Math.min(spec.capacity, b.tokens + dt * spec.refillPerSec);
    b.updatedAt = now;
  }

  return {
    check(key, action) {
      const spec = specs[action];
      if (!spec) return { ok: true };
      const k = `${action}:${key}`;
      const now = Date.now();
      let b = buckets.get(k);
      if (!b) {
        b = { tokens: spec.capacity, updatedAt: now };
        buckets.set(k, b);
      }
      refill(spec, b, now);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      const needed = 1 - b.tokens;
      const retryAfterSec = Math.max(1, Math.ceil(needed / spec.refillPerSec));
      return { ok: false, retryAfterSec };
    },
    describe() {
      return specs;
    },
  };
}
