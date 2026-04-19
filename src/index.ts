import { ensureEnv } from './bootstrap.js';

// Bootstrap env BEFORE importing modules that read from process.env at load time.
const boot = ensureEnv();

const { serve } = await import('@hono/node-server');
const { config } = await import('./config.js');
const { openDb } = await import('./db.js');
const { buildApp } = await import('./server.js');
const { makeLogger } = await import('./logger.js');
const { startCleanup } = await import('./cleanup.js');

const log = makeLogger(config.logLevel);
const db = openDb(config.dbPath);
const app = buildApp(db);
const cleanup = startCleanup(db, {
  unackedTtlMs: config.unackedMessageTtlMs,
  onSweep: (res) => {
    if (res.acked > 0 || res.stale > 0 || res.unacked > 0) {
      log.info('cleanup.swept', res);
    }
  },
});

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    log.info('server.started', {
      host: info.address,
      port: info.port,
      db: config.dbPath,
      // NOTE: never log tokens or project names. The boot result is intentionally not echoed.
      tokens_generated: boot.generatedToken,
    });
    if (boot.generatedToken) {
      log.info('server.first_boot', {
        msg: 'Fresh MEDIATOR_TOKEN generated and printed to stderr. Re-reveal via: pnpm show-creds',
      });
    }
  },
);

function shutdown(signal: string) {
  log.info('server.shutdown', { signal });
  cleanup.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
