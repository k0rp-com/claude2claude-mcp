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

export function makeLimiter(specs: Record<string, LimitSpec>, maxEntries = 100_000): Limiter {
  const buckets = new Map<string, Bucket>();
  const SWEEP_INTERVAL_MS = 60_000;
  let lastSweep = 0;

  function refill(spec: LimitSpec, b: Bucket, now: number) {
    const dt = (now - b.updatedAt) / 1000;
    b.tokens = Math.min(spec.capacity, b.tokens + dt * spec.refillPerSec);
    b.updatedAt = now;
  }

  // Drop buckets that have refilled back to full capacity and sat idle — a
  // fresh bucket is created at full capacity anyway, so eviction is behaviour-
  // neutral and just bounds memory as the machine population grows (L3).
  function sweep(now: number) {
    if (now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    for (const [k, b] of buckets) {
      const action = k.slice(0, k.indexOf(':'));
      const spec = specs[action];
      if (!spec) { buckets.delete(k); continue; }
      const projected = b.tokens + ((now - b.updatedAt) / 1000) * spec.refillPerSec;
      if (projected >= spec.capacity) buckets.delete(k);
    }
  }

  return {
    check(key, action) {
      const spec = specs[action];
      if (!spec) return { ok: true };
      const k = `${action}:${key}`;
      const now = Date.now();
      sweep(now);
      let b = buckets.get(k);
      if (!b) {
        b = { tokens: spec.capacity, updatedAt: now };
        buckets.set(k, b);
      }
      refill(spec, b, now);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        // Bound memory even if keys are spoofed/rotated (e.g. pre-auth routes
        // keyed on a client header): drop oldest entries past the ceiling. A
        // dropped bucket just re-creates at full capacity — a token grant, never
        // a denial — so eviction can't wrongly block a legitimate caller.
        if (buckets.size > maxEntries) {
          const over = buckets.size - maxEntries;
          let i = 0;
          for (const oldK of buckets.keys()) {
            if (oldK === k) continue; // never evict the one we just used
            buckets.delete(oldK);
            if (++i >= over) break;
          }
        }
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
