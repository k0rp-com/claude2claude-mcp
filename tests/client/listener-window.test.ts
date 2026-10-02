import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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

function sh(body: string, env: Record<string, string>): string {
  const script = `set -u; source "${COMMON}" >/dev/null 2>&1; ${body}`;
  return execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  }).trim();
}

function setup() {
  const home = mkTmp('home-');
  const c2cDir = path.join(home, 'c2c');
  mkdirSync(c2cDir, { recursive: true });
  return { home, c2cDir, pidFile: path.join(c2cDir, 'listener.pid') };
}

function fakeListener(dir: string): string {
  const p = path.join(dir, 'listen.sh');
  writeFileSync(p, '#!/usr/bin/env bash\nsleep 60\n');
  return p;
}

function stateWithPidFile(
  c2cDir: string,
  pidFile: string,
  fields: string,
  env: Record<string, string>,
): string {
  const listener = fakeListener(c2cDir);
  return sh(
    `
    bash "${listener}" >/dev/null 2>&1 &
    pid=$!
    printf '%s ${fields}\\n' "$pid" > "${pidFile}"
    c2c::listener_state
    kill -9 "$pid" 2>/dev/null || true
    `,
    env,
  );
}

describe('peer-listener ownership is keyed on the window, not the session id', () => {
  it('same window with a session id rotated by compact/resume/clear → mine', () => {
    const { home, c2cDir, pidFile } = setup();
    const out = stateWithPidFile(c2cDir, pidFile, 's1 4242', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's2-after-compact',
      C2C_WINDOW_ID: '4242',
    });
    expect(out).toBe('mine');
  });

  it('another window with an identical session id → foreign', () => {
    const { home, c2cDir, pidFile } = setup();
    const out = stateWithPidFile(c2cDir, pidFile, 's1 4242', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's1',
      C2C_WINDOW_ID: '9999',
    });
    expect(out).toBe('foreign');
  });

  it('deleted resource: recorded window process is gone (orphaned listener) → foreign', () => {
    const { home, c2cDir, pidFile } = setup();
    const out = stateWithPidFile(c2cDir, pidFile, 's1 999999', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's1',
      C2C_WINDOW_ID: '4242',
    });
    expect(out).toBe('foreign');
  });

  it('back-compat: pre-upgrade two-field pid file falls back to the session id', () => {
    const { home, c2cDir, pidFile } = setup();
    const base = { HOME: home, C2C_DIR: c2cDir, C2C_WINDOW_ID: '4242' };
    expect(
      stateWithPidFile(c2cDir, pidFile, 's1', { ...base, CLAUDE_CODE_SESSION_ID: 's1' }),
    ).toBe('mine');
    expect(
      stateWithPidFile(c2cDir, pidFile, 's1', { ...base, CLAUDE_CODE_SESSION_ID: 's2' }),
    ).toBe('foreign');
  });

  it('empty window id and empty session id → mine, never kills a live listener', () => {
    const { home, c2cDir, pidFile } = setup();
    const out = stateWithPidFile(c2cDir, pidFile, 's2 7777', {
      HOME: home,
      C2C_DIR: c2cDir,
      C2C_WINDOW_ID: '',
    });
    expect(out).toBe('mine');
  });

  it('listener_claim writes PID, SESSION_ID and WINDOW_ID', () => {
    const { home, c2cDir, pidFile } = setup();
    sh('c2c::listener_claim', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 'sX',
      C2C_WINDOW_ID: '4242',
    });
    const [pid, owner, win] = readFileSync(pidFile, 'utf8').trim().split(/\s+/);
    expect(pid).toMatch(/^[0-9]+$/);
    expect(owner).toBe('sX');
    expect(win).toBe('4242');
  });
});

