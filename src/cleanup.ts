import type { Db } from './db.js';

export interface CleanupOptions {
  /** Delete acked messages older than this. Default 7 days. */
  ackedTtlMs?: number;
  /** Delete ALL messages older than this (acked or not). Default 30 days. */
  staleTtlMs?: number;
  /**
   * Delete UNACKED messages older than this. Final backstop so the inbox
   * never piles up if a recipient's client can't ack (crash, network,
   * stop-hook emit failure). Default 2 minutes — short enough that a dead
   * peer can't swamp storage, long enough to cover normal long-poll
   * delivery + retry on next Stop.
   */
  unackedTtlMs?: number;
  /** How often to run. Default 1 minute (so unacked TTL resolution stays useful). */
  intervalMs?: number;
  onSweep?: (res: { acked: number; stale: number; unacked: number }) => void;
}

export function startCleanup(db: Db, opts: CleanupOptions = {}): { stop: () => void } {
  const ackedTtlMs = opts.ackedTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  const staleTtlMs = opts.staleTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const unackedTtlMs = opts.unackedTtlMs ?? 2 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 60 * 1000;

  const tick = () => {
    try {
      const res = db.cleanupOlderThan(ackedTtlMs, staleTtlMs, unackedTtlMs);
      opts.onSweep?.(res);
    } catch {
      /* swallow — never crash the server because of cleanup */
    }
  };

  // Run once on start, then periodically.
  tick();
  const handle = setInterval(tick, intervalMs);
  handle.unref();
  return { stop: () => clearInterval(handle) };
}
