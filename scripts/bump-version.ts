#!/usr/bin/env tsx
// Bump the c2c-client plugin version in BOTH plugin.json and marketplace.json,
// keeping them in lockstep. Without this, `/plugin update` on consumer
// machines can resolve stale metadata.
//
// Usage:
//   pnpm bump patch | minor | major
//   pnpm bump 1.2.3            # set explicit version

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PLUGIN_JSON = join(ROOT, 'client-plugin/.claude-plugin/plugin.json');
const MARKET_JSON = join(ROOT, '.claude-plugin/marketplace.json');

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

function bump(current: string, level: 'patch' | 'minor' | 'major'): string {
  const m = SEMVER_RE.exec(current);
  if (!m) throw new Error(`current version is not semver: ${current}`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === 'major') { maj += 1; min = 0; pat = 0; }
  else if (level === 'minor') { min += 1; pat = 0; }
  else { pat += 1; }
  return `${maj}.${min}.${pat}`;
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: pnpm bump <patch|minor|major|x.y.z>');
  process.exit(2);
}

const plugin = readJson<{ version: string; name: string }>(PLUGIN_JSON);
const current = plugin.version;

let next: string;
if (arg === 'patch' || arg === 'minor' || arg === 'major') {
  next = bump(current, arg);
} else if (SEMVER_RE.test(arg)) {
  next = arg;
} else {
  console.error(`Invalid argument: ${arg}. Expected patch|minor|major or x.y.z`);
  process.exit(2);
}

if (next === current) {
  console.log(`No change — already at ${current}`);
  process.exit(0);
}

plugin.version = next;
writeJson(PLUGIN_JSON, plugin);

const market = readJson<{ plugins: Array<{ name: string; version?: string }> }>(MARKET_JSON);
const entry = market.plugins.find((p) => p.name === plugin.name);
if (!entry) {
  console.error(`✗ marketplace.json has no plugin entry for "${plugin.name}"`);
  process.exit(1);
}
entry.version = next;
writeJson(MARKET_JSON, market);

console.log(`✅ ${plugin.name}: ${current} → ${next}`);
console.log(`   updated:`);
console.log(`     - ${PLUGIN_JSON}`);
console.log(`     - ${MARKET_JSON}`);
console.log(`   next: commit and push so /plugin update sees the bump.`);
