import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Exercises the per-project identity-dir resolution in client-plugin/scripts/common.sh.
// Contract: with no explicit C2C_DIR, each project (keyed by its directory path)
// gets its OWN identity dir under <global>/projects/<slug>, while the mediator
// config.json (url/token) stays in the shared <global> dir. An explicit C2C_DIR
// env overrides everything.

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

/** Source common.sh under a controlled env/cwd and print a resolved variable. */
function resolveVar(
  varExpr: string,
  opts: { home: string; projectDir?: string; explicitDir?: string; cwd?: string },
): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: opts.home };
  if (opts.projectDir !== undefined) env.CLAUDE_PROJECT_DIR = opts.projectDir;
  if (opts.explicitDir !== undefined) env.C2C_DIR = opts.explicitDir;
  const script = `source "${COMMON}" >/dev/null 2>&1; printf '%s' "${varExpr}"`;
  return execFileSync('bash', ['-c', script], {
    env,
    cwd: opts.cwd,
    encoding: 'utf8',
  });
}

const dir = (o: Parameters<typeof resolveVar>[1]) => resolveVar('$C2C_DIR', o);
const cfg = (o: Parameters<typeof resolveVar>[1]) => resolveVar('$C2C_CONFIG_FILE', o);

describe('c2c-client per-project identity dir', () => {
  it('gives two different projects two different identity dirs, both under global projects/', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    const pb = mkTmp('projB-');
    const global = path.join(home, '.config/c2c-client');
    const da = dir({ home, projectDir: pa });
    const db = dir({ home, projectDir: pb });
    expect(da).not.toBe(db);
    expect(da.startsWith(`${global}/projects/`)).toBe(true);
    expect(db.startsWith(`${global}/projects/`)).toBe(true);
  });

  it('concurrency: same project path resolves to the same dir every time (no split identity)', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    expect(dir({ home, projectDir: pa })).toBe(dir({ home, projectDir: pa }));
  });

  it('keeps the mediator config.json global and shared across projects', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    const pb = mkTmp('projB-');
    const globalCfg = path.join(home, '.config/c2c-client/config.json');
    expect(cfg({ home, projectDir: pa })).toBe(globalCfg);
    expect(cfg({ home, projectDir: pb })).toBe(globalCfg);
  });

  it('explicit C2C_DIR override wins for identity AND config (back-compat / power users)', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    const ovr = mkTmp('ovr-');
    expect(dir({ home, projectDir: pa, explicitDir: ovr })).toBe(ovr);
    expect(cfg({ home, projectDir: pa, explicitDir: ovr })).toBe(`${ovr}/config.json`);
  });

  it('boundary: trailing slash canonicalizes to the same slug', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    expect(dir({ home, projectDir: `${pa}/` })).toBe(dir({ home, projectDir: pa }));
  });

  it('boundary: same basename in different paths → distinct dirs (no collision)', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    const pb = mkTmp('projB-');
    execFileSync('mkdir', ['-p', path.join(pa, 'sub/proj'), path.join(pb, 'sub/proj')]);
    const d1 = dir({ home, projectDir: path.join(pa, 'sub/proj') });
    const d2 = dir({ home, projectDir: path.join(pb, 'sub/proj') });
    expect(d1).not.toBe(d2);
  });

  it('malformed-input: path with spaces & special chars yields a safe, deterministic single-segment slug', () => {
    const home = mkTmp('home-');
    const base = mkTmp('weird-');
    const weird = path.join(base, 'a b (c)#d');
    execFileSync('mkdir', ['-p', weird]);
    const global = path.join(home, '.config/c2c-client');
    const w1 = dir({ home, projectDir: weird });
    const w2 = dir({ home, projectDir: weird });
    expect(w1).toBe(w2);
    const slug = w1.slice(`${global}/projects/`.length);
    expect(slug).not.toMatch(/[/()#\s]/); // no path separators, parens, hash, whitespace
  });

  it('deleted-resource: a nonexistent project path still resolves deterministically under projects/', () => {
    const home = mkTmp('home-');
    const ghost = `/tmp/c2c-ghost-${process.pid}-does-not-exist`;
    const global = path.join(home, '.config/c2c-client');
    const g1 = dir({ home, projectDir: ghost });
    const g2 = dir({ home, projectDir: ghost });
    expect(g1).toBe(g2);
    expect(g1.startsWith(`${global}/projects/`)).toBe(true);
  });

  it('empty: unset CLAUDE_PROJECT_DIR falls back to cwd (project root)', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    const viaProjectDir = dir({ home, projectDir: pa });
    const viaCwd = dir({ home, cwd: pa }); // CLAUDE_PROJECT_DIR unset → uses $PWD
    expect(viaCwd).toBe(viaProjectDir);
  });

  it('empty: CLAUDE_PROJECT_DIR set but empty string also falls back to cwd', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    const viaProjectDir = dir({ home, projectDir: pa });
    const viaEmpty = dir({ home, projectDir: '', cwd: pa });
    expect(viaEmpty).toBe(viaProjectDir);
  });

  it('regression: cwd inside a project subfolder keeps the SAME identity dir (git-root anchor)', () => {
    // The real bug: with CLAUDE_PROJECT_DIR unset (this harness never sets it),
    // Claude cd's into subfolders mid-session. Keying on raw $PWD moved the
    // identity dir on every cd, "losing" keys/contacts/listener. The dir must
    // anchor to the git toplevel, which is invariant across every subfolder.
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    execFileSync('git', ['-C', pa, 'init', '-q']);
    const sub = path.join(pa, 'src', 'deep', 'nested');
    execFileSync('mkdir', ['-p', sub]);
    const fromRoot = dir({ home, cwd: pa }); // CLAUDE_PROJECT_DIR unset
    const fromSub = dir({ home, cwd: sub }); // CLAUDE_PROJECT_DIR unset
    expect(fromSub).toBe(fromRoot);
  });

  it('priority: CLAUDE_PROJECT_DIR wins over the git toplevel of cwd', () => {
    // Resolution order is CLAUDE_PROJECT_DIR → git toplevel → $PWD. When the
    // harness declares the root explicitly, a differing git toplevel of cwd
    // must NOT override it.
    const home = mkTmp('home-');
    const declared = mkTmp('declared-');
    const repo = mkTmp('repo-');
    execFileSync('git', ['-C', repo, 'init', '-q']);
    const viaDeclared = dir({ home, projectDir: declared });
    const viaBoth = dir({ home, projectDir: declared, cwd: repo });
    expect(viaBoth).toBe(viaDeclared);
  });

  it('permission: shared global dir tree is chmod 700 (no metadata leak on shared hosts)', () => {
    const home = mkTmp('home-');
    const pa = mkTmp('projA-');
    // Sourcing common.sh in auto mode creates + hardens the global tree.
    resolveVar('$C2C_DIR', { home, projectDir: pa });
    const global = path.join(home, '.config/c2c-client');
    expect(statSync(global).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(global, 'projects')).mode & 0o777).toBe(0o700);
  });
});
