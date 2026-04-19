import { describe, it, expect } from 'vitest';
import { authedRequest, makeApp, newTestMachine, registerMachine, pair } from './helpers.js';

async function setupTwo() {
  const { app, db } = makeApp();
  const a = newTestMachine('alice');
  const b = newTestMachine('bob');
  await registerMachine(app, a);
  await registerMachine(app, b);
  return { app, db, a, b };
}

describe('pair-request + confirm', () => {
  it('happy path creates pairing visible from both sides', async () => {
    const { app, a, b } = await setupTwo();
    const r = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    expect(r.status).toBe(201);
    const data = (await r.json()) as { code: string; pair_request: { id: string } };
    expect(data.code).toMatch(/^\d{6}$/);

    const c = await authedRequest(app, b, 'POST', '/v1/pair-confirm', {
      request_id: data.pair_request.id, code: data.code,
    });
    expect(c.status).toBe(200);

    const aPairings = await authedRequest(app, a, 'GET', '/v1/pairings');
    const bPairings = await authedRequest(app, b, 'GET', '/v1/pairings');
    const aData = (await aPairings.json()) as { pairings: Array<{ peer: { id: string; name: string } }> };
    const bData = (await bPairings.json()) as { pairings: Array<{ peer: { id: string; name: string } }> };
    expect(aData.pairings).toHaveLength(1);
    expect(aData.pairings[0]!.peer.id).toBe(b.id);
    expect(aData.pairings[0]!.peer.name).toBe('bob');
    expect(bData.pairings[0]!.peer.id).toBe(a.id);
  });

  it('rejects wrong code without burning the request', async () => {
    const { app, a, b } = await setupTwo();
    const r = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    const data = (await r.json()) as { code: string; pair_request: { id: string } };
    const wrong = data.code === '000000' ? '111111' : '000000';
    const c = await authedRequest(app, b, 'POST', '/v1/pair-confirm', {
      request_id: data.pair_request.id, code: wrong,
    });
    expect(c.status).toBe(403);
    // Right code still works.
    const c2 = await authedRequest(app, b, 'POST', '/v1/pair-confirm', {
      request_id: data.pair_request.id, code: data.code,
    });
    expect(c2.status).toBe(200);
  });

  it('exhausts after 3 wrong attempts', async () => {
    const { app, a, b } = await setupTwo();
    const r = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    const data = (await r.json()) as { code: string; pair_request: { id: string } };
    const wrong = data.code === '999999' ? '111111' : '999999';
    for (let i = 0; i < 3; i++) {
      await authedRequest(app, b, 'POST', '/v1/pair-confirm', { request_id: data.pair_request.id, code: wrong });
    }
    // 4th attempt — even with right code — should fail.
    const c = await authedRequest(app, b, 'POST', '/v1/pair-confirm', {
      request_id: data.pair_request.id, code: data.code,
    });
    expect(c.status).toBe(400);
    const e = (await c.json()) as { error: string };
    expect(['exhausted', 'already_consumed']).toContain(e.error);
  });

  it('rejects pair-confirm by someone other than the target', async () => {
    const { app, a, b } = await setupTwo();
    const c3 = newTestMachine('carol');
    await registerMachine(app, c3);
    const r = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    const data = (await r.json()) as { code: string; pair_request: { id: string } };
    const c = await authedRequest(app, c3, 'POST', '/v1/pair-confirm', {
      request_id: data.pair_request.id, code: data.code,
    });
    expect(c.status).toBe(403);
  });

  it('expires after TTL', async () => {
    const { app, db, a, b } = await setupTwo();
    const r = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    const data = (await r.json()) as { code: string; pair_request: { id: string } };
    // Force-expire by manipulating DB directly through public helpers.
    // (Easier: just bump time via injecting expire = now via expirePairRequests + a manual UPDATE.)
    // Use a raw sqlite write through the prepared "UPDATE pair_requests SET expires_at = 0".
    // We don't expose that, but expirePairRequests uses 'expires_at <= now'; setting expires_at via
    // direct SQL isn't possible here without exposing it. Workaround: time-travel by waiting
    // is too slow. Instead: assert that calling expirePairRequests AFTER the TTL would mark expired.
    // Since vitest-set-time isn't enabled, just verify the method behaves correctly with a fake.
    db.expirePairRequests(Date.now() + 999_999_999);
    const c = await authedRequest(app, b, 'POST', '/v1/pair-confirm', {
      request_id: data.pair_request.id, code: data.code,
    });
    expect(c.status).toBe(400);
    const e = (await c.json()) as { error: string };
    expect(e.error).toBe('expired');
  });

  it('rejects pair with self', async () => {
    const { app, a } = await setupTwo();
    const r = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: a.id });
    expect(r.status).toBe(400);
  });

  it('rejects double pairing', async () => {
    const { app, a, b } = await setupTwo();
    await pair(app, a, b);
    const r = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    expect(r.status).toBe(409);
  });
});

describe('lookup by fingerprint', () => {
  it('returns machine record when found', async () => {
    const { app, a, b } = await setupTwo();
    const me = await authedRequest(app, b, 'GET', '/v1/me');
    const fp = ((await me.json()) as { machine: { fingerprint: string } }).machine.fingerprint;
    const r = await authedRequest(app, a, 'GET', `/v1/lookup?fingerprint=${fp}`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { machine: { id: string; name: string } };
    expect(d.machine.id).toBe(b.id);
    expect(d.machine.name).toBe('bob');
  });

  it('404 on unknown fingerprint', async () => {
    const { app, a } = await setupTwo();
    const r = await authedRequest(app, a, 'GET', '/v1/lookup?fingerprint=0000-0000-0000');
    expect(r.status).toBe(404);
  });
});

describe('unpair', () => {
  it('removes pairing for both directions', async () => {
    const { app, a, b } = await setupTwo();
    await pair(app, a, b);
    const r = await authedRequest(app, a, 'DELETE', `/v1/pairings/${b.id}`);
    expect(r.status).toBe(200);
    const list = await authedRequest(app, b, 'GET', '/v1/pairings');
    expect(((await list.json()) as { pairings: unknown[] }).pairings).toHaveLength(0);
  });
});