describe('c2c::window_id', () => {
  function script(dir: string, name: string, body: string): string {
    const p = path.join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    return p;
  }

  function waitForDone(marker: string, timeoutMs = 15000): void {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(marker)) return;
      execFileSync('sleep', ['0.05']);
    }
    throw new Error(`detached probe never finished: ${marker} not created within ${timeoutMs}ms`);
  }

  function runDetachedAs(
    argv0: string,
    entry: string,
    home: string,
    c2cDir: string,
    env: Record<string, string> = {},
  ): void {
    execFileSync('bash', ['-c', `(exec -a "${argv0}" bash "${entry}") >/dev/null 2>&1 &`], {
      env: { PATH: process.env.PATH ?? '', HOME: home, C2C_DIR: c2cDir, ...env },
      encoding: 'utf8',
    });
    waitForDone(path.join(c2cDir, 'probe.done'));
  }

  function probe(dir: string, name: string, out: string, prefix = 'sleep 0.3\n'): string {
    return script(
      dir,
      name,
      `${prefix}source "${COMMON}" >/dev/null 2>&1\nc2c::window_id > "${out}"\nprintf done > "${path.join(dir, 'probe.done')}"`,
    );
  }

  it('resolves the ancestor claude pid plus a start-time token', () => {
    const { home, c2cDir } = setup();
    const out = path.join(c2cDir, 'self.out');
    const entry = script(
      c2cDir,
      'claude-window.sh',
      `sleep 0.3\nsource "${COMMON}" >/dev/null 2>&1\necho "$$ $(c2c::window_id)" > "${out}"\nprintf done > "${path.join(c2cDir, 'probe.done')}"`,
    );
    runDetachedAs('claude', entry, home, c2cDir);
    const [self, win] = readFileSync(out, 'utf8').trim().split(/\s+/);
    expect(win).toMatch(new RegExp(`^${self}\\.[pl][0-9a-f]{8}$`));
  });

  it('resolves a node-launched install where the path only appears in argv[1]', () => {
    const { home, c2cDir } = setup();
    const out = path.join(c2cDir, 'node.out');
    const cliDir = path.join(c2cDir, 'claude-code');
    mkdirSync(cliDir, { recursive: true });
    const entry = probe(cliDir, 'cli.js', out);
    execFileSync('bash', ['-c', `(exec -a node bash "${entry}") >/dev/null 2>&1 &`], {
      env: { PATH: process.env.PATH ?? '', HOME: home, C2C_DIR: c2cDir },
      encoding: 'utf8',
    });
    waitForDone(path.join(cliDir, 'probe.done'));
    expect(readFileSync(out, 'utf8').trim()).toMatch(/^[0-9]+\.[pl][0-9a-f]{8}$/);
  });

  it('start-time token of one pid is identical under different LC_TIME locales', () => {
    const { home, c2cDir } = setup();
    const tokens = ['C', 'en_US.UTF-8', 'de_DE.UTF-8'].map((locale) =>
      sh(`c2c::_pid_start_token ${process.pid}`, { HOME: home, C2C_DIR: c2cDir, LC_ALL: locale }),
    );
    expect(tokens[0]).toMatch(/^[pl][0-9a-f]{8}$/);
    expect(new Set(tokens).size).toBe(1);
  });

  it('resolves the outermost claude when a child claude session is nested inside', () => {
    const { home, c2cDir } = setup();
    const outerOut = path.join(c2cDir, 'outer.out');
    const innerOut = path.join(c2cDir, 'inner.out');
    const inner = probe(c2cDir, 'claude-inner.sh', innerOut);
    const outer = script(
      c2cDir,
      'claude-outer.sh',
      `sleep 0.3\necho "$$" > "${outerOut}"\n(exec -a claude bash "${inner}")`,
    );
    runDetachedAs('claude', outer, home, c2cDir);
    const innerWindow = readFileSync(innerOut, 'utf8').trim();
    expect(innerWindow.split('.')[0]).toBe(readFileSync(outerOut, 'utf8').trim());
  });

  it('a process that merely mentions claude in its arguments is not a window', () => {
    const { home, c2cDir } = setup();
    const out = path.join(c2cDir, 'impostor.out');
    runDetachedAs('tail -f claude', probe(c2cDir, 'impostor.sh', out), home, c2cDir);
    expect(readFileSync(out, 'utf8').trim()).toBe('');
  });

  it('gives up when the claude ancestor sits deeper than the depth cap', () => {
    const { home, c2cDir } = setup();
    const out = path.join(c2cDir, 'deep.out');
    const inner = probe(c2cDir, 'deep.sh', out, '');
    const outer = script(c2cDir, 'claude-deep.sh', `sleep 0.3\nbash "${inner}"`);
    runDetachedAs('claude', outer, home, c2cDir, { C2C_MAX_ANCESTRY_DEPTH: '1' });
    expect(readFileSync(out, 'utf8').trim()).toBe('');
  });

  it('finds that same ancestor at the default depth', () => {
    const { home, c2cDir } = setup();
    const out = path.join(c2cDir, 'deep-ok.out');
    const inner = probe(c2cDir, 'deep.sh', out, '');
    const outer = script(c2cDir, 'claude-deep.sh', `sleep 0.3\nbash "${inner}"`);
    runDetachedAs('claude', outer, home, c2cDir);
    expect(readFileSync(out, 'utf8').trim()).toMatch(/^[0-9]+\.[pl][0-9a-f]{8}$/);
  });

  it('returns empty when no claude ancestor exists so callers fall back to the session id', () => {
    const { home, c2cDir } = setup();
    const out = path.join(c2cDir, 'window-id.out');
    const entry = probe(c2cDir, 'plain.sh', out);
    execFileSync('bash', ['-c', `bash "${entry}" >/dev/null 2>&1 &`], {
      env: { PATH: process.env.PATH ?? '', HOME: home, C2C_DIR: c2cDir },
      encoding: 'utf8',
    });
    waitForDone(path.join(c2cDir, 'probe.done'));
    expect(readFileSync(out, 'utf8').trim()).toBe('');
  });
});

