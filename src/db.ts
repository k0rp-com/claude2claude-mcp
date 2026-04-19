import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { fingerprint as fpOf, idFromPubkey } from './crypto.js';

export type MessageKind = 'request' | 'reply' | 'notice';

export interface Machine {
  id: string;              // uuid
  pubkey_pem: string;
  name: string;
  fingerprint: string;     // derived from pubkey
  created_at: number;
  last_seen_at: number | null;
}

export interface PairRequest {
  id: string;
  from_id: string;
  to_id: string;
  code_salt: string;
  code_hash: string;
  attempts: number;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  status: 'pending' | 'confirmed' | 'expired' | 'rejected' | 'exhausted';
}

export interface Pairing {
  a_id: string;            // lex-min of two machine ids
  b_id: string;            // lex-max
  paired_at: number;
}

export interface Message {
  id: string;
  thread_id: string;
  from_id: string;
  to_id: string;
  kind: MessageKind;
  body: string;
  reply_to: string | null;
  created_at: number;
  delivered_at: number | null;
  ack_at: number | null;
}

export interface Db {
  // Machines
  registerMachine(args: { pubkeyPem: string; name: string }): Machine;
  updateMachineName(id: string, name: string): Machine | null;
  getMachine(id: string): Machine | null;
  getMachineByFingerprint(fp: string): Machine | null;
  touchMachine(id: string): void;

  // Pair requests
  createPairRequest(args: { fromId: string; toId: string; codeSalt: string; codeHash: string; ttlMs: number }): PairRequest;
  getPairRequest(id: string): PairRequest | null;
  listPendingPairRequestsFor(machineId: string): PairRequest[];
  consumePairRequest(id: string, codeProvided: string, hasher: (code: string, salt: string) => string): { ok: true; req: PairRequest } | { ok: false; reason: 'expired' | 'wrong_code' | 'exhausted' | 'not_found' | 'already_consumed' };
  rejectPairRequest(id: string): boolean;
  expirePairRequests(now: number): number;

  // Pairings
  createPairing(a: string, b: string): Pairing;
  hasPairing(a: string, b: string): boolean;
  listPairingsFor(machineId: string): Array<{ peer: Machine; paired_at: number }>;
  removePairing(a: string, b: string): boolean;

  // Messages
  send(args: { fromId: string; toId: string; kind: MessageKind; body: string; replyTo?: string | null; unackedCap?: number }): Message;
  inbox(toId: string, sinceCreatedAt?: number): Message[];
  inboxPeek(toId: string, sinceCreatedAt?: number): Array<Pick<Message, 'id' | 'from_id' | 'kind' | 'thread_id' | 'created_at'>>;
  countUnacked(toId: string): number;
  ack(id: string, owner: string): boolean;
  getMessage(id: string): Message | null;
  thread(threadId: string, requesterId: string): Message[];
  cleanupOlderThan(ackedOlderThanMs: number, allOlderThanMs: number, unackedOlderThanMs: number): { acked: number; stale: number; unacked: number };

