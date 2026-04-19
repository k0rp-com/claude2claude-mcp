# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two deliverables in one repo:

1. **Mediator server** (`src/`) — Hono + better-sqlite3 + ed25519. HTTP-only; stores machines, pairings, pair-requests, messages. Single binary (`pnpm start`). Runs under PM2 as `c2c-mediator`.
2. **Claude Code plugin `c2c-client`** (`client-plugin/`) — slash-commands + Stop-hook, pure bash (`curl` + `jq` + `openssl` + `uuidgen`). No Node runtime on the client side.

The two sides communicate over HTTPS with every request signed by an ed25519 key whose private half never leaves the client machine. `README.md` has the full security model and threat table — read it before touching auth/crypto.

## Commands

```bash
pnpm install
pnpm dev              # tsx watch — dev server on :3000
pnpm start            # production (used by PM2 via ecosystem.config.cjs)
pnpm test             # vitest run, forks pool, singleFork (tests share DB state)
pnpm test:watch
pnpm typecheck        # tsc --noEmit
pnpm show-creds       # prints URL + MEDIATOR_TOKEN + client install steps
pnpm bump             # scripts/bump-version.ts — marketplace version bump
```

Run one test file: `pnpm test tests/pairing.test.ts`. Single test: `pnpm test -t "name substring"`.

Persistent server: `npx pm2 start ecosystem.config.cjs && npx pm2 save`. Logs via `npx pm2 logs c2c-mediator`.

## Server architecture — non-obvious bits

- **`src/index.ts` uses dynamic `await import()` after `ensureEnv()`.** Order matters: `bootstrap.ts` auto-writes `/workspace/.env` (with a freshly generated `MEDIATOR_TOKEN`) on first run, and `config.ts` reads env at module-load time via zod. Static imports would snapshot env before bootstrap. Don't convert to static imports.
- **`config.ts` calls `process.exit(1)` on invalid env.** Any new env var goes through the zod schema there, not read ad-hoc.
- **All authenticated endpoints verify the same canonical signature:** `ed25519(METHOD\nPATH\nTS\nNONCE\nsha256_hex(BODY))` with headers `X-Machine-ID`, `X-Timestamp` (ms), `X-Nonce` (32-hex), `X-Signature` (base64). `crypto.ts` + `replay.ts` (nonce LRU) + `CLOCK_SKEW_SECONDS` window enforce this. `POST /v1/register` is the only endpoint that *also* needs `Bearer <MEDIATOR_TOKEN>` — the token is a write-gate for adding new machines, never an auth credential for subsequent requests.
- **Rate limits are per-machine token buckets** defined inline in `server.ts` (`RATE_LIMITS` map). `rateLimit.ts` provides the limiter factory.
- **Background sweeper** (`cleanup.ts`) enforces unacked-message TTL, expires pair-requests, etc. Started from `index.ts`; stopped on SIGTERM/SIGINT.
- **Body cap is 64 KiB** (`MAX_BODY_LEN` in `server.ts`), inbox cap 500 unacked per recipient (`MAX_UNACKED_PER_RECIPIENT`). Fingerprint format is fixed `xxxx-xxxx-xxxx` hex (`FP_RE`); names match `NAME_RE` (Unicode letters/digits/._- up to 32).
- **Stop-hook ↔ peer-listen loop avoidance:** the Stop-hook emits its JSON decision **before** acking messages on the server (see recent commit `ce39b8e`). If you refactor ack ordering, re-check that a listener session doesn't re-trigger itself.

## Tests

`vitest` with `pool: 'forks'` + `singleFork: true` — tests share one worker because they share SQLite state. `tests/setup.ts` + `tests/helpers.ts` boot an isolated in-memory mediator and sign requests as test machines. When adding an endpoint, extend `helpers.ts` rather than hand-rolling signatures in each test.

## Client plugin (`client-plugin/`)

- Pure bash. `scripts/common.sh` holds shared helpers (sign, HTTP, config resolution). Every command script sources it.
- **Config precedence** (higher wins): Claude Code `userConfig` form (set at `/plugin enable`) > env `C2C_URL` / `C2C_MEDIATOR_TOKEN` > `~/.config/c2c-client/config.json` > defaults. `/c2c-client:peer-config show` reports the source per key.
- Slash commands are `commands/peer-*.md` — each is a thin wrapper that invokes the matching `scripts/*.sh`. **Always reference slash commands by their fully qualified name `/c2c-client:peer-*`** in docs, prompts, and other commands (see commit `b6a1049`); plain `/peer-*` breaks when multiple plugins are installed.
- **Three delivery mechanisms** for messages (peer-listen persistent Monitor, Stop-hook notify, Stop-hook auto-inject) — see README "Доставка сообщений". When editing `stop-hook.sh` or `listen.sh`, preserve the security-frame wrapping (`<<<UNTRUSTED_PEER_MESSAGE>>>` + the 6 rules) on any code path that puts message bodies into Claude's context.

## Marketplace / install

`.claude-plugin/marketplace.json` is the single source of truth for plugin discovery. After changing plugin version, run `pnpm bump` rather than hand-editing.
