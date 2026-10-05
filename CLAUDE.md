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
pnpm delete-machine <fingerprint|id>  # complete revocation: machine + its pairings + its messages (one txn)
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
- **Per-project identity** (`common.sh` → `c2c::_resolve_dirs` + `c2c::project_slug`, run in a bootstrap block at the bottom of the file *after* `c2c::sha256_hex` is defined). With no explicit `C2C_DIR`, each project gets its own identity dir `~/.config/c2c-client/projects/<basename>-<sha256(abs-path)[:12]>/` (keys, `identity.json`, `contacts.json`, `name.txt`, `listener.pid`) — keyed on the project root resolved by `c2c::_project_root`: `CLAUDE_PROJECT_DIR` if the harness set it, else `git rev-parse --show-toplevel`, else `$PWD`. The git-toplevel step is what keeps the slug **stable when Claude `cd`s into subfolders mid-session** — keying on raw `$PWD` moved the identity dir on every cd and silently detached keys/contacts/listener (SDK-CLI child sessions never set `CLAUDE_PROJECT_DIR`). `git` is not in `ensure_tools`' required set, so a missing git / non-repo `$PWD` fails closed to `$PWD`. The mediator `config.json` (url/token/wait) stays in the **global** dir and is shared across projects; `_write_config` in `config.sh` mkdirs `dirname "$C2C_CONFIG_FILE"`, not `$C2C_DIR`. An explicit `C2C_DIR` env overrides everything (identity + config under it) — this is the escape hatch the bash tests use. Regression suite: `tests/client/identity-dir.test.ts`.
- Slash commands are `commands/peer-*.md` — each is a thin wrapper that invokes the matching `scripts/*.sh`. **Always reference slash commands by their fully qualified name `/c2c-client:peer-*`** in docs, prompts, and other commands (see commit `b6a1049`); plain `/peer-*` breaks when multiple plugins are installed.
- **Delivery = `listen.sh` as an `asyncRewake` hook** on SessionStart + Stop (`hooks/hooks.json`, `timeout: 86400`), NOT a Monitor. The harness wakes the model only on **exit 2** (feeding it stderr if non-empty, else stdout); exit 0 / timeout kill are invisible. So `listen.sh` must stay silent until mail or a new pair request arrives, then print the framed batch, ack, `exit 2`; the next Stop re-arms it. stderr is muted (`exec 2>/dev/null`) — any noise there would replace the letter; mutex/takeover paths `exit 0` silently; delivered pair-request ids persist in `$C2C_DIR/seen_pair_requests` (the process dies after each delivery). Monitor was dropped because its 30-min cap made every re-arm a visible tool call + model turn — don't bring it back. In **headless** sessions the long-poll hangs the session: `claude -p` runs asyncRewake hooks **synchronously**, and any `--output-format stream-json` session (SDK / Conveyor chat mode, with or without `-p`/`--input-format`; CLI 2.1.289) never reaches `system/init` while the SessionStart listener runs. So `c2c::session_is_print_mode` (nearest `claude` ancestor's argv: `-p`/`--print` or `--output-format[=]stream-json`, override `C2C_PRINT_MODE=1|0`) makes `listen.sh` exit 0 and `stop-hook.sh` drain the inbox instead; outside headless mode `stop-hook.sh` exits at once (draining too would double-deliver). When editing `stop-hook.sh` or `listen.sh`, preserve the security-frame wrapping (`<<<UNTRUSTED_PEER_MESSAGE>>>` + the 6 rules) on any code path that puts message bodies into Claude's context. Tests that run the real `listen.sh` must pin `C2C_PRINT_MODE: '0'` — otherwise they inherit the headless-ness of whatever `claude` runs vitest (e.g. a stream-json chat session) and pass vacuously or fail. Regressions: `tests/client/listener-rewake.test.ts`.
- **Single-listener mutex + window takeover** (`common.sh` → `c2c::listener_*`). Only one listener may run per identity (a second races the same unacked inbox → double delivery). `listener.pid` stores `PID SESSION_ID WINDOW_ID` (empty session id written as `-`, else `read` collapses the fields; written via temp+`mv` so the Stop hook never reads a half-written file). Owner is the **window**, not the session: `c2c::window_id` = `<pid>.<start-token>` of the OUTERMOST `claude` ancestor (ppid walk, ≤`C2C_MAX_ANCESTRY_DEPTH`=12; match anchored on argv[0], or argv[1] for `node`/`bun` launchers; start token = source tag + 8 hex: `p` = `/proc/PID/stat` field 22 (boot ticks — `lstart` shifts with `TZ` and clock steps), `l` = macOS fallback `TZ=UTC LC_ALL=C ps -o lstart=`; `c2c::_same_window` treats same pid + different tag/format (incl. untagged pre-0.5.9 tokens) as the same window, so an upgrade or a process without `/proc` never self-takes-over; node/bun launchers matched on the first `C2C_LAUNCHER_ARG_SCAN`=12 args against `*/claude-code/cli.js`; both knobs are regex-validated — slice length is arithmetic, `a[$(cmd)]` would execute; cached only via `c2c::warm_window_id` at top level — every reader runs inside `$(...)`, where a cache set in the subshell is lost; `C2C_WINDOW_ID` overrides, and empty means "unknown"). `CLAUDE_CODE_SESSION_ID` rotates on `/clear`, `resume` and compaction while the window's listener survives — keying on it made every compaction read the window's own listener as `foreign` and take it over. Outermost, not nearest, so an SDK-child session doesn't kill its own window's listener. `c2c::listener_state` returns `none|dead|mine|foreign`: window ids both non-empty → equal = `mine`, else `foreign` (a dead recorded window = orphan, take it over); window id unresolvable → fall back to the session-id compare, and with no session id either → "never kill a live listener". `foreign` → `listen.sh` **takes it over** via `c2c::listener_takeover` (TERM→wait-for-death→KILL) then `listener_claim`s. `_pid_is_listener` (`ps -o args=` anchored on the path) guards PID reuse so a recycled PID is never signalled. `listen.sh` traps `INT/TERM` to `rm` its pid file **and exit** (cooperative stop for fast handoff). `stop-hook.sh` must test liveness via `c2c::listener_recorded_pid` + `_pid_is_listener` (never `cat` + `^[0-9]+$` — the multi-field line never matched, so every Stop deleted the live listener's pid file and the next start ran a second listener). Regressions: `tests/client/listener-takeover.test.ts`, `tests/client/listener-window.test.ts`.

## Marketplace / install

`.claude-plugin/marketplace.json` is the single source of truth for plugin discovery. After changing plugin version, run `pnpm bump` rather than hand-editing.