  events: EventEmitter;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id            TEXT PRIMARY KEY,
  pubkey_pem    TEXT NOT NULL,
  name          TEXT NOT NULL,
  fingerprint   TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_machines_fp ON machines (fingerprint);

CREATE TABLE IF NOT EXISTS pair_requests (
  id            TEXT PRIMARY KEY,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  code_salt     TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_pr_to_status ON pair_requests (to_id, status, expires_at);

CREATE TABLE IF NOT EXISTS pairings (
  a_id          TEXT NOT NULL,
  b_id          TEXT NOT NULL,
  paired_at     INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
CREATE INDEX IF NOT EXISTS idx_pairings_b ON pairings (b_id);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('request','reply','notice')),
  body          TEXT NOT NULL,
  reply_to      TEXT,
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER,
  ack_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_to_undelivered ON messages (to_id, ack_at, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created_at);
`;

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA);

  const events = new EventEmitter();
  events.setMaxListeners(0);

  // ── machines
  const machInsert = sqlite.prepare<[string, string, string, string, number]>(`
    INSERT INTO machines (id, pubkey_pem, name, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)
  `);
  const machGetById = sqlite.prepare<[string]>(`SELECT * FROM machines WHERE id = ?`);
  const machGetByFp = sqlite.prepare<[string]>(`SELECT * FROM machines WHERE fingerprint = ?`);
  const machUpdateName = sqlite.prepare<[string, string]>(`UPDATE machines SET name = ? WHERE id = ?`);
  const machTouch = sqlite.prepare<[number, string]>(`UPDATE machines SET last_seen_at = ? WHERE id = ?`);

  // ── pair_requests
  const prInsert = sqlite.prepare<[string, string, string, string, string, number, number]>(`
    INSERT INTO pair_requests (id, from_id, to_id, code_salt, code_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const prGet = sqlite.prepare<[string]>(`SELECT * FROM pair_requests WHERE id = ?`);
  const prListPendingTo = sqlite.prepare<[string, number]>(`
    SELECT * FROM pair_requests WHERE to_id = ? AND status = 'pending' AND expires_at > ?
    ORDER BY created_at ASC
  `);
  const prIncAttempts = sqlite.prepare<[string]>(`UPDATE pair_requests SET attempts = attempts + 1 WHERE id = ?`);
  const prSetStatus = sqlite.prepare<[string, number, string]>(`UPDATE pair_requests SET status = ?, consumed_at = ? WHERE id = ?`);
  const prExpire = sqlite.prepare<[number]>(`UPDATE pair_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`);

  // ── pairings
  const pairInsert = sqlite.prepare<[string, string, number]>(`
    INSERT INTO pairings (a_id, b_id, paired_at) VALUES (?, ?, ?)
    ON CONFLICT(a_id, b_id) DO NOTHING
  `);
  const pairExists = sqlite.prepare<[string, string]>(`SELECT 1 FROM pairings WHERE a_id = ? AND b_id = ?`);
  const pairListA = sqlite.prepare<[string]>(`SELECT b_id AS peer_id, paired_at FROM pairings WHERE a_id = ?`);
  const pairListB = sqlite.prepare<[string]>(`SELECT a_id AS peer_id, paired_at FROM pairings WHERE b_id = ?`);
  const pairDelete = sqlite.prepare<[string, string]>(`DELETE FROM pairings WHERE a_id = ? AND b_id = ?`);

  // ── messages
  const msgInsert = sqlite.prepare<[string, string, string, string, MessageKind, string, string | null, number]>(`
    INSERT INTO messages (id, thread_id, from_id, to_id, kind, body, reply_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const msgGet = sqlite.prepare<[string]>(`SELECT * FROM messages WHERE id = ?`);
  const msgInbox = sqlite.prepare<[string, number]>(`
    SELECT * FROM messages WHERE to_id = ? AND ack_at IS NULL AND created_at > ?
    ORDER BY created_at ASC LIMIT 100
  `);
  const msgInboxPeek = sqlite.prepare<[string, number]>(`
    SELECT id, from_id, kind, thread_id, created_at FROM messages
     WHERE to_id = ? AND ack_at IS NULL AND created_at > ?
     ORDER BY created_at ASC LIMIT 100
  `);
  const msgCountUnacked = sqlite.prepare<[string]>(`SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND ack_at IS NULL`);
  const msgAck = sqlite.prepare<[number, string, string]>(`
    UPDATE messages SET ack_at = ? WHERE id = ? AND to_id = ? AND ack_at IS NULL
  `);
  const msgThread = sqlite.prepare<[string]>(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC`);
  const msgCleanupAcked = sqlite.prepare<[number]>(`DELETE FROM messages WHERE ack_at IS NOT NULL AND ack_at <= ?`);
  const msgCleanupStale = sqlite.prepare<[number]>(`DELETE FROM messages WHERE created_at <= ?`);
  const msgCleanupUnacked = sqlite.prepare<[number]>(`DELETE FROM messages WHERE ack_at IS NULL AND created_at <= ?`);

  return {
    events,

    // ── machines
    registerMachine({ pubkeyPem, name }) {
      const fp = fpOf(pubkeyPem);
      const existing = machGetByFp.get(fp) as Machine | undefined;
      if (existing) {
        // Same key already registered — treat as rename (idempotent register).
        // Keep whatever id was previously stored (supports legacy client-chosen ids).
        machUpdateName.run(name, existing.id);
        return machGetById.get(existing.id) as Machine;
      }
      // New key → derive id deterministically from pubkey. This removes the
      // TOFU race where a mediator-token holder could claim an arbitrary id.
      const id = idFromPubkey(pubkeyPem);
      machInsert.run(id, pubkeyPem, name, fp, Date.now());
      return machGetById.get(id) as Machine;
    },
    updateMachineName(id, name) {
      const res = machUpdateName.run(name, id);
      if (res.changes === 0) return null;
      return machGetById.get(id) as Machine;
    },
    getMachine(id) {
      return (machGetById.get(id) as Machine | undefined) ?? null;
    },
    getMachineByFingerprint(fp) {
      return (machGetByFp.get(fp) as Machine | undefined) ?? null;
    },
    touchMachine(id) {
      machTouch.run(Date.now(), id);
    },

    // ── pair requests
    createPairRequest({ fromId, toId, codeSalt, codeHash, ttlMs }) {
      const id = randomUUID();
      const now = Date.now();
      prInsert.run(id, fromId, toId, codeSalt, codeHash, now, now + ttlMs);
      return prGet.get(id) as PairRequest;
    },
    getPairRequest(id) {
      return (prGet.get(id) as PairRequest | undefined) ?? null;
    },
    listPendingPairRequestsFor(machineId) {
      return prListPendingTo.all(machineId, Date.now()) as PairRequest[];
    },
    consumePairRequest(id, codeProvided, hasher) {
      const req = prGet.get(id) as PairRequest | undefined;
      if (!req) return { ok: false, reason: 'not_found' };
      if (req.status === 'expired') return { ok: false, reason: 'expired' };
      if (req.status !== 'pending') return { ok: false, reason: 'already_consumed' };
      if (req.expires_at <= Date.now()) {
        prSetStatus.run('expired', Date.now(), id);
        return { ok: false, reason: 'expired' };
      }
      prIncAttempts.run(id);
      const expected = hasher(codeProvided, req.code_salt);
      if (expected !== req.code_hash) {
        const updated = prGet.get(id) as PairRequest;
        if (updated.attempts >= 3) {
          prSetStatus.run('exhausted', Date.now(), id);
          return { ok: false, reason: 'exhausted' };
        }
        return { ok: false, reason: 'wrong_code' };
      }
      prSetStatus.run('confirmed', Date.now(), id);
      return { ok: true, req: prGet.get(id) as PairRequest };
    },
    rejectPairRequest(id) {
      const res = prSetStatus.run('rejected', Date.now(), id);
      return res.changes > 0;
    },
    expirePairRequests(now) {
      const res = prExpire.run(now);
      return res.changes;
    },

    // ── pairings
    createPairing(a, b) {
      const [x, y] = pairKey(a, b);
      pairInsert.run(x, y, Date.now());
      return { a_id: x, b_id: y, paired_at: Date.now() };
    },
    hasPairing(a, b) {
      const [x, y] = pairKey(a, b);
      return !!pairExists.get(x, y);
    },
    listPairingsFor(machineId) {
      const rows = [
        ...(pairListA.all(machineId) as Array<{ peer_id: string; paired_at: number }>),
        ...(pairListB.all(machineId) as Array<{ peer_id: string; paired_at: number }>),
      ];
      const out: Array<{ peer: Machine; paired_at: number }> = [];
      for (const r of rows) {
        const peer = machGetById.get(r.peer_id) as Machine | undefined;
        if (peer) out.push({ peer, paired_at: r.paired_at });
      }
      return out;
    },
    removePairing(a, b) {
      const [x, y] = pairKey(a, b);
      const res = pairDelete.run(x, y);
      return res.changes > 0;
    },

    // ── messages
    send({ fromId, toId, kind, body, replyTo = null, unackedCap }) {
      const id = randomUUID();
      const now = Date.now();
      let threadId: string | null = null;
      if (replyTo) {
        const parent = msgGet.get(replyTo) as Message | undefined;
        if (!parent) throw new Error(`reply_to message not found: ${replyTo}`);
        if (parent.from_id !== toId || parent.to_id !== fromId) {
          throw new Error('reply_to does not belong to this conversation');
        }
        threadId = parent.thread_id;
      }
      if (!threadId) threadId = id;
      // Enforce the unacked cap and insert atomically so concurrent senders
      // cannot both pass the check and then both insert (H-4).
      const txn = sqlite.transaction(() => {
        if (unackedCap !== undefined) {
          const n = (msgCountUnacked.get(toId) as { n: number }).n;
          if (n >= unackedCap) throw new Error('inbox_full');
        }
        msgInsert.run(id, threadId!, fromId, toId, kind, body, replyTo, now);
      });
      txn();
      const msg = msgGet.get(id) as Message;
      events.emit(`inbox:${toId}`, msg);
      return msg;
    },
    inbox(toId, sinceCreatedAt = 0) {
      return msgInbox.all(toId, sinceCreatedAt) as Message[];
    },
    inboxPeek(toId, sinceCreatedAt = 0) {
      return msgInboxPeek.all(toId, sinceCreatedAt) as Array<
        Pick<Message, 'id' | 'from_id' | 'kind' | 'thread_id' | 'created_at'>
      >;
    },
    countUnacked(toId) {
      return (msgCountUnacked.get(toId) as { n: number }).n;
    },
    ack(id, owner) {
      return msgAck.run(Date.now(), id, owner).changes > 0;
    },
    getMessage(id) {
      return (msgGet.get(id) as Message | undefined) ?? null;
    },
    thread(threadId, requesterId) {
      const rows = msgThread.all(threadId) as Message[];
      return rows.filter((m) => m.from_id === requesterId || m.to_id === requesterId);
    },
    cleanupOlderThan(ackedOlderThanMs, allOlderThanMs, unackedOlderThanMs) {
      const now = Date.now();
      const a = msgCleanupAcked.run(now - ackedOlderThanMs).changes;
      const s = msgCleanupStale.run(now - allOlderThanMs).changes;
      const u = msgCleanupUnacked.run(now - unackedOlderThanMs).changes;
      return { acked: a, stale: s, unacked: u };
    },

    close() {
      sqlite.close();
    },
  };
}
