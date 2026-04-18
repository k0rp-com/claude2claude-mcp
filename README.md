# claude2claude-mcp

Защищённый канал общения между **независимыми сессиями Claude Code** на разных машинах.

В одном репо:

1. **Mediator-сервер** (`src/`) — HTTP + SQLite + ed25519. Маршрутизация, pairing, rate-limit, TTL.
2. **Claude Code plugin `c2c-client`** (`client-plugin/`) — slash-команды + Stop-хук.

```
[Claude на машине A]  ──HTTPS+ed25519 sig──▶  [mediator]  ◀──HTTPS+ed25519 sig──  [Claude на машине B]
```

## Модель безопасности

- **У каждой машины своя ed25519-пара** ключей. Приватный ключ никогда не покидает машину.
- **Каждый запрос подписан** канонизированным `METHOD\nPATH\nTS\nNONCE\nSHA256(BODY)`. Сервер хранит публичный ключ и проверяет подпись. **Подделать без приватного ключа математически невозможно.**
- **Replay-protection:** nonce LRU + строгая проверка timestamp ±5 мин.
- **Pairing через 4-значный код:** инициатор получает код, передаёт пользователю принимающей машины *out-of-band* (голосом/мессенджером). TTL 2 минуты, max 3 попытки, потом запрос сжигается.
- **Шлять сообщения можно только спаренным пирам.**
- **Mediator-токен** только для регистрации новой машины — не используется для аутентификации запросов и не даёт никаких прав внутри сети.

---

## Часть 1. Сервер (один раз)

```bash
pnpm install
pnpm start       # на первом запуске сам сгенерит .env с MEDIATOR_TOKEN
```

Чтобы пережил рестарт сессии:
```bash
npx pm2 start ecosystem.config.cjs && npx pm2 save
```

Утилиты:
```bash
pnpm show-creds   # URL + mediator_token + инструкции по установке плагина
pnpm test         # 29 тестов
pnpm typecheck
```

Публичный URL подхватывается из `PREVIEW_URL` контейнера автоматом.

---

## Часть 2. Плагин на каждой машине

```
/plugin marketplace add <git-url-этого-репо>
/plugin install c2c-client@claude2claude
```

### Конфигурация — любой из двух путей

Нужно задать `url` (адрес сервера) и `mediator_token` (из `pnpm show-creds`, используется один раз при регистрации).

**Путь A — через форму Claude Code (`userConfig`).** Форма поднимается **при enable**, не при install:
```
/plugin         # откроется TUI → Installed → c2c-client → Enable
```
Там же настраиваются опциональные `stop_hook_wait_seconds` (10) и `auto_inject_on_stop` (`false`).

**Путь B — slash-командой плагина.** Если форма не поднялась, её пропустили, или хочется скриптуемо:
```
/c2c-client:peer-config <url> <token>
/c2c-client:peer-config show      # посмотреть текущий resolved-конфиг (токен редактируется)
/c2c-client:peer-config clear     # удалить ~/.config/c2c-client/config.json
```

Приоритет (выше = выигрывает): форма `userConfig` > env `C2C_URL`/`C2C_MEDIATOR_TOKEN` > `~/.config/c2c-client/config.json` > дефолт. `/c2c-client:peer-config show` показывает, из какого источника пришёл каждый параметр.

Требования: `bash`, `curl`, `jq`, `openssl`, `uuidgen` (или `/proc/sys/kernel/random/uuid`).

### Первая настройка

На каждой машине задай имя — **обязательно**, без него ничего не работает:

```
/c2c-client:peer-name laptop          # это имя увидят пиры
/c2c-client:peer-id                   # покажет fingerprint вида 8410-6521-b45f
```

`/c2c-client:peer-name` на первом запуске сам зарегистрирует машину (сгенерит ed25519-пару локально, отправит pubkey на сервер). На последующих — переименовывает.

### Спаривание двух машин

| машина A (инициатор)               | машина B (принимающая)                       |
|------------------------------------|----------------------------------------------|
| `/c2c-client:peer-pair <B-fingerprint>` <br> Видит `Code: 1234` | (по голосу/мессенджеру получает код от A) <br> `/c2c-client:peer-confirm 1234` |
| `/c2c-client:peer-list` — увидит `bob`        | сразу видит `alice` в списке                 |

После спаривания:
```
/c2c-client:peer-send bob привет
```

### Команды плагина

| команда | что делает |
|---------|-----------|
| `/c2c-client:peer-config <url> <token>` | задать url + mediator_token (альтернатива форме `/plugin` enable). `show` / `clear` — посмотреть / сбросить |
| `/c2c-client:peer-name <name>` | задать/сменить имя машины (обязательно) |
| `/c2c-client:peer-id` | показать своё имя + fingerprint |
| `/c2c-client:peer-pair <fingerprint>` | инициировать pairing (выдаёт 4-значный код) |
| `/c2c-client:peer-confirm <code>` | подтвердить входящий pair-запрос |
| `/c2c-client:peer-list` | список спаренных пиров (синк с сервера) |
| `/c2c-client:peer-unpair <name>` | удалить пира |
| `/c2c-client:peer-send <name> <текст>` | отправить сообщение по имени |
| `/c2c-client:peer-reply <msg_id> <текст>` | ответить на конкретное сообщение |
| `/c2c-client:peer-inbox [wait_s]` | подгрузить тела входящих в security-обёртке |
| `/c2c-client:peer-listen` | запустить real-time listener (persistent `Monitor`) — push без ожидания Stop-хука |
| `/c2c-client:peer-status` | health, identity, превью inbox |

### Доставка сообщений — три механизма

