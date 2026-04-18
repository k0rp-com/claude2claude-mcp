import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { Db, Machine, Message, PairRequest } from './db.js';
import { config } from './config.js';
import { makeLogger } from './logger.js';
import { makeLimiter } from './rateLimit.js';
import { verifyRequest, hashCode, fingerprint as fpOf, publicKeyFromPem } from './crypto.js';
import { makeNonceCache } from './replay.js';

const log = makeLogger(config.logLevel);

const MAX_BODY_LEN = 64 * 1024;
const MAX_UNACKED_PER_RECIPIENT = 500;
const MAX_NAME_LEN = 32;
const NAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FP_RE = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/i;
const NONCE_RE = /^[0-9a-f]{32}$/i;

const RATE_LIMITS = {
  send:    { capacity: 30, refillPerSec: 1 },
  inbox:   { capacity: 60, refillPerSec: 5 },
  ack:     { capacity: 60, refillPerSec: 5 },
  thread:  { capacity: 30, refillPerSec: 1 },
  pair:    { capacity: 10, refillPerSec: 0.2 }, // 12/min
  confirm: { capacity: 10, refillPerSec: 0.2 },
  meta:    { capacity: 60, refillPerSec: 5 },
};
type RateAction = keyof typeof RATE_LIMITS;

interface AppState {
  machine: Machine;
}

function serializeMachine(m: Machine) {
  return {
    id: m.id,
    name: m.name,
    fingerprint: m.fingerprint,
    pubkey: m.pubkey_pem,
    created_at: m.created_at,
    last_seen_at: m.last_seen_at,
  };
}

function serializeMsg(m: Message, fromName?: string) {
  return {
    id: m.id,
    thread_id: m.thread_id,
    from_id: m.from_id,
    from_name: fromName ?? null,
    to_id: m.to_id,
    kind: m.kind,
    body: m.body,
    reply_to: m.reply_to,
    created_at: m.created_at,
    delivered_at: m.delivered_at,
    ack_at: m.ack_at,
  };
}

function serializePairReq(p: PairRequest, peer?: Machine) {
  return {
    id: p.id,
    from_id: p.from_id,
    from_name: peer?.name ?? null,
    from_fingerprint: peer?.fingerprint ?? null,
    to_id: p.to_id,
    expires_at: p.expires_at,
    created_at: p.created_at,
    status: p.status,
    attempts: p.attempts,
  };
}

