import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const LISTEN = require.resolve('../../client-plugin/scripts/listen.sh');
const SESSION_START = require.resolve('../../client-plugin/scripts/session-start.sh');

// Exercises the peer-listener ownership/takeover helpers in
// client-plugin/scripts/common.sh.
//
// Contract: listener.pid stores "PID SESSION_ID". A session can tell whether a
// live listener is ITS OWN (CLAUDE_CODE_SESSION_ID matches — leave it, e.g. the
// Monitor carried across /clear) or FOREIGN/orphaned (take it over). Takeover
// TERMs, waits for the process to actually die (so the dying listener's EXIT
// trap can't delete a freshly-claimed pid file), and escalates to KILL. A
// recorded PID whose command line is NOT our listen.sh (PID reuse after a crash)
// must never be classified as a live listener — we must not kill innocents.

const COMMON = path.resolve(__dirname, '../../client-plugin/scripts/common.sh');
const cleanup: string[] = [];

function mkTmp(prefix = 'c2c-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

/** Run a bash snippet with common.sh sourced. Returns trimmed stdout. */
function sh(body: string, env: Record<string, string>): string {
  const script = `set -u; source "${COMMON}" >/dev/null 2>&1; ${body}`;
  return execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  }).trim();
}

/** A script whose path ends in listen.sh so `ps -o args=` matches our guard. */
function fakeListener(dir: string): string {
  const p = path.join(dir, 'listen.sh');
  writeFileSync(p, '#!/usr/bin/env bash\nsleep 60\n');
  return p;
}

function setup() {
  const home = mkTmp('home-');
  const c2cDir = path.join(home, 'c2c');
  mkdirSync(c2cDir, { recursive: true });
  return { home, c2cDir };
}

