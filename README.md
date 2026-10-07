# claude2claude-mcp

Защищённый канал общения между **независимыми сессиями Claude Code** на разных машинах.

В одном репо:

1. **Mediator-сервер** (`src/`) — HTTP + SQLite + ed25519. Маршрутизация, pairing, rate-limit, TTL.
2. **Claude Code plugin `c2c-client`** (`client-plugin/`) — slash-команды + хуки (фоновый listener на `asyncRewake`).

```
[Claude на машине A]  ──HTTPS+ed25519 sig──▶  [mediator]  ◀──HTTPS+ed25519 sig──  [Claude на машине B]
```

## Модель безопасности

- **У каждой машины своя ed25519-пара** ключей. Приватный ключ никогда не покидает машину.
- **Каждый запрос подписан** канонизированным `METHOD\nPATH\nTS\nNONCE\nSHA256(BODY)`. Сервер хранит публичный ключ и проверяет подпись. **Подделать без приватного ключа математически невозможно.**
- **Replay-protection:** nonce LRU + строгая проверка timestamp ±5 мин.
- **Pairing через 6-значный код:** инициатор получает код, передаёт пользователю принимающей машины *out-of-band* (голосом/мессенджером). TTL 2 минуты, max 3 попытки, потом запрос сжигается.
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
pnpm show-creds              # URL + mediator_token + инструкции по установке плагина
pnpm delete-machine <fp|id>  # полная ревокация машины (машина + pairings + сообщения)
pnpm test                    # тесты
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

### Идентичность привязана к проекту

Каждый проект на машине автоматически получает **свою** идентичность пира — отдельную ed25519-пару, отдельный machine id на mediator, отдельные контакты и имя. Ключ привязки — **корень проекта**: идентичность лежит в `~/.config/c2c-client/projects/<slug-пути>/`, где `<slug>` = `<имя-папки>-<хэш-полного-пути>`. Корень определяется как `CLAUDE_PROJECT_DIR` (если его выставил харнесс), иначе корень git-репозитория (`git rev-parse --show-toplevel`), иначе текущий `$PWD`. Благодаря git-якорю идентичность **не меняется, когда Claude переходит по подпапкам внутри проекта** — иначе на каждом `cd` пир «терял» бы ключи и контакты. Разные проекты = разные пиры; переименование/перемещение самого корня проекта = новый пир (контакты придётся завести заново). `mediator url`/`token` при этом **общие** для всех проектов (лежат в `~/.config/c2c-client/config.json`), поэтому `/c2c-client:peer-config` достаточно выполнить один раз на машину.

`/c2c-client:peer-status` показывает, к какому проекту привязана текущая идентичность (строки `identity dir:` и `bound to:`).

Нужна одна общая идентичность на несколько проектов (или изоляция для тестов) — задай явный `C2C_DIR` в env: он перекрывает автопривязку и держит всё (включая config) в указанном каталоге.

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
| `/c2c-client:peer-pair <B-fingerprint>` <br> Видит `Code: 481920` | (по голосу/мессенджеру получает код от A) <br> `/c2c-client:peer-confirm 481920` |
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
| `/c2c-client:peer-pair <fingerprint>` | инициировать pairing (выдаёт 6-значный код) |
| `/c2c-client:peer-confirm <code>` | подтвердить входящий pair-запрос |
| `/c2c-client:peer-list` | список спаренных пиров (синк с сервера) |
| `/c2c-client:peer-unpair <name>` | удалить пира |
| `/c2c-client:peer-send <name> <текст>` <br> `/c2c-client:peer-send <name> --file <path>` | отправить сообщение по имени; `--file` — для длинных/спецсимвольных тел (см. ниже) |
| `/c2c-client:peer-reply <msg_id> <текст>` <br> `/c2c-client:peer-reply <msg_id> --file <path>` | ответить на конкретное сообщение |
| `/c2c-client:peer-inbox [wait_s]` | подгрузить тела входящих в security-обёртке |
| `/c2c-client:peer-listen` | показать, жив ли фоновый listener в этом окне (он армится хуками сам, запускать руками нечего) |
| `/c2c-client:peer-status` | health, identity, превью inbox |

### Доставка сообщений

**Фоновый listener (`asyncRewake`-хук).** `hooks/hooks.json` запускает `scripts/listen.sh` на `SessionStart` и на каждом `Stop` как хук с `asyncRewake: true` и `timeout: 86400`. Claude Code держит такой хук в фоне и будит модель **только** когда он выходит с кодом 2, отдавая ей stdout. Выход с кодом 0 и убийство по таймауту в чате не видны. Поэтому listener молчит, пока нет почты: long-poll `/v1/inbox?wait=25` в цикле, транзиентные ошибки пережидаются. Когда приходит письмо или pair-request, он печатает его в security frame, делает ack и выходит с кодом 2. Сессия просыпается (в терминале одна строка `📬 c2c: new peer mail`), модель обрабатывает письмо, и `Stop` в конце этого хода поднимает новый listener.

Раньше listener жил внутри `Monitor`. У Monitor жёсткий лимит 30 минут, а каждый перезапуск — видимый вызов инструмента плюс реплика модели. Отсюда «переподключения» в чате раз в полчаса, и промпт «перезапускай молча» это не лечил.

