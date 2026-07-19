import { describe, it, expect } from 'vitest';
import { makeLimiter } from '../src/rateLimit.js';

describe('rateLimit — token bucket', () => {
  it('allows up to capacity, then limits with a retry hint', () => {
    const lim = makeLimiter({ t: { capacity: 2, refillPerSec: 0 } });
    expect(lim.check('k', 't')).toEqual({ ok: true });
    expect(lim.check('k', 't')).toEqual({ ok: true });
    const r = lim.check('k', 't');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('refills over time', async () => {
    const lim = makeLimiter({ t: { capacity: 1, refillPerSec: 100 } });
    expect(lim.check('k', 't').ok).toBe(true);
    expect(lim.check('k', 't').ok).toBe(false);
    await new Promise((r) => setTimeout(r, 25)); // 100/s → refilled well within
    expect(lim.check('k', 't').ok).toBe(true);
  });

  it('unknown action is never limited', () => {
    const lim = makeLimiter({ t: { capacity: 1, refillPerSec: 0 } });
    for (let i = 0; i < 5; i++) expect(lim.check('k', 'nope').ok).toBe(true);
  });

  it('distinct keys have independent buckets', () => {
    const lim = makeLimiter({ t: { capacity: 1, refillPerSec: 0 } });
    expect(lim.check('a', 't').ok).toBe(true);
    expect(lim.check('a', 't').ok).toBe(false);
    expect(lim.check('b', 't').ok).toBe(true); // b unaffected by a
  });

  it('evicts old buckets past maxEntries so the Map cannot grow unbounded (L3)', () => {
    // maxEntries 2, refill 0 → an exhausted bucket stays exhausted UNLESS evicted.
    const lim = makeLimiter({ t: { capacity: 1, refillPerSec: 0 } }, 2);
    expect(lim.check('hot', 't').ok).toBe(true);
    expect(lim.check('hot', 't').ok).toBe(false); // exhausted, still resident
    // Flood distinct keys → size crosses maxEntries → oldest ('hot') evicted.
    for (let i = 0; i < 10; i++) lim.check(`cold${i}`, 't');
    // 'hot' was evicted, so it re-creates fresh at full capacity → allowed again.
    expect(lim.check('hot', 't').ok).toBe(true);
  });

  it('describe() echoes the specs', () => {
    const specs = { t: { capacity: 3, refillPerSec: 1 } };
    expect(makeLimiter(specs).describe()).toEqual(specs);
  });
});