describe('c2c-client peer-listener ownership/takeover', () => {
  it('none: no pid file → state "none"', () => {
    const { home, c2cDir } = setup();
    const out = sh('c2c::listener_state', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's1',
    });
    expect(out).toBe('none');
  });

  it('deleted-resource: pid file points at a dead process → state "dead"', () => {
    const { home, c2cDir } = setup();
    writeFileSync(path.join(c2cDir, 'listener.pid'), '999999 s1\n');
    const out = sh('c2c::listener_state', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's1',
    });
    expect(out).toBe('dead');
  });

  it('malformed-input: garbage pid file → state "dead", never a kill target', () => {
    const { home, c2cDir } = setup();
    writeFileSync(path.join(c2cDir, 'listener.pid'), 'not-a-pid !!!\n');
    const out = sh('c2c::listener_state', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's1',
    });
    expect(out).toBe('dead');
  });

  it('PID reuse: live process that is NOT listen.sh → "dead" (guards killing innocents)', () => {
    const { home, c2cDir } = setup();
    // Owner even matches our session, but the process is a plain `sleep`, not a
    // listener. Must be "dead" so the caller overwrites rather than kills it.
    const out = sh(
      `
      sleep 60 >/dev/null 2>&1 &
      pid=$!
      printf '%s s1\\n' "$pid" > "${path.join(c2cDir, 'listener.pid')}"
      c2c::listener_state
      kill -9 "$pid" 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' },
    );
    expect(out).toBe('dead');
  });

  it('mine: live listener owned by this session → state "mine"', () => {
    const { home, c2cDir } = setup();
    const listener = fakeListener(c2cDir);
    const out = sh(
      `
      bash "${listener}" >/dev/null 2>&1 &
      pid=$!
      printf '%s s1\\n' "$pid" > "${path.join(c2cDir, 'listener.pid')}"
      c2c::listener_state
      kill -9 "$pid" 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' },
    );
    expect(out).toBe('mine');
  });

  it('foreign: live listener owned by another session → state "foreign"', () => {
    const { home, c2cDir } = setup();
    const listener = fakeListener(c2cDir);
    const out = sh(
      `
      bash "${listener}" >/dev/null 2>&1 &
      pid=$!
      printf '%s s2\\n' "$pid" > "${path.join(c2cDir, 'listener.pid')}"
      c2c::listener_state
      kill -9 "$pid" 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' },
    );
    expect(out).toBe('foreign');
  });

  it('empty-session-id fallback: live foreign listener → "mine" (conservative, no kill)', () => {
    const { home, c2cDir } = setup();
    const listener = fakeListener(c2cDir);
    // CLAUDE_CODE_SESSION_ID unset: we cannot reason about ownership, so a live
    // listener must be treated as untouchable (old behavior), not slaughtered.
    const out = sh(
      `
      bash "${listener}" >/dev/null 2>&1 &
      pid=$!
      printf '%s s2\\n' "$pid" > "${path.join(c2cDir, 'listener.pid')}"
      c2c::listener_state
      kill -9 "$pid" 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir },
    );
    expect(out).toBe('mine');
  });

  it('takeover: foreign listener is killed and the pid file is re-claimed for us', () => {
    const { home, c2cDir } = setup();
    const listener = fakeListener(c2cDir);
    const pidFile = path.join(c2cDir, 'listener.pid');
    const out = sh(
      `
      bash "${listener}" >/dev/null 2>&1 &
      old=$!
      printf '%s s2\\n' "$old" > "${pidFile}"
      [[ "$(c2c::listener_state)" == foreign ]] || { echo "NOT_FOREIGN"; exit 1; }
      c2c::listener_takeover "$old" || { echo "TAKEOVER_FAILED"; exit 1; }
      c2c::listener_claim
      if kill -0 "$old" 2>/dev/null; then echo "OLD_ALIVE"; else echo "OLD_DEAD"; fi
      `,
      { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' },
    );
    expect(out).toBe('OLD_DEAD');
    // pid file now owned by this session (second field s1), pointing at a new pid.
    const [, owner] = readFileSync(pidFile, 'utf8').trim().split(/\s+/);
    expect(owner).toBe('s1');
  });

  it('concurrency/stubborn: takeover escalates to KILL when the process ignores TERM', () => {
    const { home, c2cDir } = setup();
    const out = sh(
      `
      bash -c 'trap "" TERM INT; sleep 60' >/dev/null 2>&1 &
      pid=$!
      sleep 0.2
      c2c::listener_takeover "$pid" && echo "RC0" || echo "RC1"
      if kill -0 "$pid" 2>/dev/null; then echo "ALIVE"; else echo "DEAD"; fi
      kill -9 "$pid" 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' },
    );
    expect(out).toBe('RC0\nDEAD');
  });

  it('listener_claim writes "PID SESSION_ID"', () => {
    const { home, c2cDir } = setup();
    const pidFile = path.join(c2cDir, 'listener.pid');
    sh('c2c::listener_claim', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 'sX',
    });
    const [pid, owner] = readFileSync(pidFile, 'utf8').trim().split(/\s+/);
    expect(pid).toMatch(/^[0-9]+$/);
    expect(owner).toBe('sX');
  });

  it('PID reuse: "listen.sh" as a non-path arg substring is NOT a listener → "dead"', () => {
    const { home, c2cDir } = setup();
    // argv "editor listen.sh 60": mentions the name but not as a /path component,
    // like `vim listen.sh`. The anchored match must reject it so we never signal
    // an innocent same-uid process.
    const out = sh(
      `
      bash -c 'exec -a "editor listen.sh" sleep 60' >/dev/null 2>&1 &
      pid=$!
      sleep 0.2
      printf '%s s1\\n' "$pid" > "${path.join(c2cDir, 'listener.pid')}"
      c2c::listener_state
      kill -9 "$pid" 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' },
    );
    expect(out).toBe('dead');
  });

  it('zombie: a defunct listener process is classified "dead", not a live one', () => {
    const { home, c2cDir } = setup();
    // Child execs into `sleep 0.3` with argv[0] "/listen.sh" (would match the
    // path anchor), then exits while its parent (the wrapper) is still alive and
    // has not reaped it → a zombie. kill -0 still succeeds on a zombie, so only
    // the STAT=Z guard keeps us from treating it as a live listener.
    const out = sh(
      `
      bash -c 'exec -a "/listen.sh" sleep 0.3' >/dev/null 2>&1 &
      z=$!
      sleep 0.7
      printf '%s sess-OLD\\n' "$z" > "${path.join(c2cDir, 'listener.pid')}"
      c2c::listener_state
      wait 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' },
    );
    expect(out).toBe('dead');
  });

  it('lock: steals a dead holder’s lock but yields to a live holder', () => {
    const { home, c2cDir } = setup();
    const lock = path.join(c2cDir, 'listener.lock');
    const out = sh(
      `
      # dead holder → steal and acquire
      mkdir -p "${lock}"; echo 999999 > "${lock}/pid"
      c2c::listener_lock && echo STEAL_OK || echo STEAL_FAIL
      c2c::listener_unlock
      # live holder (this shell) → cannot acquire within the budget
      mkdir -p "${lock}"; echo $$ > "${lock}/pid"
      c2c::listener_lock && echo HELD_OK || echo HELD_BLOCKED
      rm -rf "${lock}"
      `,
      { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' },
    );
    expect(out).toBe('STEAL_OK\nHELD_BLOCKED');
  }, 15000);
});

// Integration against the REAL listen.sh (which runs `set -uo pipefail`). Pure
// helper tests missed a regression where a global set inside the $(...) that
// captures listener_state never reached the caller → "unbound variable" the
// moment listen.sh referenced it. These exercise the actual startup path.
describe('c2c-client listen.sh takeover (integration)', () => {
  function listenSetup() {
    const home = mkTmp('home-');
    const c2cDir = path.join(home, 'c2c');
    mkdirSync(c2cDir, { recursive: true });
    writeFileSync(
      path.join(c2cDir, 'identity.json'),
      JSON.stringify({ id: 'testmachine', created_at: '2026-01-01T00:00:00Z' }),
    );
    return { home, c2cDir };
  }

  it('foreign: real listen.sh takes over the old listener and claims the inbox here', () => {
    const { home, c2cDir } = listenSetup();
    const foreign = fakeListener(c2cDir); // .../listen.sh sleeper = the other session
    const pidFile = path.join(c2cDir, 'listener.pid');
    const outFile = path.join(c2cDir, 'out.txt');
    const out = execFileSync(
      'bash',
      [
        '-c',
        `
        set -u
        bash "${foreign}" >/dev/null 2>&1 &
        old=$!
        printf '%s sess-OLD\\n' "$old" > "${pidFile}"
        "${LISTEN}" >"${outFile}" 2>&1 &
        new=$!
        sleep 1.5
        if kill -0 "$old" 2>/dev/null; then echo OLD_ALIVE; else echo OLD_DEAD; fi
        if kill -0 "$new" 2>/dev/null; then echo NEW_ALIVE; else echo NEW_EXITED; fi
        kill -9 "$new" "$old" 2>/dev/null || true
        wait 2>/dev/null || true
        `,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          C2C_DIR: c2cDir,
          C2C_URL: 'http://127.0.0.1:1',
          CLAUDE_CODE_SESSION_ID: 'sess-NEW',
        },
        encoding: 'utf8',
      },
    ).trim();
    expect(out).toBe('OLD_DEAD\nNEW_ALIVE');
    expect(readFileSync(outFile, 'utf8')).toContain('taking over');
    const [, owner] = readFileSync(pidFile, 'utf8').trim().split(/\s+/);
    expect(owner).toBe('sess-NEW');
  }, 15000);

  it('mine: real listen.sh refuses and leaves this session’s own listener untouched', () => {
    const { home, c2cDir } = listenSetup();
    const own = fakeListener(c2cDir);
    const pidFile = path.join(c2cDir, 'listener.pid');
    const outFile = path.join(c2cDir, 'out.txt');
    const out = execFileSync(
      'bash',
      [
        '-c',
        `
        set -u
        bash "${own}" >/dev/null 2>&1 &
        mine=$!
        printf '%s sess-SAME\\n' "$mine" > "${pidFile}"
        "${LISTEN}" >"${outFile}" 2>&1
        echo "exit=$?"
        if kill -0 "$mine" 2>/dev/null; then echo OWN_ALIVE; else echo OWN_DEAD; fi
        kill -9 "$mine" 2>/dev/null || true
        wait 2>/dev/null || true
        `,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          C2C_DIR: c2cDir,
          C2C_URL: 'http://127.0.0.1:1',
          CLAUDE_CODE_SESSION_ID: 'sess-SAME',
        },
        encoding: 'utf8',
      },
    ).trim();
    expect(out).toBe('exit=0\nOWN_ALIVE');
    expect(readFileSync(outFile, 'utf8')).toContain('already running in this session');
  }, 15000);
});

// session-start.sh decides whether to tell Claude to arm a Monitor. It must stay
// silent for OUR own listener (incl. one carried across /clear even if the
// session id rotated), but arm — so listen.sh can take over — for a foreign
// listener on a normal startup.
describe('c2c-client session-start.sh arm decision', () => {
  function ssSetup() {
    const { home, c2cDir } = (() => {
      const h = mkTmp('home-');
      const d = path.join(h, 'c2c');
      mkdirSync(d, { recursive: true });
      writeFileSync(
        path.join(d, 'identity.json'),
        JSON.stringify({ id: 'testmachine', created_at: '2026-01-01T00:00:00Z' }),
      );
      writeFileSync(path.join(d, 'name.txt'), 'tester');
      return { home: h, c2cDir: d };
    })();
    return { home, c2cDir };
  }

  /** Run session-start.sh with a live listener owned by `owner` and the given
   *  hook `source`; return its stdout (the additionalContext). */
  function runSessionStart(
    c2cDir: string,
    home: string,
    opts: { owner: string; mySession: string; source: string },
  ): string {
    const listener = fakeListener(c2cDir);
    const outFile = path.join(c2cDir, 'ss-out.txt');
    execFileSync(
      'bash',
      [
        '-c',
        `
        set -u
        bash "${listener}" >/dev/null 2>&1 &
        pid=$!
        printf '%s ${opts.owner}\\n' "$pid" > "${path.join(c2cDir, 'listener.pid')}"
        printf '%s' '{"source":"${opts.source}","hook_event_name":"SessionStart"}' \
          | "${SESSION_START}" > "${outFile}" 2>&1
        kill -9 "$pid" 2>/dev/null || true
        wait 2>/dev/null || true
        `,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          C2C_DIR: c2cDir,
          C2C_URL: 'http://127.0.0.1:1',
          CLAUDE_CODE_SESSION_ID: opts.mySession,
        },
        encoding: 'utf8',
      },
    );
    return readFileSync(outFile, 'utf8');
  }

  it('mine (same session): stays silent, does not arm a second Monitor', () => {
    const { home, c2cDir } = ssSetup();
    const out = runSessionStart(c2cDir, home, {
      owner: 'sess-A',
      mySession: 'sess-A',
      source: 'startup',
    });
    expect(out).not.toContain('auto-arm');
    expect(out).toContain('уже активен в этой сессии');
  }, 15000);

  it('clear + foreign owner: treats a carried-over listener as ours, stays silent', () => {
    const { home, c2cDir } = ssSetup();
    // Session id rotated across /clear so the pid file's owner looks foreign, but
    // source=clear means the Monitor (and listener) carried over → don't re-arm.
    const out = runSessionStart(c2cDir, home, {
      owner: 'sess-OLD',
      mySession: 'sess-NEW',
      source: 'clear',
    });
    expect(out).not.toContain('auto-arm');
    expect(out).toContain('уже активен в этой сессии');
  }, 15000);

  it('startup + foreign owner: arms Monitor so listen.sh can take over', () => {
    const { home, c2cDir } = ssSetup();
    const out = runSessionStart(c2cDir, home, {
      owner: 'sess-OTHER',
      mySession: 'sess-NEW',
      source: 'startup',
    });
    expect(out).toContain('auto-arm');
  }, 15000);
});
