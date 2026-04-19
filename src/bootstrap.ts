// Auto-creates .env on first start with a single MEDIATOR_TOKEN secret.
// The token is written to .env (mode 0600) only. It is NEVER written to a
// separate, mode-0400 "install instructions" file — that left a plaintext
// copy of the mediator token in the working directory indefinitely.

import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

function genToken(): string {
  return randomBytes(32).toString('hex');
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function serializeEnv(obj: Record<string, string>): string {
  const order = ['MEDIATOR_TOKEN', 'PUBLIC_URL', 'DB_PATH', 'PORT', 'HOST', 'MAX_LONG_POLL_SECONDS', 'LOG_LEVEL', 'PAIR_REQUEST_TTL_SECONDS', 'CLOCK_SKEW_SECONDS', 'UNACKED_MESSAGE_TTL_SECONDS'];
  const seen = new Set<string>();
  const lines = ['# Auto-generated. MEDIATOR_TOKEN is a SECRET — do not commit.'];
  for (const k of order) {
    if (k in obj) { lines.push(`${k}=${obj[k]}`); seen.add(k); }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

function renderInstall(r: BootstrapResult, opts: { redactToken?: boolean } = {}): string {
  const bar = '═'.repeat(72);
  const tokenLine = opts.redactToken
    ? '    mediator_token = <printed once to stderr on first server start — see `pnpm show-creds`>'
    : `    mediator_token = ${r.mediatorToken}`;
  return [
    bar,
    '  c2c-client install — run on EVERY machine you want to be reachable',
    bar,
    '',
    '  In Claude Code:',
    `    /plugin marketplace add ${r.marketplaceUrl ?? '<git-url-of-this-repo>'}`,
    '    /plugin install c2c-client@claude2claude',
    '',
    '  When asked, paste:',
    `    url            = ${r.publicUrl}`,
    tokenLine,
    '',
    '  Then on each machine, in Claude:',
    '    /c2c-client:peer-name <a-short-name-for-this-machine>',
    '    /c2c-client:peer-id              # show your fingerprint, give it to the other machine',
    '',
    '  To pair two machines:',
    '    On machine A:  /c2c-client:peer-pair <B-fingerprint>',
    '    A will print a 4-digit code. Tell it to user-of-B.',
    '    On machine B:  /c2c-client:peer-confirm <code>',
    '    Done — they can now /c2c-client:peer-send <name> ...',
    '',
    bar,
    '  SECURITY:',
    '  - mediator_token only authorizes registration on this server.',
    '  - All real auth is per-machine ed25519 signatures: only the holder of',
    '    a private key can act as that machine. Stealing the mediator_token',
    '    alone does NOT let anyone impersonate or read your machines.',
    '  - Delete this file after copying.',
    bar,
    '',
  ].join('\n');
}

export interface BootstrapResult {
  envPath: string;
  installFilePath: string;
  generatedToken: boolean;
  publicUrl: string;
  mediatorToken: string;
  marketplaceUrl?: string;
}

export function ensureEnv(cwd = process.cwd(), opts: { marketplaceUrl?: string } = {}): BootstrapResult {
  const envPath = join(cwd, '.env');
  const installFilePath = join(cwd, 'INSTALL_INSTRUCTIONS.txt');
  const existing = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};

  let changed = false;
  let generated = false;

  if (!existing['MEDIATOR_TOKEN'] || existing['MEDIATOR_TOKEN'].length < 32) {
    existing['MEDIATOR_TOKEN'] = genToken();
    changed = true;
    generated = true;
  }
  if (!existing['PUBLIC_URL']) {
    existing['PUBLIC_URL'] = process.env.PREVIEW_URL || `http://${process.env.HOST || '0.0.0.0'}:${process.env.PORT || '3000'}`;
    changed = true;
  }
  if (!existing['DB_PATH']) { existing['DB_PATH'] = join(cwd, 'data.db'); changed = true; }
  if (!existing['PORT']) { existing['PORT'] = '3000'; changed = true; }
  if (!existing['HOST']) { existing['HOST'] = '0.0.0.0'; changed = true; }
  if (!existing['MAX_LONG_POLL_SECONDS']) { existing['MAX_LONG_POLL_SECONDS'] = '30'; changed = true; }
  if (!existing['LOG_LEVEL']) { existing['LOG_LEVEL'] = 'info'; changed = true; }
  if (!existing['PAIR_REQUEST_TTL_SECONDS']) { existing['PAIR_REQUEST_TTL_SECONDS'] = '120'; changed = true; }
  if (!existing['CLOCK_SKEW_SECONDS']) { existing['CLOCK_SKEW_SECONDS'] = '300'; changed = true; }
  if (!existing['UNACKED_MESSAGE_TTL_SECONDS']) { existing['UNACKED_MESSAGE_TTL_SECONDS'] = '120'; changed = true; }

  if (changed) {
    writeFileSync(envPath, serializeEnv(existing), { mode: 0o600 });
    try { chmodSync(envPath, 0o600); } catch { /* */ }
  }

  for (const [k, v] of Object.entries(existing)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }

  const result: BootstrapResult = {
    envPath,
    installFilePath,
    generatedToken: generated,
    publicUrl: existing['PUBLIC_URL']!,
    mediatorToken: existing['MEDIATOR_TOKEN']!,
    marketplaceUrl: opts.marketplaceUrl,
  };

  // Best-effort cleanup of any legacy install file left on disk from older
  // versions — it contained the mediator token in plaintext.
  if (existsSync(installFilePath)) {
    try { unlinkSync(installFilePath); } catch { /* */ }
  }

  if (generated) {
    // Print the token exactly once, to stderr, where it is visible to the
    // operator launching the server but not captured by `pnpm start > log`.
    process.stderr.write('\n');
    process.stderr.write(renderInstall(result));
    process.stderr.write('\n');
    process.stderr.write('  ⚠ Save MEDIATOR_TOKEN now — it will not be printed again.\n');
    process.stderr.write('    Re-reveal via: `pnpm show-creds` (reads from .env).\n\n');
  }

  return result;
}

export function loadAndRender(cwd = process.cwd(), marketplaceUrl?: string): string {
  const r = ensureEnv(cwd, { marketplaceUrl });
  return renderInstall(r);
}