describe('Stop hook and a live listener', () => {
  const STOP_HOOK = require.resolve('../../client-plugin/scripts/stop-hook.sh');

  function runStopHook(c2cDir: string, home: string, pidFile: string, fields: string): string {
    const listener = fakeListener(c2cDir);
    writeFileSync(
      path.join(c2cDir, 'identity.json'),
      JSON.stringify({ id: 'testmachine', created_at: '2026-01-01T00:00:00Z' }),
    );
    writeFileSync(path.join(c2cDir, 'name.txt'), 'probe\n');
    return execFileSync(
      'bash',
      [
        '-c',
        `bash "${listener}" >/dev/null 2>&1 &
         pid=$!
         printf '%s ${fields}\\n' "$pid" > "${pidFile}"
         printf '{}' | "${STOP_HOOK}" >/dev/null 2>&1
         if [[ -f "${pidFile}" ]]; then echo KEPT; else echo DELETED; fi
         kill -9 "$pid" 2>/dev/null || true`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          C2C_DIR: c2cDir,
          C2C_URL: 'http://127.0.0.1:9',
          C2C_WINDOW_ID: '4242',
          // The Stop hook only looks at the listener in -p sessions.
          C2C_PRINT_MODE: '1',
        },
        encoding: 'utf8',
      },
    ).trim();
  }

  it('keeps the pid file of a live listener instead of treating multi-field lines as stale', () => {
    const { home, c2cDir, pidFile } = setup();
    expect(runStopHook(c2cDir, home, pidFile, 's1 4242')).toBe('KEPT');
  });

  it('keeps a pre-upgrade two-field pid file of a live listener', () => {
    const { home, c2cDir, pidFile } = setup();
    expect(runStopHook(c2cDir, home, pidFile, 's1')).toBe('KEPT');
  });
});

