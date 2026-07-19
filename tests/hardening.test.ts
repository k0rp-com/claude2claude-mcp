import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { generateEd25519, idFromPubkey, samePublicKey, signRequest } from '../src/crypto.js';
import { authedRequest, makeApp, newTestMachine, registerMachine, pair } from './helpers.js';
import { MAX_BODY_LEN } from '../src/server.js';

describe('crypto.samePublicKey (M3)', () => {
  it('true for the same key (whitespace-insensitive), false for different keys', () => {
    const a = generateEd25519();
    const b = generateEd25519();
    expect(samePublicKey(a.publicKeyPem, a.publicKeyPem)).toBe(true);
    // Trailing-whitespace variation must still compare equal (DER-based).
    expect(samePublicKey(a.publicKeyPem, a.publicKeyPem.trimEnd() + '\n\n')).toBe(true);
    expect(samePublicKey(a.publicKeyPem, b.publicKeyPem)).toBe(false);
  });
});

describe('db.registerMachine — idempotent re-register (M3 regression)', () => {
  it('same key re-registers as a rename, keeping the id', () => {
    const db = openDb(':memory:');
    const { publicKeyPem } = generateEd25519();
    const first = db.registerMachine({ pubkeyPem: publicKeyPem, name: 'first' });
    const second = db.registerMachine({ pubkeyPem: publicKeyPem, name: 'second' });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('second');
    db.close();
  });
});

describe('db.deleteMachine — complete revocation cascade (L5)', () => {
  it('removes the machine, its pairings, and its messages', async () => {
    const { app, db } = makeApp();
    const a = newTestMachine('alice');
    const b = newTestMachine('bob');
    await registerMachine(app, a);
    await registerMachine(app, b);
    await pair(app, a, b);
    await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body: 'hi' });

    const res = db.deleteMachine(a.id);
    expect(res.deleted).toBe(true);
    expect(res.pairings).toBe(1);
    expect(res.messages).toBe(1);
    expect(db.getMachine(a.id)).toBeNull();
    // b keeps no dangling pairing to the deleted machine.
    const list = await authedRequest(app, b, 'GET', '/v1/pairings');
    expect(((await list.json()) as { pairings: unknown[] }).pairings).toHaveLength(0);
  });

  it('returns deleted:false for an unknown id', () => {
    const db = openDb(':memory:');
    expect(db.deleteMachine(idFromPubkey(generateEd25519().publicKeyPem)).deleted).toBe(false);
    db.close();
  });

  it('drops pending pair_requests so no orphan pairing can be confirmed after revocation', async () => {
    const { app, db } = makeApp();
    const a = newTestMachine('alice');
    const b = newTestMachine('bob');
    await registerMachine(app, a);
    await registerMachine(app, b);
    const pr = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    const { code, pair_request } = (await pr.json()) as { code: string; pair_request: { id: string } };

    db.deleteMachine(a.id); // revoke the initiator while its request is pending

    const c = await authedRequest(app, b, 'POST', '/v1/pair-confirm', { request_id: pair_request.id, code });
    expect(c.status).toBe(404); // request was cascaded away — cannot be confirmed
    const list = await authedRequest(app, b, 'GET', '/v1/pairings');
    expect(((await list.json()) as { pairings: unknown[] }).pairings).toHaveLength(0);
  });
});

describe('replay protection under concurrency (M1)', () => {
  it('two identical signed requests fired together — exactly one succeeds', async () => {
    const { app } = makeApp();
    const m = newTestMachine('racer');
    await registerMachine(app, m);
    const ts = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const sig = signRequest(m.privateKeyPem, { method: 'GET', path: '/v1/me', timestampMs: ts, nonce, body: '' });
    const headers = { 'X-Machine-ID': m.id, 'X-Timestamp': String(ts), 'X-Nonce': nonce, 'X-Signature': sig };
    const [r1, r2] = await Promise.all([
      app.request('/v1/me', { headers }),
      app.request('/v1/me', { headers }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 401]);
  });
});

describe('register rate limit (M2)', () => {
  it('flood is capped and NOT bypassable by rotating X-Machine-ID', async () => {
    const { app } = makeApp();
    let saw429 = false;
    // Rotate a distinct X-Machine-ID per request. The register limiter must key
    // on the (absent → 'anon') forwarded address only, so these all share one
    // bucket and the flood trips 429 — a naive key would give each its own bucket
    // and never limit. Bad token → 401 while rate-allowed (limiter runs first).
    for (let i = 0; i < 45; i++) {
      const r = await app.request('/v1/register', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json', 'X-Machine-ID': `spoof-${i}` },
        body: '{}',
      });
      if (r.status === 429) { saw429 = true; break; }
      expect(r.status).toBe(401);
    }
    expect(saw429).toBe(true);
  });

  it('distinct forwarded IPs get independent buckets (no false cross-IP limiting)', async () => {
    const { app } = makeApp();
    // Each request from a different X-Forwarded-For is its own bucket, so a
    // legit multi-host onboarding is never throttled by another host's traffic.
    for (let i = 0; i < 40; i++) {
      const r = await app.request('/v1/register', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}` },
        body: '{}',
      });
      expect(r.status).toBe(401); // never 429 — distinct IP each time
    }
  });
});

describe('inbox robustness to malformed query params (L4)', () => {
  it('non-numeric since/wait do not 500', async () => {
    const { app } = makeApp();
    const m = newTestMachine('q');
    await registerMachine(app, m);
    const r = await authedRequest(app, m, 'GET', '/v1/inbox?since=abc&wait=xyz');
    expect(r.status).toBe(200);
    const d = (await r.json()) as { messages: unknown[] };
    expect(Array.isArray(d.messages)).toBe(true);
  });
});

describe('body size cap (L2)', () => {
  it('rejects an oversized message body with 413', async () => {
    const { app } = makeApp();
    const a = newTestMachine('a');
    const b = newTestMachine('b');
    await registerMachine(app, a);
    await registerMachine(app, b);
    await pair(app, a, b);
    const huge = 'x'.repeat(MAX_BODY_LEN + 1024);
    const r = await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body: huge });
    expect(r.status).toBe(413);
  });

  it('accepts a near-limit body (no off-by-one over-rejection)', async () => {
    const { app } = makeApp();
    const a = newTestMachine('a');
    const b = newTestMachine('b');
    await registerMachine(app, a);
    await registerMachine(app, b);
    await pair(app, a, b);
    // Leave room for the JSON envelope so total raw bytes stay under the cap.
    const body = 'y'.repeat(MAX_BODY_LEN - 512);
    const r = await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body });
    expect(r.status).toBe(201);
  });
});
