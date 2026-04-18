import type { Db } from './db.js';

export interface CleanupOptions {
  /** Delete acked messages older than this. Default 7 days. */
  ackedTtlMs?: number;
  /** Delete ALL messages older than this (acked or not). Default 30 days. */
  staleTtlMs?: number;
  /** How often to run. Default 1 hour. */
  intervalMs?: number;
  onSweep?: (res: { acked: number; stale: number }) => void;
}

export function startCleanup(db: Db, opts: CleanupOptions = {}): { stop: () => void } {
  const ackedTtlMs = opts.ackedTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  const staleTtlMs = opts.staleTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000;

  const tick = () => {
    try {
      const res = db.cleanupOlderThan(ackedTtlMs, staleTtlMs);
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
