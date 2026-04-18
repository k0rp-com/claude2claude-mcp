#!/usr/bin/env tsx
// Explicit, on-demand credential viewer. Run via `pnpm show-creds`.
// Never invoked by the server itself — secrets do not land in service logs.

import { execSync } from 'node:child_process';
import { loadAndRender } from '../src/bootstrap.js';

let marketplaceUrl: string | undefined;
try {
  const remote = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  if (remote) {
    marketplaceUrl = remote
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '');
  }
} catch {
  /* no remote — placeholder will be shown */
}

process.stdout.write(loadAndRender(process.cwd(), marketplaceUrl));
