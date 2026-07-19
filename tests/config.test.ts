import { describe, it, expect } from 'vitest';
import { config } from '../src/config.js';

// Env is set by tests/setup.ts before this module loads (config reads env once
// at import time). These assertions pin the zod coercion/defaults/derivations.
describe('config', () => {
  it('exposes LONGPOLL_MAX_CONCURRENT with a positive default of 64', () => {
    // setup.ts does not set LONGPOLL_MAX_CONCURRENT → zod default applies.
    expect(typeof config.longpollMaxConcurrent).toBe('number');
    expect(config.longpollMaxConcurrent).toBe(64);
    expect(config.longpollMaxConcurrent).toBeGreaterThan(0);
  });

  it('coerces numeric env and derives *Ms fields from seconds', () => {
    expect(config.maxLongPollSeconds).toBe(5); // setup: MAX_LONG_POLL_SECONDS=5
    expect(config.clockSkewMs).toBe(300 * 1000); // setup: CLOCK_SKEW_SECONDS=300 → ms
    expect(config.pairRequestTtlMs).toBe(120 * 1000); // setup: 120s → ms
  });

  it('requires a >=32-char mediator token', () => {
    expect(config.mediatorToken.length).toBeGreaterThanOrEqual(32);
  });
});
