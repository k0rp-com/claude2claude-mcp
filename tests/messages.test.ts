import { describe, it, expect } from 'vitest';
import { authedRequest, makeApp, newTestMachine, registerMachine, pair } from './helpers.js';

async function setupPaired() {
  const { app, db } = makeApp();
  const a = newTestMachine('alice');
  const b = newTestMachine('bob');
  await registerMachine(app, a);
  await registerMachine(app, b);
  await pair(app, a, b);
  return { app, db, a, b };
}

describe('messages — gated by pairing', () => {
  it('paired peers can send and receive', async () => {
    const { app, a, b } = await setupPaired();
    const send = await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body: 'hi' });
    expect(send.status).toBe(201);
    const inbox = await authedRequest(app, b, 'GET', '/v1/inbox');
    const data = (await inbox.json()) as { messages: Array<{ from_id: string; from_name: string; body: string }> };
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]!.from_id).toBe(a.id);
    expect(data.messages[0]!.from_name).toBe('alice');
    expect(data.messages[0]!.body).toBe('hi');
  });

  it('refuses send to unpaired target', async () => {
    const { app } = makeApp();
    const a = newTestMachine();
    const b = newTestMachine();
    await registerMachine(app, a);
    await registerMachine(app, b);
    const r = await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body: 'hi' });
    expect(r.status).toBe(403);
  });

  it('refuses send to self', async () => {
    const { app, a } = await setupPaired();
    const r = await authedRequest(app, a, 'POST', '/v1/messages', { to_id: a.id, body: 'hi' });
    expect(r.status).toBe(400);
  });

  it('reply lands in original sender inbox under same thread', async () => {
    const { app, a, b } = await setupPaired();
    const r1 = await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body: 'q?' });
    const m1 = ((await r1.json()) as { message: { id: string; thread_id: string } }).message;
    const r2 = await authedRequest(app, b, 'POST', '/v1/reply', { reply_to: m1.id, body: 'a!' });
    expect(r2.status).toBe(201);
    const m2 = ((await r2.json()) as { message: { thread_id: string; to_id: string } }).message;
    expect(m2.thread_id).toBe(m1.thread_id);
    expect(m2.to_id).toBe(a.id);
  });
});

describe('inbox peek', () => {
  it('returns metadata only, no body', async () => {
    const { app, a, b } = await setupPaired();
    await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body: 'secret-body' });
    const r = await authedRequest(app, b, 'GET', '/v1/inbox?peek=1');
    expect(r.status).toBe(200);
    const data = (await r.json()) as { peek: boolean; messages: Array<Record<string, unknown>> };
    expect(data.peek).toBe(true);
    expect(data.messages[0]).not.toHaveProperty('body');
  });

  it('peek surfaces pending pair requests too', async () => {
    const { app } = makeApp();
    const a = newTestMachine('alice');
    const b = newTestMachine('bob');
    await registerMachine(app, a);
    await registerMachine(app, b);
    await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    const r = await authedRequest(app, b, 'GET', '/v1/inbox?peek=1');
    const data = (await r.json()) as { messages: unknown[]; pair_requests: Array<{ from_name: string }> };
    expect(data.pair_requests).toHaveLength(1);
    expect(data.pair_requests[0]!.from_name).toBe('alice');
  });
});

describe('ack', () => {
  it('acked message no longer in inbox', async () => {
    const { app, a, b } = await setupPaired();
    const r1 = await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body: 'hi' });
    const id = ((await r1.json()) as { message: { id: string } }).message.id;
    const r2 = await authedRequest(app, b, 'POST', '/v1/ack', { ids: [id] });
    expect(((await r2.json()) as { acked: string[] }).acked).toEqual([id]);
    const r3 = await authedRequest(app, b, 'GET', '/v1/inbox');
    expect(((await r3.json()) as { messages: unknown[] }).messages).toHaveLength(0);
  });
});

describe('long-poll inbox wakes on send and on pair-request', () => {
  it('wakes on incoming message', async () => {
    const { app, a, b } = await setupPaired();
    const start = Date.now();
    const poll = authedRequest(app, b, 'GET', '/v1/inbox?wait=4');
    await new Promise((r) => setTimeout(r, 50));
    await authedRequest(app, a, 'POST', '/v1/messages', { to_id: b.id, body: 'wakey' });
    const r = await poll;
    expect(Date.now() - start).toBeLessThan(2000);
    const data = (await r.json()) as { messages: Array<{ body: string }> };
    expect(data.messages[0]!.body).toBe('wakey');
  });

  it('wakes on incoming pair request', async () => {
    const { app } = makeApp();
    const a = newTestMachine('alice');
    const b = newTestMachine('bob');
    await registerMachine(app, a);
    await registerMachine(app, b);
    const start = Date.now();
    const poll = authedRequest(app, b, 'GET', '/v1/inbox?peek=1&wait=4');
    await new Promise((r) => setTimeout(r, 50));
    await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
    const r = await poll;
    expect(Date.now() - start).toBeLessThan(2000);
    const data = (await r.json()) as { pair_requests: unknown[] };
    expect(data.pair_requests.length).toBeGreaterThan(0);
  });
});