export function buildApp(db: Db) {
  const app = new Hono();
  const limiter = makeLimiter(RATE_LIMITS);
  const nonces = makeNonceCache();

  const rateLimit = (c: Context, action: RateAction) => {
    const key = (c.get('machine' as never) as Machine | undefined)?.id ?? c.req.header('x-machine-id') ?? c.req.header('x-forwarded-for') ?? 'anon';
    const r = limiter.check(key, action);
    if (!r.ok) return c.json({ error: 'rate limited', retry_after: r.retryAfterSec }, 429, { 'Retry-After': String(r.retryAfterSec) });
    return null;
  };

  app.get('/health', (c) => c.json({ ok: true }));

  // ── /v1/register: bootstrapped by mediator_token + ed25519 self-proof.
  // Body: { id, name, public_key_pem, ts, nonce, signature }
  // signature is over canonical(POST /v1/register ts nonce sha256(body-without-signature)).
  app.post('/v1/register', async (c) => {
    const tokenHdr = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(tokenHdr);
    if (!m || m[1] !== config.mediatorToken) {
      return c.json({ error: 'invalid mediator token' }, 401);
    }

    let payload: Record<string, unknown>;
    try { payload = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }

    const schema = z.object({
      id: z.string().regex(UUID_RE),
      name: z.string().regex(NAME_RE, 'name must be 1-32 chars [A-Za-z0-9._-]'),
      public_key_pem: z.string().min(80).max(4096),
      ts: z.number().int(),
      nonce: z.string().regex(NONCE_RE),
      signature: z.string().min(40).max(200),
    });
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return c.json({ error: 'invalid payload', details: parsed.error.flatten() }, 400);
    const { id, name, public_key_pem, ts, nonce, signature } = parsed.data;

    // Self-proof: signature over canonical request payload, body without signature field.
    const skew = Math.abs(Date.now() - ts);
    if (skew > config.clockSkewMs) return c.json({ error: 'timestamp skew too large' }, 400);
    if (nonces.has(nonce)) return c.json({ error: 'nonce reused' }, 400);
    const bodyForSig = JSON.stringify({ id, name, public_key_pem, ts, nonce });
    const ok = verifyRequest(public_key_pem, {
      method: 'POST', path: '/v1/register', timestampMs: ts, nonce, body: bodyForSig,
    }, signature);
    if (!ok) return c.json({ error: 'signature verification failed' }, 400);
    nonces.remember(nonce);

    // pubkey fingerprint must match what client claims (id) — we just compute it.
    const fp = fpOf(public_key_pem);

    // Reject if id taken by a different pubkey.
    const existingById = db.getMachine(id);
    if (existingById && existingById.fingerprint !== fp) {
      return c.json({ error: 'machine id is already registered with a different public key' }, 409);
    }

    try {
      const machine = db.registerMachine({ id, pubkeyPem: public_key_pem, name });
      log.info('machine.registered', { id: machine.id, fp: machine.fingerprint, name: machine.name });
      return c.json({ machine: serializeMachine(machine) }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'register failed';
      log.warn('machine.register_failed', { err: msg });
      return c.json({ error: msg }, 409);
    }
  });

  // ── Auth middleware for everything else: ed25519 signature.
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/register') return next();

    const machineId = c.req.header('x-machine-id') ?? '';
    const tsHdr = c.req.header('x-timestamp') ?? '';
    const nonce = c.req.header('x-nonce') ?? '';
    const sig = c.req.header('x-signature') ?? '';

    if (!UUID_RE.test(machineId)) return c.json({ error: 'missing/invalid X-Machine-ID' }, 400);
    if (!/^\d+$/.test(tsHdr))     return c.json({ error: 'missing/invalid X-Timestamp' }, 400);
    if (!NONCE_RE.test(nonce))    return c.json({ error: 'missing/invalid X-Nonce' }, 400);
    if (!sig)                     return c.json({ error: 'missing X-Signature' }, 400);

    const ts = Number(tsHdr);
    if (Math.abs(Date.now() - ts) > config.clockSkewMs) {
      return c.json({ error: 'timestamp skew too large' }, 401);
    }
    if (nonces.has(nonce)) return c.json({ error: 'nonce reused' }, 401);

    const machine = db.getMachine(machineId);
    if (!machine) return c.json({ error: 'unknown machine — call /v1/register first' }, 401);

    // Read body to use in signature canonicalization.
    const rawBody = await c.req.text();
    const ok = verifyRequest(machine.pubkey_pem, {
      method: c.req.method,
      path: new URL(c.req.url).pathname + (new URL(c.req.url).search || ''),
      timestampMs: ts,
      nonce,
      body: rawBody,
    }, sig);
    if (!ok) return c.json({ error: 'signature verification failed' }, 401);
    nonces.remember(nonce);

    // Re-attach the buffered body for handlers that re-read it.
    if (rawBody) {
      const newReq = new Request(c.req.raw.url, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: rawBody,
      });
      c.req.raw = newReq as unknown as typeof c.req.raw;
    }

    db.touchMachine(machine.id);
    c.set('machine' as never, machine as never);
    await next();
  });

  function me(c: Context): Machine {
    return c.get('machine' as never) as Machine;
  }

  // ── /v1/me: who am I (echo machine record)
  app.get('/v1/me', (c) => {
    const limited = rateLimit(c, 'meta'); if (limited) return limited;
    return c.json({ machine: serializeMachine(me(c)) });
  });

  // ── /v1/me/name: change my display name
  app.post('/v1/me/name', async (c) => {
    const limited = rateLimit(c, 'meta'); if (limited) return limited;
    let payload: Record<string, unknown>;
    try { payload = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    const parsed = z.object({ name: z.string().regex(NAME_RE) }).safeParse(payload);
    if (!parsed.success) return c.json({ error: 'invalid name' }, 400);
    const updated = db.updateMachineName(me(c).id, parsed.data.name);
    if (!updated) return c.json({ error: 'machine not found' }, 404);
    log.info('machine.renamed', { id: updated.id, name: updated.name });
    return c.json({ machine: serializeMachine(updated) });
  });

  // ── /v1/lookup?fingerprint= : look up another machine by fingerprint (returns id+pubkey+name).
  // Used by the initiator to resolve a fp → uuid before /v1/pair-request.
  app.get('/v1/lookup', (c) => {
    const limited = rateLimit(c, 'meta'); if (limited) return limited;
    const fp = (c.req.query('fingerprint') ?? '').trim().toLowerCase();
    if (!FP_RE.test(fp)) return c.json({ error: 'invalid fingerprint' }, 400);
    const m = db.getMachineByFingerprint(fp);
    if (!m) return c.json({ error: 'machine not found' }, 404);
    return c.json({ machine: serializeMachine(m) });
  });

  // ── /v1/pair-request: initiator creates pending request. Returns code (4 digits).
  // We generate the code SERVER-SIDE so client doesn't need to be a good RNG.
  // Code is shown to initiator's user, who reads it to receiver's user out-of-band.
  app.post('/v1/pair-request', async (c) => {
    const limited = rateLimit(c, 'pair'); if (limited) return limited;
    let payload: Record<string, unknown>;
    try { payload = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    const parsed = z.object({ to_id: z.string().regex(UUID_RE) }).safeParse(payload);
    if (!parsed.success) return c.json({ error: 'invalid payload' }, 400);
    if (parsed.data.to_id === me(c).id) return c.json({ error: 'cannot pair with self' }, 400);

    const target = db.getMachine(parsed.data.to_id);
    if (!target) return c.json({ error: 'target machine not registered' }, 404);
    if (db.hasPairing(me(c).id, target.id)) return c.json({ error: 'already paired' }, 409);

    const code = String(100000 + Math.floor(Math.random() * 900000)).slice(0, 4); // 4 digits
    const codeSalt = randomBytes(16).toString('hex');
    const codeHashed = hashCode(code, codeSalt);

    const req = db.createPairRequest({
      fromId: me(c).id, toId: target.id, codeSalt, codeHash: codeHashed, ttlMs: config.pairRequestTtlMs,
    });

    // Notify target via the inbox event channel so a long-poll can wake.
    db.events.emit(`pair:${target.id}`, req);

    log.info('pair_request.created', { id: req.id, from: me(c).id, to: target.id });
    return c.json({
      pair_request: { id: req.id, expires_at: req.expires_at },
      code, // only ever shown to initiator
    }, 201);
  });

  // ── /v1/pair-requests: list pending incoming for me.
  app.get('/v1/pair-requests', (c) => {
    const limited = rateLimit(c, 'meta'); if (limited) return limited;
    db.expirePairRequests(Date.now());
    const list = db.listPendingPairRequestsFor(me(c).id);
    return c.json({
      pair_requests: list.map((r) => serializePairReq(r, db.getMachine(r.from_id) ?? undefined)),
    });
  });

  // ── /v1/pair-confirm: target enters the code. On success, pairing created.
  app.post('/v1/pair-confirm', async (c) => {
    const limited = rateLimit(c, 'confirm'); if (limited) return limited;
    let payload: Record<string, unknown>;
    try { payload = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    const parsed = z.object({
      request_id: z.string().regex(UUID_RE),
      code: z.string().regex(/^\d{4}$/),
    }).safeParse(payload);
    if (!parsed.success) return c.json({ error: 'invalid payload' }, 400);

    const req = db.getPairRequest(parsed.data.request_id);
    if (!req) return c.json({ error: 'pair request not found' }, 404);
    if (req.to_id !== me(c).id) return c.json({ error: 'this pair request is not for you' }, 403);

    const result = db.consumePairRequest(parsed.data.request_id, parsed.data.code, hashCode);
    if (!result.ok) {
      log.warn('pair_confirm.failed', { reason: result.reason, req: req.id });
      return c.json({ error: result.reason }, result.reason === 'wrong_code' ? 403 : 400);
    }
    db.createPairing(result.req.from_id, result.req.to_id);
    const peer = db.getMachine(result.req.from_id)!;
    log.info('pairing.created', { a: result.req.from_id, b: result.req.to_id });
    return c.json({ pairing: { peer: serializeMachine(peer), paired_at: Date.now() } });
  });

  // ── /v1/pairings: list all my pairings.
  app.get('/v1/pairings', (c) => {
    const limited = rateLimit(c, 'meta'); if (limited) return limited;
    const list = db.listPairingsFor(me(c).id);
    return c.json({
      pairings: list.map((p) => ({ peer: serializeMachine(p.peer), paired_at: p.paired_at })),
    });
  });

  // ── /v1/pairings/:peer_id: unpair.
  app.delete('/v1/pairings/:peer_id', (c) => {
    const limited = rateLimit(c, 'meta'); if (limited) return limited;
    const peerId = c.req.param('peer_id');
    if (!UUID_RE.test(peerId)) return c.json({ error: 'invalid peer id' }, 400);
    const ok = db.removePairing(me(c).id, peerId);
    if (!ok) return c.json({ error: 'no such pairing' }, 404);
    log.info('pairing.removed', { a: me(c).id, b: peerId });
    return c.json({ ok: true });
  });

  // ── /v1/messages: send to a paired peer.
  app.post('/v1/messages', async (c) => {
    const limited = rateLimit(c, 'send'); if (limited) return limited;
    let payload: Record<string, unknown>;
    try { payload = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    const parsed = z.object({
      to_id: z.string().regex(UUID_RE),
      kind: z.enum(['request', 'notice']).default('request'),
      body: z.string().min(1).max(MAX_BODY_LEN),
      reply_to: z.string().regex(UUID_RE).optional().nullable(),
    }).safeParse(payload);
    if (!parsed.success) return c.json({ error: 'invalid payload', details: parsed.error.flatten() }, 400);
    const data = parsed.data;
    if (data.to_id === me(c).id) return c.json({ error: 'cannot send to self' }, 400);
    if (!db.hasPairing(me(c).id, data.to_id)) return c.json({ error: 'not paired with target' }, 403);
    if (db.countUnacked(data.to_id) >= MAX_UNACKED_PER_RECIPIENT) {
      return c.json({ error: 'recipient inbox full' }, 429);
    }
    try {
      const msg = db.send({ fromId: me(c).id, toId: data.to_id, kind: data.kind, body: data.body, replyTo: data.reply_to ?? null });
      log.info('message.sent', { id: msg.id, from: me(c).id, to: data.to_id, body_len: data.body.length });
      return c.json({ message: serializeMsg(msg, me(c).name) }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'send failed';
      if (msg.includes('reply_to')) return c.json({ error: msg }, 400);
      log.error('message.send_failed', { err: msg });
      return c.json({ error: 'send failed' }, 500);
    }
  });

  // ── /v1/reply: reply to a specific message in the conversation.
  app.post('/v1/reply', async (c) => {
    const limited = rateLimit(c, 'send'); if (limited) return limited;
    let payload: Record<string, unknown>;
    try { payload = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    const parsed = z.object({
      reply_to: z.string().regex(UUID_RE),
      body: z.string().min(1).max(MAX_BODY_LEN),
    }).safeParse(payload);
    if (!parsed.success) return c.json({ error: 'invalid payload' }, 400);
    const parent = db.getMessage(parsed.data.reply_to);
    if (!parent) return c.json({ error: 'reply_to not found' }, 404);
    if (parent.to_id !== me(c).id) return c.json({ error: 'reply_to not addressed to you' }, 400);
    if (!db.hasPairing(me(c).id, parent.from_id)) return c.json({ error: 'no longer paired' }, 403);
    if (db.countUnacked(parent.from_id) >= MAX_UNACKED_PER_RECIPIENT) return c.json({ error: 'recipient inbox full' }, 429);
    try {
      const msg = db.send({ fromId: me(c).id, toId: parent.from_id, kind: 'reply', body: parsed.data.body, replyTo: parsed.data.reply_to });
      return c.json({ message: serializeMsg(msg, me(c).name) }, 201);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'reply failed';
      return c.json({ error: m }, 400);
    }
  });

  // ── /v1/inbox: messages + (when peek) pending pair requests for notification.
  app.get('/v1/inbox', async (c) => {
    const limited = rateLimit(c, 'inbox'); if (limited) return limited;
    const meId = me(c).id;
    const sinceRaw = c.req.query('since');
    const waitRaw = c.req.query('wait');
    const peek = c.req.query('peek') === '1' || c.req.query('peek') === 'true';
    const since = sinceRaw ? Math.max(0, Number(sinceRaw)) : 0;
    const waitSec = Math.min(config.maxLongPollSeconds, Math.max(0, waitRaw ? Number(waitRaw) : 0));
    db.expirePairRequests(Date.now());

    const fetchPeek = () => ({
      peek: true,
      messages: db.inboxPeek(meId, since).map((m) => ({
        id: m.id,
        from_id: m.from_id,
        from_name: db.getMachine(m.from_id)?.name ?? null,
        kind: m.kind,
        thread_id: m.thread_id,
        created_at: m.created_at,
      })),
      pair_requests: db.listPendingPairRequestsFor(meId).map((r) => serializePairReq(r, db.getMachine(r.from_id) ?? undefined)),
    });

    const fetchFull = () => ({
      messages: db.inbox(meId, since).map((m) => serializeMsg(m, db.getMachine(m.from_id)?.name)),
      pair_requests: db.listPendingPairRequestsFor(meId).map((r) => serializePairReq(r, db.getMachine(r.from_id) ?? undefined)),
    });

    const fetcher = peek ? fetchPeek : fetchFull;

    let result = fetcher();
    const isEmpty = (r: ReturnType<typeof fetcher>) =>
      r.messages.length === 0 && r.pair_requests.length === 0;

    if (isEmpty(result) && waitSec > 0) {
      result = await new Promise((resolve) => {
        let done = false;
        const msgChan = `inbox:${meId}`;
        const prChan = `pair:${meId}`;
        const wake = () => {
          if (done) return; done = true;
          db.events.off(msgChan, wake); db.events.off(prChan, wake);
          clearTimeout(timer);
          resolve(fetcher());
        };
        const timer = setTimeout(() => {
          if (done) return; done = true;
          db.events.off(msgChan, wake); db.events.off(prChan, wake);
          resolve(fetcher());
        }, waitSec * 1000);
        db.events.on(msgChan, wake); db.events.on(prChan, wake);
        c.req.raw.signal?.addEventListener('abort', () => {
          if (done) return; done = true;
          db.events.off(msgChan, wake); db.events.off(prChan, wake); clearTimeout(timer);
          resolve(peek ? { peek: true, messages: [], pair_requests: [] } : { messages: [], pair_requests: [] });
        }, { once: true });
      });
    }

    return c.json(result);
  });

  // ── /v1/ack
  app.post('/v1/ack', async (c) => {
    const limited = rateLimit(c, 'ack'); if (limited) return limited;
    let payload: Record<string, unknown>;
    try { payload = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    const parsed = z.object({ ids: z.array(z.string().regex(UUID_RE)).min(1).max(100) }).safeParse(payload);
    if (!parsed.success) return c.json({ error: 'invalid payload' }, 400);
    const acked: string[] = [];
    for (const id of parsed.data.ids) if (db.ack(id, me(c).id)) acked.push(id);
    return c.json({ acked });
  });

  // ── /v1/thread/:id
  app.get('/v1/thread/:id', (c) => {
    const limited = rateLimit(c, 'thread'); if (limited) return limited;
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid thread id' }, 400);
    const msgs = db.thread(id, me(c).id);
    if (msgs.length === 0) return c.json({ error: 'thread not found' }, 404);
    return c.json({ thread_id: id, messages: msgs.map((m) => serializeMsg(m, db.getMachine(m.from_id)?.name)) });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    log.error('http.error', { err: err.message });
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
