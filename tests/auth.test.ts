import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { authedRequest, makeApp, newTestMachine, registerMachine } from './helpers.js';
import { signRequest } from '../src/crypto.js';

describe('register', () => {
  it('happy path with valid mediator token + signed self-proof', async () => {
    const { app } = makeApp();
    const m = newTestMachine('alice');
    const r = await registerMachine(app, m);
    expect(r.status).toBe(201);
    const data = (await r.json()) as { machine: { id: string; name: string; fingerprint: string } };
    expect(data.machine.id).toBe(m.id);
    expect(data.machine.name).toBe('alice');
    expect(data.machine.fingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });

  it('rejects bad mediator token', async () => {
    const { app } = makeApp();
    const r = await app.request('/v1/register', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('rejects malformed name', async () => {
    const { app } = makeApp();
    const m = newTestMachine('has spaces');
    const r = await registerMachine(app, m);
    expect(r.status).toBe(400);
  });

  it('accepts non-Latin names (Cyrillic, CJK, accents)', async () => {
    for (const name of ['алиса', '張三', 'café']) {
      const { app } = makeApp();
      const m = newTestMachine(name);
      const r = await registerMachine(app, m);
      expect(r.status, `name=${name}`).toBe(201);
      const data = (await r.json()) as { machine: { name: string } };
      expect(data.machine.name).toBe(name);
    }
  });

  it('rejects emoji in name (not a letter)', async () => {
    const { app } = makeApp();
    const m = newTestMachine('bob😀');
    const r = await registerMachine(app, m);
    expect(r.status).toBe(400);
  });

  it('rejects when signature does not match pubkey', async () => {
    const { app } = makeApp();
    const m = newTestMachine();
    const other = newTestMachine();
    const ts = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const bodyObj = { id: m.id, name: m.name, public_key_pem: m.publicKeyPem, ts, nonce };
    // Signed with other's key but claiming m.publicKeyPem
    const sig = signRequest(other.privateKeyPem, {
      method: 'POST', path: '/v1/register', timestampMs: ts, nonce, body: JSON.stringify(bodyObj),
    });
    const r = await app.request('/v1/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.MEDIATOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bodyObj, signature: sig }),
    });
    expect(r.status).toBe(400);
  });
});

describe('signed-request middleware', () => {
  it('rejects requests without signature headers', async () => {
    const { app } = makeApp();
    const r = await app.request('/v1/me');
    expect(r.status).toBe(400);
  });

  it('rejects requests for unknown machine', async () => {
    const { app } = makeApp();
    const ghost = newTestMachine();
    const r = await authedRequest(app, ghost, 'GET', '/v1/me');
    expect(r.status).toBe(401);
    const d = (await r.json()) as { error: string };
    expect(d.error).toMatch(/unknown machine/);
  });

  it('rejects bad signature', async () => {
    const { app } = makeApp();
    const m = newTestMachine();
    await registerMachine(app, m);
    const ts = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const r = await app.request('/v1/me', {
      headers: {
        'X-Machine-ID': m.id, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        'X-Signature': Buffer.from('not-a-real-signature').toString('base64'),
      },
    });
    expect(r.status).toBe(401);
  });

  it('rejects expired timestamps', async () => {
    const { app } = makeApp();
    const m = newTestMachine();
    await registerMachine(app, m);
    const tsBad = Date.now() - 10 * 60 * 1000; // 10 min in the past
    const nonce = randomBytes(16).toString('hex');
    const sig = signRequest(m.privateKeyPem, { method: 'GET', path: '/v1/me', timestampMs: tsBad, nonce, body: '' });
    const r = await app.request('/v1/me', {
      headers: { 'X-Machine-ID': m.id, 'X-Timestamp': String(tsBad), 'X-Nonce': nonce, 'X-Signature': sig },
    });
    expect(r.status).toBe(401);
  });

  it('rejects nonce reuse', async () => {
    const { app } = makeApp();
    const m = newTestMachine();
    await registerMachine(app, m);
    const ts = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const sig = signRequest(m.privateKeyPem, { method: 'GET', path: '/v1/me', timestampMs: ts, nonce, body: '' });
    const r1 = await app.request('/v1/me', {
      headers: { 'X-Machine-ID': m.id, 'X-Timestamp': String(ts), 'X-Nonce': nonce, 'X-Signature': sig },
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/v1/me', {
      headers: { 'X-Machine-ID': m.id, 'X-Timestamp': String(ts), 'X-Nonce': nonce, 'X-Signature': sig },
    });
    expect(r2.status).toBe(401);
  });

  it('happy path /v1/me returns machine record', async () => {
    const { app } = makeApp();
    const m = newTestMachine('bob');
    await registerMachine(app, m);
    const r = await authedRequest(app, m, 'GET', '/v1/me');
    expect(r.status).toBe(200);
    const d = (await r.json()) as { machine: { id: string; name: string } };
    expect(d.machine.id).toBe(m.id);
    expect(d.machine.name).toBe('bob');
  });
});
