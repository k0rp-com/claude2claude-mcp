import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { startCleanup } from '../src/cleanup.js';
import { generateEd25519 } from '../src/crypto.js';

function pk() { return generateEd25519().publicKeyPem; }

// Force a message's created_at backwards so it appears older than TTL.
// Test-only — production code never mutates created_at.
function ageMessage(dbPath: string, id: string, ageMs: number) {
  const raw = new Database(dbPath);
  raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - ageMs, id);
  raw.close();
}

describe('cleanup — unacked TTL', () => {
  it('deletes unacked messages older than unackedTtlMs, keeps fresh ones', () => {
    // Need a file-backed db so we can reopen it to manipulate created_at.
    const path = `/tmp/c2c-cleanup-${Date.now()}-${Math.random()}.db`;
    const db = openDb(path);
    const alice = db.registerMachine({ pubkeyPem: pk(), name: 'alice' });
    const bob = db.registerMachine({ pubkeyPem: pk(), name: 'bob' });
    db.createPairing(alice.id, bob.id);

    const fresh = db.send({ fromId: alice.id, toId: bob.id, kind: 'request', body: 'fresh' });
    const old = db.send({ fromId: alice.id, toId: bob.id, kind: 'request', body: 'stale' });
    db.close();
    ageMessage(path, old.id, 5 * 60 * 1000);

    const db2 = openDb(path);
    const res = db2.cleanupOlderThan(7 * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000, 2 * 60 * 1000);
    expect(res.unacked).toBe(1);
    expect(db2.countUnacked(bob.id)).toBe(1);
    // Fresh message still retrievable.
    const inbox = db2.inbox(bob.id, 0);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.id).toBe(fresh.id);
    db2.close();
  });

  it('startCleanup wires unackedTtlMs into the sweep', () => {
    const db = openDb(':memory:');
    const alice = db.registerMachine({ pubkeyPem: pk(), name: 'alice' });
    const bob = db.registerMachine({ pubkeyPem: pk(), name: 'bob' });
    db.createPairing(alice.id, bob.id);
    db.send({ fromId: alice.id, toId: bob.id, kind: 'request', body: 'hi' });

    const sweeps: Array<{ acked: number; stale: number; unacked: number }> = [];
    const handle = startCleanup(db, {
      unackedTtlMs: 0, // everything older than "now" → everything
      intervalMs: 60_000,
      onSweep: (r) => sweeps.push(r),
    });
    handle.stop();

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.unacked).toBe(1);
    db.close();
  });
});