describe('review fixes: pid-file format, window cache, launcher detection', () => {
  it('empty session id is written as a placeholder so the window id stays in its own field', () => {
    const { home, c2cDir, pidFile } = setup();
    sh('c2c::listener_claim', { HOME: home, C2C_DIR: c2cDir, C2C_WINDOW_ID: '4242' });
    const [pid, owner, win] = readFileSync(pidFile, 'utf8').trim().split(/\s+/);
    expect(pid).toMatch(/^[0-9]+$/);
    expect(owner).toBe('-');
    expect(win).toBe('4242');
  });

  it('placeholder-owned listener in another window reads foreign, in the same window mine', () => {
    const { home, c2cDir, pidFile } = setup();
    const base = { HOME: home, C2C_DIR: c2cDir, CLAUDE_CODE_SESSION_ID: 's1' };
    expect(stateWithPidFile(c2cDir, pidFile, '- 4242', { ...base, C2C_WINDOW_ID: '4242' })).toBe(
      'mine',
    );
    expect(stateWithPidFile(c2cDir, pidFile, '- 4242', { ...base, C2C_WINDOW_ID: '9999' })).toBe(
      'foreign',
    );
  });

  it('claim leaves no temp file behind', () => {
    const { home, c2cDir } = setup();
    sh('c2c::listener_claim', { HOME: home, C2C_DIR: c2cDir, C2C_WINDOW_ID: '4242' });
    const leftovers = require('node:fs')
      .readdirSync(c2cDir)
      .filter((n: string) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('warm_window_id survives command substitution, so callers stop re-walking ancestry', () => {
    const { home, c2cDir } = setup();
    const out = sh(
      `
      c2c::warm_window_id
      warmed="$__c2c_window_id"
      c2c::_pid_is_claude() { [[ "$1" == "$$" ]]; }
      cached="$(c2c::window_id)"
      unset __c2c_window_id
      fresh="$(c2c::window_id)"
      [[ "$cached" == "$warmed" ]] && echo CACHED_OK
      [[ "$fresh" == "$$".* ]] && echo FRESH_WALKS
      `,
      { HOME: home, C2C_DIR: c2cDir },
    );
    expect(out).toBe('CACHED_OK\nFRESH_WALKS');
  });

  it('node launcher with flags before cli.js is recognized as a claude window', () => {
    const { home, c2cDir } = setup();
    const holder = path.join(c2cDir, 'hold.sh');
    writeFileSync(holder, '#!/usr/bin/env bash\nsleep 30\n');
    const out = sh(
      `
      (exec -a node bash "${holder}" --max-old-space-size=3584 /opt/x/claude-code/cli.js) >/dev/null 2>&1 &
      pid=$!
      sleep 0.3
      c2c::_pid_is_claude "$pid" && echo CLAUDE || echo NOT
      kill -9 "$pid" 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir },
    );
    expect(out).toBe('CLAUDE');
  });

  it('node running a cli.js that merely has claude in its path is not a claude window', () => {
    const { home, c2cDir } = setup();
    const out = sh(
      `
      (exec -a node bash -c 'sleep 30; true' /home/u/claude-tools/cli.js) >/dev/null 2>&1 &
      pid=$!
      sleep 0.3
      c2c::_pid_is_claude "$pid" && echo CLAUDE || echo NOT
      kill -9 "$pid" 2>/dev/null || true
      `,
      { HOME: home, C2C_DIR: c2cDir },
    );
    expect(out).toBe('NOT');
  });

  it('bare node without arguments is not a window and does not crash under set -u', () => {
    const { home, c2cDir } = setup();
    const out = sh('ps() { echo node; }; c2c::_pid_is_claude $$ && echo CLAUDE || echo NOT', {
      HOME: home,
      C2C_DIR: c2cDir,
    });
    expect(out).toBe('NOT');
  });

  it('claim sweeps temp files orphaned by a killed earlier claim', () => {
    const { home, c2cDir, pidFile } = setup();
    writeFileSync(`${pidFile}.99999.tmp`, 'stale');
    sh('c2c::listener_claim', { HOME: home, C2C_DIR: c2cDir, C2C_WINDOW_ID: '4242' });
    const leftovers = require('node:fs')
      .readdirSync(c2cDir)
      .filter((n: string) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('hostile C2C_LAUNCHER_ARG_SCAN from the environment is not evaluated as code', () => {
    const { home, c2cDir } = setup();
    const marker = path.join(c2cDir, 'pwned');
    sh('ps() { echo "node /x/claude-code/cli.js"; }; c2c::_pid_is_claude $$ >/dev/null || true', {
      HOME: home,
      C2C_DIR: c2cDir,
      C2C_LAUNCHER_ARG_SCAN: `a[$(touch ${marker})]`,
      C2C_MAX_ANCESTRY_DEPTH: `a[$(touch ${marker})]`,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('same window pid with a pre-upgrade untagged start token is still mine (no self-takeover on upgrade)', () => {
    const { home, c2cDir, pidFile } = setup();
    const out = stateWithPidFile(c2cDir, pidFile, 's1 4242.a1b2c3d4', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's2',
      C2C_WINDOW_ID: '4242.p9f8e7d6c',
    });
    expect(out).toBe('mine');
  });

  it('same window pid seen via /proc by one process and via lstart by another is mine', () => {
    const { home, c2cDir, pidFile } = setup();
    const out = stateWithPidFile(c2cDir, pidFile, 's1 4242.l11111111', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's1',
      C2C_WINDOW_ID: '4242.p22222222',
    });
    expect(out).toBe('mine');
  });

  it('reused window pid with a different start token of the same kind is foreign', () => {
    const { home, c2cDir, pidFile } = setup();
    const out = stateWithPidFile(c2cDir, pidFile, 's1 4242.p11111111', {
      HOME: home,
      C2C_DIR: c2cDir,
      CLAUDE_CODE_SESSION_ID: 's1',
      C2C_WINDOW_ID: '4242.p22222222',
    });
    expect(out).toBe('foreign');
  });

  it.skipIf(!existsSync('/proc/self/stat'))(
    'start token does not depend on the displayed clock (TZ change keeps the same window id)',
    () => {
      const { home, c2cDir } = setup();
      const tokens = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'].map((tz) =>
        sh(`c2c::_pid_start_token ${process.pid}`, { HOME: home, C2C_DIR: c2cDir, TZ: tz }),
      );
      expect(tokens[0]).toMatch(/^[pl][0-9a-f]{8}$/);
      expect(new Set(tokens).size).toBe(1);
    },
  );
});
