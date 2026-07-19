import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEnv, loadAndRender } from '../src/bootstrap.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'c2c-boot-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bootstrap.ensureEnv', () => {
  it('generates a .env (0600) with a >=32-char MEDIATOR_TOKEN on first run', () => {
    const cwd = tmp();
    const r = ensureEnv(cwd);
    expect(r.generatedToken).toBe(true);
    expect(r.mediatorToken.length).toBeGreaterThanOrEqual(32);
    const envPath = join(cwd, '.env');
    expect(existsSync(envPath)).toBe(true);
    // mode low 9 bits must be owner-only rw.
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(envPath, 'utf8')).toContain('MEDIATOR_TOKEN=');
  });

  it('is idempotent — a second run keeps the same token and does not regenerate', () => {
    const cwd = tmp();
    const first = ensureEnv(cwd);
    const second = ensureEnv(cwd);
    expect(second.generatedToken).toBe(false);
    expect(second.mediatorToken).toBe(first.mediatorToken);
  });
});

describe('bootstrap.loadAndRender — install text', () => {
  it('documents the 6-digit pairing code, not 4-digit (doc-consistency fix)', () => {
    const out = loadAndRender(tmp());
    expect(out).toContain('6-digit');
    expect(out).not.toContain('4-digit');
  });
});
