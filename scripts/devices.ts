#!/usr/bin/env tsx
// Device pairing CLI.
//   pnpm devices              — list
//   pnpm approve <fingerprint>
//   pnpm revoke  <fingerprint>

import { ensureEnv } from '../src/bootstrap.js';
ensureEnv();
const { config } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');

const db = openDb(config.dbPath);

const action = process.argv[2] ?? 'list';
const arg = process.argv[3];

function fmt(d: Record<string, unknown>) {
  const ts = (v: unknown) => (v ? new Date(Number(v)).toISOString().replace('T', ' ').slice(0, 19) : '—');
  return {
    fingerprint: d.fingerprint,
    project: d.project,
    status: d.status,
    created: ts(d.created_at),
    approved: ts(d.approved_at),
    last_seen: ts(d.last_seen_at),
  };
}

switch (action) {
  case 'list': {
    const rows = db.listDevices();
    if (rows.length === 0) console.log('(no devices registered yet — install plugin on a client and try /peer-status)');
    else console.table(rows.map(fmt));
    break;
  }
  case 'approve': {
    if (!arg) { console.error('Usage: pnpm approve <fingerprint>'); process.exit(2); }
    const dev = db.approveDevice(arg);
    if (!dev) {
      const existing = db.getDeviceByFingerprint(arg);
      if (!existing) { console.error(`✗ no device with fingerprint ${arg}`); process.exit(1); }
      console.log(`already approved: ${existing.fingerprint}  (${existing.project})`);
    } else {
      console.log(`✅ approved: ${dev.fingerprint}  (${dev.project})`);
    }
    break;
  }
  case 'revoke': {
    if (!arg) { console.error('Usage: pnpm revoke <fingerprint>'); process.exit(2); }
    const dev = db.revokeDevice(arg);
    if (!dev) {
      const existing = db.getDeviceByFingerprint(arg);
      if (!existing) { console.error(`✗ no device with fingerprint ${arg}`); process.exit(1); }
      console.log(`already revoked: ${existing.fingerprint}`);
    } else {
      console.log(`🔒 revoked: ${dev.fingerprint}  (${dev.project})`);
    }
    break;
  }
  default:
    console.error(`Unknown action: ${action}.  Use: list | approve <fp> | revoke <fp>`);
    process.exit(2);
}

db.close();