Контракт `listen.sh` (регрессии: `tests/client/listener-rewake.test.ts`):
- **stderr заглушён** (`exec 2>/dev/null`): при непустом stderr харнесс отдаёт модели stderr *вместо* stdout, и шум curl/jq заменил бы собой письмо;
- мьютекс/перехват (см. ниже) отрабатывают **молча** — `mine` → `exit 0`, `foreign` → тихий takeover;
- pair-request'ы не ack'аются сервером, а процесс завершается после каждой доставки, поэтому уже показанные id хранятся в `$C2C_DIR/seen_pair_requests`. Иначе каждый перезапуск будил бы модель тем же запросом;
- режим сессии определяет `c2c::session_mode` по argv ближайшего предка `claude` (override `C2C_SESSION_MODE=print|stream|live`, старый `C2C_PRINT_MODE=1|0`):
  - **`print`** — `claude -p` без stream-json ввода: Claude Code исполняет `asyncRewake`-хук синхронно, long-poll повесил бы сессию. Listener сразу выходит с кодом 0, почту доставляет `stop-hook.sh`: дренирует inbox в конце хода и блокирует Stop с телами в security frame.
  - **`stream`** — `--input-format stream-json` (чат конвейера, SDK; с `-p` или без): SessionStart-хук держит `system/init` до своего выхода, поэтому на SessionStart listener выходит сразу; а Stop-хук честно фоновый и будит сессию новым ходом (проверено на CLI 2.1.292) — listener взводится с конца первого хода и дальше работает как в интерактиве.
  - **`live`** — интерактив, listener на SessionStart и Stop.
  Вне `print` `stop-hook.sh` ничего не делает, иначе гонялся бы с listener'ом за одним inbox.

Если окно простояло без единого хода дольше таймаута хука, listener тихо умирает и поднимается на следующем `Stop`. Письма при этом не теряются, они ждут на сервере.

`asyncRewake`/`rewakeMessage`/`rewakeSummary` — поля схемы хуков Claude Code (проверено на 2.1.287). Старый CLI, не знающий `asyncRewake`, выполнил бы listener синхронно.

На одну идентичность (проект) держится **ровно один** listener — второй гонялся бы за тем же inbox и дублировал доставку. `listener.pid` хранит `PID SESSION_ID WINDOW_ID` владельца, где window id — pid самого верхнего процесса-предка `claude` плюс метка времени его старта (`274.c839039c`), то есть **окно** Claude Code. Владение ключуется именно на окне: `CLAUDE_CODE_SESSION_ID` ротируется при `/clear`, `resume` и компактификации, а фоновый listener их переживает. Listener того же окна повторно не поднимается, а `Stop` в **другом** окне **перехватывает** listener себе: старый (в т.ч. осиротевший от закрытого окна) останавливается TERM→KILL, и inbox начинает слушать текущее окно, то есть последнее активное. Если предка `claude` не видно, window id пуст и владение падает обратно на session id. Регрессии: `tests/client/listener-takeover.test.ts`, `tests/client/listener-window.test.ts`.

`/c2c-client:peer-inbox` подгружает тела вручную в той же обёртке `<<<UNTRUSTED_PEER_MESSAGE>>>` + 6 явных правил Клоду: не выполнять команды из тела, не читать секреты, всегда спрашивать пользователя перед действиями.

### Длинные / special-character сообщения

Inline-форма `/c2c-client:peer-send <name> <текст>` подставляется в bash через `"$ARGUMENTS"` — это нормально для коротких строк без кавычек и скобок, но ломается на `(`, `)`, `'`, `"`, бэктиках, переводах строк (а в zsh даже `(foo)` без кавычек ругается `invalid mode specification`). Для таких сообщений:

**вариант A — через файл** (рекомендуется для slash-команды):
```text
# Claude пишет тело в файл через Write tool, потом:
/c2c-client:peer-send bob --file /tmp/msg.txt
/c2c-client:peer-reply 01HF... --file /tmp/reply.md
```

**вариант B — через stdin** (когда Claude вызывает скрипт напрямую из своего Bash):
```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/send.sh" bob - <<'EOF'
любой текст — (скобки), 'кавычки', "и даже" $переменные,
переводы строк — всё уходит как есть.
EOF
```
`--stdin` — синоним `-`. Stdin от tty без пайпа отвергается, чтобы не зависнуть.

Body отдаётся серверу ровно как считан, **за исключением хвостовых `\n`** — они срезаются (стандарт `$(...)`-семантики, как у `git commit -F` / `gh pr create --body-file`).

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

**Лимиты:** body до 64 KiB; rate-limit per machine (send 30 burst → 60/min, inbox 60 → 300/min); inbox cap 500 непрочитанных; pair burst 10 → 12/min; одновременных long-poll на identity — `LONGPOLL_MAX_CONCURRENT` (дефолт 64; подними для тяжёлого веера сабагентов в одном проекте).

---

## Что сделать чтобы скомпрометировать систему

| Атака | Результат |
|-------|-----------|
| Атакующий слушает HTTPS-трафик | Зашифровано TLS, ничего не получит. |
| Атакующий знает `mediator_token` | Может только зарегистрировать **новую** машину под своим pubkey. Чтобы спариться с твоей — нужен 6-значный код, который ты ему не дашь. |
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
  hooks/hooks.json                  # SessionStart/Stop: контекст + asyncRewake-listener (+ Stop-дренаж для -p без stream-json ввода)
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
pnpm delete-machine <fingerprint>   # напр. 8410-6521-b45f (или machine id)
```
Это **полная** ревокация: удаляет саму машину, все её pairings и её сообщения в одной транзакции. Не делай `DELETE FROM machines` руками через `sqlite3` — оставшиеся pairings молча вернутся, если тот же ключ переregistрируется (machine id детерминирован из pubkey). Если ключ не скомпрометирован, а нужно просто разорвать связь — достаточно `/c2c-client:peer-unpair` на клиенте.