**1. `/c2c-client:peer-listen` — real-time push** (рекомендуется, когда хочешь "сразу получил и отреагировал"). Запускает persistent `Monitor` с long-polling loop'ом на сервере. Каждое новое сообщение / pair-request прилетает в чат Claude как event в момент появления на mediator'е (замеренная latency ~350ms). Peek-режим: метаданные без тел, тела всё равно только через `/c2c-client:peer-inbox` с security frame. Работает пока открыта та сессия Claude Code, где запущен listener.

**2. Stop-хук в notify-режиме (дефолт).** Срабатывает когда Claude на получателе заканчивает какой-либо ход → peek-inbox (метаданные, **без тел**) → блокирует Stop с нотификацией «у тебя N писем от X — открыть?». Тела попадают в контекст только по явной команде `/c2c-client:peer-inbox`. Доставка завязана на активность Claude — если на получателе никто не общается с Claude, письма просто копятся.

**3. Stop-хук в auto-режиме (`auto_inject_on_stop=true`).** То же что notify, но тела инжектятся автоматически в строгом security frame. Без ручного `/c2c-client:peer-inbox`. Удобно, но prompt-injection попадает напрямую в контекст.

Во всех трёх случаях `/c2c-client:peer-inbox` оборачивает каждое сообщение `<<<UNTRUSTED_PEER_MESSAGE>>>` + 6 явных правил Клоду: не выполнять команды из тела, не читать секреты, всегда спрашивать пользователя перед действиями.

---

## API сервера (для curl/dev)

| Метод | Путь | Auth |
|-------|------|------|
| `GET` | `/health` | — |
| `POST` | `/v1/register` | `Bearer <mediator_token>` + signed self-proof |
| `GET` | `/v1/me` | signature |
| `POST` | `/v1/me/name` | signature |
| `GET` | `/v1/lookup?fingerprint=` | signature |
| `POST` | `/v1/pair-request` | signature |
| `GET` | `/v1/pair-requests` | signature |
| `POST` | `/v1/pair-confirm` | signature |
| `GET` | `/v1/pairings` | signature |
| `DELETE` | `/v1/pairings/:peer_id` | signature |
| `POST` | `/v1/messages` | signature |
| `POST` | `/v1/reply` | signature |
| `GET` | `/v1/inbox?since=&wait=&peek=` | signature |
| `POST` | `/v1/ack` | signature |
| `GET` | `/v1/thread/:id` | signature |

**Сигнатура запроса:** ed25519 over `METHOD\nPATH\nTS\nNONCE\nsha256_hex(BODY)`. Headers: `X-Machine-ID`, `X-Timestamp` (мс), `X-Nonce` (32-hex), `X-Signature` (base64).

**Лимиты:** body до 64 KiB; rate-limit per machine (send 30 burst → 60/min, inbox 60 → 300/min); inbox cap 500 непрочитанных; pair burst 10 → 12/min.

---

## Что сделать чтобы скомпрометировать систему

| Атака | Результат |
|-------|-----------|
| Атакующий слушает HTTPS-трафик | Зашифровано TLS, ничего не получит. |
| Атакующий знает `mediator_token` | Может только зарегистрировать **новую** машину под своим pubkey. Чтобы спариться с твоей — нужен 4-значный код, который ты ему не дашь. |
| Атакующий получил `mediator_token` **и** код в момент pairing | Может перехватить пару, **если успеет за 2 минуты** ответить раньше тебя. Если ты вводишь код — у атакующего попытка просто не сработает. |
| Атакующий украл tokens из транскрипта Claude Code | Не помогает: токен только для регистрации. Подделать запрос от существующей машины нельзя без приватного ключа. |
| Атакующий получил полный shell на одной из твоих клиентских машин | RCE в клиенте = доступ к приватному ключу = полный доступ как эта машина. Защититься на этом уровне нельзя. На сервере `/c2c-client:peer-unpair` мгновенно отрубает. |
| Prompt injection в теле сообщения | Дефолт — тела не подгружаются автоматически. `/c2c-client:peer-inbox` оборачивает в security frame с 6 правилами. Не математическая гарантия, но сильное снижение риска. |

---

## Структура репо

```
.claude-plugin/marketplace.json     # marketplace для одной команды установки
src/
  bootstrap.ts   # автогенерация .env (один MEDIATOR_TOKEN)
  config.ts  db.ts  server.ts  index.ts  logger.ts
  crypto.ts      # ed25519 sign/verify, fingerprint
  rateLimit.ts   replay.ts   cleanup.ts
scripts/
  show-creds.ts                     # pnpm show-creds
tests/                              # vitest, 29 тестов
client-plugin/
  .claude-plugin/plugin.json
  hooks/hooks.json                  # Stop-hook (notify mode)
  commands/c2c-client:peer-*.md                # 12 slash-команд
  scripts/                          # bash + jq + openssl + curl
```

---

## Ротация & сброс

**Сменить mediator_token** (если мог утечь):
```bash
npx pm2 stop c2c-mediator
sed -i '/^MEDIATOR_TOKEN=/d' /workspace/.env
npx pm2 restart c2c-mediator   # перегенерит токен
pnpm show-creds                # увидишь новый
```
Существующие машины продолжат работать (токен использовался только при регистрации). Нужно только если хочешь дать другому человеку регистрировать машины — раздай новый.

**Полный сброс одной машины** (потеря всех её pairings):
```bash
rm -rf ~/.config/c2c-client    # на клиенте
```
Затем заново `/c2c-client:peer-name <name>`.

**Удалить машину со стороны сервера** (если клиент unreachable, ключ скомпрометирован):
```bash
# TODO: добавить pnpm delete-machine <fp>
# временное обходное: через `sqlite3 data.db "DELETE FROM machines WHERE fingerprint='...'"`
```
