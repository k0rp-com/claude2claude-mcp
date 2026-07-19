#!/usr/bin/env tsx
// Revoke a machine completely: `pnpm delete-machine <fingerprint|id>`.
//
// This is the CORRECT, complete revocation. Deleting only the `machines` row
// (e.g. `sqlite3 data.db "DELETE FROM machines ..."`) leaves the machine's
// pairings behind — and because a machine id is derived deterministically from
// its public key, re-registering the same key would silently re-inherit those
// pairings. deleteMachine() cascades to pairings and messages in one txn.

import { ensureEnv } from '../src/bootstrap.js';

ensureEnv();
const { config } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');

const arg = (process.argv[2] ?? '').trim();
if (!arg) {
  process.stderr.write('usage: pnpm delete-machine <fingerprint|machine-id>\n');
  process.stderr.write('  fingerprint form: xxxx-xxxx-xxxx (from /c2c-client:peer-id)\n');
  process.exit(2);
}

const db = openDb(config.dbPath);
try {
  const FP_RE = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/i;
  const machine = FP_RE.test(arg)
    ? db.getMachineByFingerprint(arg.toLowerCase())
    : db.getMachine(arg);

  if (!machine) {
    process.stderr.write(`no machine matches "${arg}"\n`);
    process.exit(1);
  }

  const res = db.deleteMachine(machine.id);
  process.stdout.write(
    `deleted machine ${machine.name} (${machine.fingerprint}, id=${machine.id})\n` +
      `  pairings removed: ${res.pairings}\n` +
      `  messages removed: ${res.messages}\n`,
  );
} finally {
  db.close();
}
