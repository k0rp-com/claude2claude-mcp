import { randomBytes, randomUUID } from 'node:crypto';
import { generateEd25519, signRequest } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/server.js';

const MEDIATOR = process.env.MEDIATOR_TOKEN!;

export interface TestMachine {
  id: string;
  name: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export function newTestMachine(name = 'm-' + randomBytes(3).toString('hex')): TestMachine {
  const { publicKeyPem, privateKeyPem } = generateEd25519();
  return { id: randomUUID(), name, publicKeyPem, privateKeyPem };
}

export function makeApp() {
  const db = openDb(':memory:');
  return { app: buildApp(db), db };
}

/** Wraps app.request, signing every call with the given machine identity. */
export async function authedRequest(
  app: ReturnType<typeof buildApp>,
  m: TestMachine,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const ts = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const sig = signRequest(m.privateKeyPem, {
    method, path, timestampMs: ts, nonce, body: bodyStr,
  });
  const headers: Record<string, string> = {
    'X-Machine-ID': m.id,
    'X-Timestamp': String(ts),
    'X-Nonce': nonce,
    'X-Signature': sig,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: bodyStr || undefined,
  });
}

export async function registerMachine(app: ReturnType<typeof buildApp>, m: TestMachine): Promise<Response> {
  const ts = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const bodyObj = { id: m.id, name: m.name, public_key_pem: m.publicKeyPem, ts, nonce };
  const sig = signRequest(m.privateKeyPem, {
    method: 'POST', path: '/v1/register', timestampMs: ts, nonce, body: JSON.stringify(bodyObj),
  });
  return app.request('/v1/register', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MEDIATOR}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...bodyObj, signature: sig }),
  });
}

export async function pair(app: ReturnType<typeof buildApp>, a: TestMachine, b: TestMachine): Promise<{ ok: true }> {
  const r = await authedRequest(app, a, 'POST', '/v1/pair-request', { to_id: b.id });
  if (r.status !== 201) throw new Error(`pair request failed: ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { code: string; pair_request: { id: string } };
  const c = await authedRequest(app, b, 'POST', '/v1/pair-confirm', {
    request_id: data.pair_request.id, code: data.code,
  });
  if (c.status !== 200) throw new Error(`pair confirm failed: ${c.status} ${await c.text()}`);
  return { ok: true };
}
