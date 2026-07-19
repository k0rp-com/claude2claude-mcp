import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { generateEd25519 } from '../src/crypto.js';

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'c2c-dm-'));
  dirs.push(d);
  return join(d, 'data.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the CLI; return { status, stdout }. Never throws on non-zero exit. */
function runCli(dbPath: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('npx', ['tsx', 'scripts/delete-machine.ts', ...args], {
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    return { status: e.status ?? -1, stdout: (e.stdout ?? '').toString() };
  }
}

describe('pnpm delete-machine CLI (L5)', () => {
  it('exits 2 with usage when no arg is given', () => {
    const r = runCli(tmpDb(), []);
    expect(r.status).toBe(2);
  });

  it('exits 1 when no machine matches', () => {
    const dbPath = tmpDb();
    openDb(dbPath).close(); // create an empty, schema-initialised db
    const r = runCli(dbPath, ['0000-0000-0000']);
    expect(r.status).toBe(1);
  });

  it('deletes a real machine by fingerprint (exit 0, reports it)', () => {
    const dbPath = tmpDb();
    const db = openDb(dbPath);
    const { publicKeyPem } = generateEd25519();
    const m = db.registerMachine({ pubkeyPem: publicKeyPem, name: 'victim' });
    db.close(); // flush WAL before the CLI opens a second handle

    const r = runCli(dbPath, [m.fingerprint]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('deleted machine');

    // Confirm it's gone from the db.
    const db2 = openDb(dbPath);
    expect(db2.getMachine(m.id)).toBeNull();
    db2.close();
  }, 20_000);
});
