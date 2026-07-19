import { describe, it, expect } from 'vitest';
import { makeNonceCache } from '../src/replay.js';

describe('nonce cache — checkAndRemember (M1)', () => {
  it('claims a fresh nonce once, rejects the second claim', () => {
    const c = makeNonceCache({ ttlMs: 60_000 });
    expect(c.checkAndRemember('a')).toBe(true);
    expect(c.checkAndRemember('a')).toBe(false);
  });

  it('a nonce already remembered via remember() cannot be re-claimed', () => {
    const c = makeNonceCache({ ttlMs: 60_000 });
    c.remember('n');
    expect(c.has('n')).toBe(true);
    expect(c.checkAndRemember('n')).toBe(false);
  });

  it('distinct nonces are all claimable', () => {
    const c = makeNonceCache({ ttlMs: 60_000 });
    for (const n of ['x', 'y', 'z']) expect(c.checkAndRemember(n)).toBe(true);
  });

  it('a nonce becomes claimable again after its ttl elapses', async () => {
    const c = makeNonceCache({ ttlMs: 5 });
    expect(c.checkAndRemember('e')).toBe(true);
    expect(c.checkAndRemember('e')).toBe(false);
    await new Promise((r) => setTimeout(r, 20)); // > ttl
    expect(c.checkAndRemember('e')).toBe(true);
  });
});
