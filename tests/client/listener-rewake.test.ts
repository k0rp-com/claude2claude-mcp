import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The peer-listener runs as an `asyncRewake` hook, not inside a Monitor. Monitor is
// capped at 30 minutes, and every re-arm was a visible tool call plus a model turn
// in the chat. An asyncRewake hook runs in the background and wakes the model ONLY
// when it exits with code 2; exit 0 or a timeout kill leave no trace in the chat.
// So listen.sh must: say nothing until mail arrives, then print it, ack it, exit 2.

const LISTEN = require.resolve('../../client-plugin/scripts/listen.sh');
const STOP_HOOK = require.resolve('../../client-plugin/scripts/stop-hook.sh');
const SESSION_START = require.resolve('../../client-plugin/scripts/session-start.sh');
const COMMON = path.resolve(__dirname, '../../client-plugin/scripts/common.sh');
const HOOKS_JSON = path.resolve(__dirname, '../../client-plugin/hooks/hooks.json');
const PEER_LISTEN_MD = path.resolve(__dirname, '../../client-plugin/commands/peer-listen.md');
const cleanup: string[] = [];

function mkTmp(prefix = 'c2c-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function registered() {
  const home = mkTmp('home-');
  const c2cDir = path.join(home, 'c2c');
  mkdirSync(c2cDir, { recursive: true });
  writeFileSync(
    path.join(c2cDir, 'identity.json'),
    JSON.stringify({ id: 'testmachine', created_at: '2026-01-01T00:00:00Z' }),
  );
  writeFileSync(path.join(c2cDir, 'name.txt'), 'probe\n');
  return { home, c2cDir, pidFile: path.join(c2cDir, 'listener.pid') };
}

type Inbox = { messages: unknown[]; pair_requests: unknown[] };

/** Fake mediator: serves queued inbox responses (then empty ones) and records acks. */
async function fakeMediator(queue: Inbox[]) {
  const acks: unknown[] = [];
  let inboxCalls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v1/inbox')) {
        inboxCalls++;
        const next = queue.shift();
        if (next) return res.end(JSON.stringify(next));
        // Empty long-poll: answer slowly so the listener doesn't spin.
        setTimeout(() => res.end(JSON.stringify({ messages: [], pair_requests: [] })), 300);
        return;
      }
      if (req.url === '/v1/ack') {
        acks.push(JSON.parse(body || '{}'));
        return res.end('{"ok":true}');
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    acks,
    inboxCalls: () => inboxCalls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Run a script with a deadline; resolve with exit code (null if we killed it). */
function run(
  script: string,
  env: Record<string, string>,
  deadlineMs: number,
  payload = '{}',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('bash', [script], { env: { PATH: process.env.PATH ?? '', ...env } }, (err, stdout, stderr) => {
      clearTimeout(t);
      const code = killed ? null : err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === 'number' ? code : null, stdout, stderr });
    });
    // Hooks get their JSON payload on stdin and the harness closes it; mirror that.
    child.stdin?.end(`${payload}\n`);
    let killed = false;
    const t = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, deadlineMs);
  });
}

const MSG = {
  id: 'msg-1',
  from_id: 'peer-id',
  from_name: 'alice',
  kind: 'message',
  thread_id: 'th-1',
  reply_to: null,
  body: 'hello from alice',
};
const PAIR = {
  id: 'pr-1',
  from_name: 'bob',
  from_fingerprint: 'abcd-ef01-2345',
  expires_at: '2026-12-01T00:00:00Z',
};

describe('rewake listener: delivery', () => {
  it('wakes the model with exit 2, framed mail on stdout, nothing on stderr, and acks', async () => {
    const s = registered();
    const m = await fakeMediator([{ messages: [MSG], pair_requests: [] }]);
    try {
      const r = await run(
        LISTEN,
        { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: m.url, C2C_PRINT_MODE: '0', C2C_WINDOW_ID: '4242' },
        10000,
      );
      expect(r.code).toBe(2);
      // The harness feeds stderr to the model INSTEAD of stdout when stderr is non-empty.
      expect(r.stderr).toBe('');
      expect(r.stdout).toMatch(/SECURITY FRAMING/);
      expect(r.stdout).toMatch(/id=msg-1 from=alice/);
      expect(m.acks).toEqual([{ ids: ['msg-1'] }]);
      expect(existsSync(s.pidFile)).toBe(false);
    } finally {
      await m.close();
    }
  }, 15000);

  it('wakes once per pair request: the same request is not re-delivered on the next arm', async () => {
    const s = registered();
    const m = await fakeMediator([
      { messages: [], pair_requests: [PAIR] },
      { messages: [], pair_requests: [PAIR] },
    ]);
    const env = { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: m.url, C2C_PRINT_MODE: '0', C2C_WINDOW_ID: '4242' };
    try {
      const first = await run(LISTEN, env, 10000);
      expect(first.code).toBe(2);
      expect(first.stdout).toMatch(/pair request — from=bob fp=abcd-ef01-2345/);
      const second = await run(LISTEN, env, 2000);
      expect(second.code).toBeNull(); // still polling — nothing new to wake for
      expect(second.stdout).toBe('');
    } finally {
      await m.close();
    }
  }, 20000);
});

describe('rewake listener: silence', () => {
  it('prints nothing at all while there is no mail', async () => {
    const s = registered();
    const r = await run(
      LISTEN,
      { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: 'http://127.0.0.1:9', C2C_PRINT_MODE: '0', C2C_WINDOW_ID: '4242' },
      1500,
    );
    expect(r.code).toBeNull();
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('exits 0 silently when this window already has a live listener', () => {
    const s = registered();
    const fake = path.join(s.c2cDir, 'listen.sh');
    writeFileSync(fake, '#!/usr/bin/env bash\nsleep 60\n');
    const out = execFileSync(
      'bash',
      [
        '-c',
        `bash "${fake}" >/dev/null 2>&1 &
         pid=$!
         printf '%s s1 4242\\n' "$pid" > "${s.pidFile}"
         "${LISTEN}" >"${s.c2cDir}/o" 2>&1; echo "exit=$?"
         kill -0 "$pid" 2>/dev/null && echo ALIVE
         kill -9 "$pid" 2>/dev/null || true`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: s.home,
          C2C_DIR: s.c2cDir,
          C2C_URL: 'http://127.0.0.1:9',
          C2C_PRINT_MODE: '0',
          C2C_WINDOW_ID: '4242',
        },
        encoding: 'utf8',
      },
    ).trim();
    expect(out).toBe('exit=0\nALIVE');
    expect(readFileSync(path.join(s.c2cDir, 'o'), 'utf8')).toBe('');
  });

  it('exits 0 at once in a -p session, where the hook would run synchronously and hang it', async () => {
    const s = registered();
    const r = await run(
      LISTEN,
      { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: 'http://127.0.0.1:9', C2C_PRINT_MODE: '1' },
      3000,
    );
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(existsSync(s.pidFile)).toBe(false);
  });
});

describe('session-mode detection from the claude command line', () => {
  function mode(args: string): string {
    return execFileSync(
      'bash',
      ['-c', `source "${COMMON}" >/dev/null 2>&1; c2c::_claude_argv_mode "$ARGS"`],
      { env: { PATH: process.env.PATH ?? '', HOME: mkTmp('home-'), ARGS: args }, encoding: 'utf8' },
    ).trim();
  }

  it('interactive claude is live', () => {
    expect(mode('claude --dangerously-skip-permissions')).toBe('live');
    expect(mode('claude --model opus --dangerously-skip-permissions')).toBe('live');
    expect(mode('claude --resume 0b7c3f1e-2a4d-4e5f-9a8b-1c2d3e4f5a6b')).toBe('live');
    expect(mode('claude --output-format text')).toBe('live');
  });
  it('claude -p / --print without streaming input is print', () => {
    expect(mode('claude -p hello')).toBe('print');
    expect(mode('/usr/bin/node /x/claude-code/cli.js --print hi')).toBe('print');
    expect(mode('claude -p --output-format stream-json --verbose hi')).toBe('print');
  });
  // CLI 2.1.292: a Stop asyncRewake hook runs in the background and rewakes a
  // stream-json session; only a SessionStart one blocks system/init.
  it('streaming input is stream, with or without -p (conveyor chat, SDK)', () => {
    expect(
      mode(
        'claude --output-format stream-json --input-format stream-json --verbose --dangerously-skip-permissions --disallowedTools EnterPlanMode ExitPlanMode AskUserQuestion --model claude-opus-5-5[1m] --effort medium',
      ),
    ).toBe('stream');
    expect(mode('claude --output-format=stream-json --input-format=stream-json')).toBe('stream');
    expect(mode('claude -p --input-format stream-json --output-format stream-json')).toBe('stream');
    expect(mode('claude --print --input-format=stream-json')).toBe('stream');
  });
});

describe('rewake listener in a stream-json session', () => {
  it('bows out on SessionStart, which would block system/init', async () => {
    const s = registered();
    const r = await run(
      LISTEN,
      { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: 'http://127.0.0.1:9', C2C_SESSION_MODE: 'stream', C2C_WINDOW_ID: '4242' },
      3000,
      '{"session_id":"x","hook_event_name": "SessionStart","source":"startup"}',
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(s.pidFile)).toBe(false);
  });

  it('arms on Stop and wakes the session with the mail', async () => {
    const s = registered();
    const m = await fakeMediator([{ messages: [MSG], pair_requests: [] }]);
    try {
      const r = await run(
        LISTEN,
        { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: m.url, C2C_SESSION_MODE: 'stream', C2C_WINDOW_ID: '4242' },
        10000,
        '{"session_id":"x","hook_event_name":"Stop"}',
      );
      expect(r.code).toBe(2);
      expect(r.stdout).toMatch(/id=msg-1 from=alice/);
      expect(m.acks).toEqual([{ ids: ['msg-1'] }]);
    } finally {
      await m.close();
    }
  }, 15000);

  it('the Stop backstop leaves the inbox to the listener', async () => {
    const s = registered();
    const m = await fakeMediator([{ messages: [MSG], pair_requests: [] }]);
    try {
      const r = await run(STOP_HOOK, { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: m.url, C2C_SESSION_MODE: 'stream' }, 5000);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(m.inboxCalls()).toBe(0);
    } finally {
      await m.close();
    }
  });
});

describe('Stop backstop only drains in -p sessions', () => {
  it('outside print mode it never touches the inbox (the rewake listener owns it)', async () => {
    const s = registered();
    const m = await fakeMediator([{ messages: [MSG], pair_requests: [] }]);
    try {
      const r = await run(
        STOP_HOOK,
        { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: m.url, C2C_PRINT_MODE: '0' },
        5000,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(m.inboxCalls()).toBe(0);
    } finally {
      await m.close();
    }
  });

  it('in print mode it still delivers via a block decision', async () => {
    const s = registered();
    const m = await fakeMediator([{ messages: [MSG], pair_requests: [] }]);
    try {
      const r = await run(
        STOP_HOOK,
        { HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: m.url, C2C_PRINT_MODE: '1' },
        8000,
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).decision).toBe('block');
      expect(m.acks).toEqual([{ ids: ['msg-1'] }]);
    } finally {
      await m.close();
    }
  }, 10000);
});

describe('wiring', () => {
  const hooks = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')).hooks;

  for (const event of ['SessionStart', 'Stop']) {
    it(`${event} arms listen.sh as an asyncRewake hook with a timeout well past Monitor's 30 min`, () => {
      const entries = hooks[event].flatMap((g: { hooks: unknown[] }) => g.hooks) as Array<{
        command: string;
        asyncRewake?: boolean;
        timeout?: number;
        rewakeSummary?: string;
      }>;
      const listen = entries.find((h) => h.command.endsWith('/scripts/listen.sh'));
      expect(listen?.asyncRewake).toBe(true);
      expect(listen?.timeout ?? 0).toBeGreaterThan(1800);
      expect(listen?.rewakeSummary).toBeTruthy();
    });
  }

  it('SessionStart no longer asks Claude to run a Monitor', () => {
    const s = registered();
    const out = execFileSync('bash', ['-c', `printf '{"source":"startup"}' | "${SESSION_START}"`], {
      env: { PATH: process.env.PATH ?? '', HOME: s.home, C2C_DIR: s.c2cDir, C2C_URL: 'http://127.0.0.1:9' },
      encoding: 'utf8',
    });
    expect(out).not.toMatch(/invoke the Monitor tool|timeout_ms|re-arm/i);
    expect(out).toMatch(/do not start a Monitor/);
    expect(out).toMatch(/UNTRUSTED_PEER_MESSAGE/);
  });

  it('/c2c-client:peer-listen does not start a Monitor', () => {
    const md = readFileSync(PEER_LISTEN_MD, 'utf8');
    expect(md).not.toMatch(/allowed-tools:.*Monitor/);
    expect(md).not.toMatch(/Invoke the Monitor tool/);
  });
});
