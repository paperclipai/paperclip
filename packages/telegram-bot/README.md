# @paperclipai/telegram-bot

Тонкий Telegram-клиент поверх Paperclip API. Принимает команды от Динара (CEO),
создаёт issues и approvals от его имени, отвечает в треды через replies.

Покрывает обе половины спеки [THE-341](https://paperclip.thethirdchair.ru/THE/issues/THE-341):
- **Inbound** ([THE-343](https://paperclip.thethirdchair.ru/THE/issues/THE-343)) — команды Динара, login, replies в треды.
- **Outbound notifier** ([THE-344](https://paperclip.thethirdchair.ru/THE/issues/THE-344)) — `src/notifier/` поллит Paperclip раз в 30s и шлёт high-signal события: pending interactions, pending approvals, blocked unblock-owner=Динар, done создание Динара. Дедуп через JSON-файл, фильтрация server-side по контракту [THE-346](https://paperclip.thethirdchair.ru/THE/issues/THE-346) (`createdByUserId` / `touchedByUserId` / `requestedByUserId`).

## Команды

| Команда | Что делает |
|---------|-----------|
| `/login` | Генерит 6-значный код (TTL 10 мин), просит вставить его в Profile → Telegram. |
| `/task <текст>` | Создаёт issue с `assigneeAgentId=CEO`. Авторство резолвится сервером по `X-Telegram-Chat-Id`. |
| `/issue <ID>` | Показывает статус, ассигни и последний комментарий. |
| `/approve <approval-id>` | `POST /api/approvals/:id/approve`. |
| `/deny <approval-id>` | `POST /api/approvals/:id/reject`. |
| Reply на нотификацию | Постит текст ответа как комментарий в issue, на которую ссылалась нотификация. |

In-memory state бота:

- `CodeStore` — `Map<code, {chatId, tgUserId?, tgUsername?, expiresAt}>`. Выдаёт коды для `/login`, отдаёт серверу через `/internal/resolve-code`.
- `ReplyStore` — `Map<chatId:messageId, {issueId}>`. Notifier-демон должен наполнять эту мапу при отправке высокосигнальных сообщений.

## Setup (local dev)

```bash
cd paperclip
pnpm install
pnpm --filter @paperclipai/telegram-bot build

# Создать env
cat > packages/telegram-bot/.env <<'EOF'
TELEGRAM_BOT_TOKEN=...           # @BotFather → New Bot
PAPERCLIP_API_URL=http://localhost:3100
PAPERCLIP_BOT_API_KEY=...        # см. ниже
PAPERCLIP_COMPANY_ID=45cd7642-53da-4c19-82bd-58e8e03cf452
TELEGRAM_BOT_INTERNAL_SECRET=$(openssl rand -hex 32)
TELEGRAM_BOT_INTERNAL_PORT=3110
# Опционально:
CEO_AGENT_ID=262a08ea-c041-4af7-a310-e2a0fedc8348
# Outbound notifier (включается только если оба заданы):
DINAR_USER_ID=...                # uuid из auth_users
DINAR_TG_CHAT_ID=...              # chat_id (после /login → ProfileSettings → Telegram link)
NOTIFIER_INTERVAL_MS=30000        # default 30000
# NOTIFIER_DEDUP_FILE=/var/lib/paperclip-tg-bot/seen.json   # default ~/.local/share/paperclip-tg-bot/seen.json
EOF

# Backend env (paperclip server) должен знать секрет:
# TELEGRAM_BOT_INTERNAL_URL=http://localhost:3110
# TELEGRAM_BOT_INTERNAL_SECRET=<тот же>

# Запуск
pnpm --filter @paperclipai/telegram-bot start
```

### Bot API key

В Paperclip UI: **Admin → Service Accounts → New API Key** (или через CLI). Ключ должен
иметь права на запись в issues/approvals компании. После генерации сохрани в env как
`PAPERCLIP_BOT_API_KEY` и **больше не показывай**.

### BotFather: команды

После создания бота через @BotFather, выполни `/setcommands` и вставь:

```
login - выдать 6-значный код для линковки с Paperclip-профилем
task - создать issue: /task <текст>
issue - показать issue: /issue <ID>
approve - одобрить approval: /approve <id>
deny - отклонить approval: /deny <id>
```

## Internal API

```
GET /internal/resolve-code?code=<6-digit>
Headers: X-Internal-Secret: <TELEGRAM_BOT_INTERNAL_SECRET>

200 OK → { tgChatId, tgUserId, tgUsername }   # код потребляется
401 Unauthorized → { error: "unauthorized" }
404 Not Found → { error: "code not found or expired" }
```

Сервер вызывает этот endpoint из `POST /api/users/me/telegram-link` (см.
[THE-342](/THE/issues/THE-342)) — обмен `code → tgChatId` и запись в `auth_users`.

## Тесты

```bash
pnpm --filter @paperclipai/telegram-bot test
```

Покрывают:

- code-store TTL и одноразовость
- paperclip-client (`/task`, `/issue`, `/approve`, `/deny`) с моком fetch
- `X-Telegram-Chat-Id` и `Authorization: Bearer` заголовки
- internal-server `/internal/resolve-code` (real HTTP)
- end-to-end `/login` → backend resolve

## Production deploy

См. полный runbook в [`doc/runbooks/telegram-bot.md`](../../doc/runbooks/telegram-bot.md)
([THE-345](/THE/issues/THE-345)). Кратко: systemd-юнит
[`docker/systemd/paperclip-tg-bot.service`](../../docker/systemd/paperclip-tg-bot.service)
запускает `node dist/index.js` с env из `/etc/paperclip/telegram-bot.env`
(шаблон — [`.env.example`](./.env.example)). Деплой в две стадии:

1. **Stage 1 (inbound-only)** — без `DINAR_USER_ID`/`DINAR_TG_CHAT_ID`. Notifier
   автоматически выключается. Достаточно для проверки `/login`, `/task`, `/issue`,
   `/approve`, `/deny`.
2. **Stage 2 (outbound notifier)** — добавить `DINAR_USER_ID` (uuid из `auth_users`)
   и `DINAR_TG_CHAT_ID` (chat_id записан после `/login`), рестарт юнита.

Логи: `journalctl -u paperclip-tg-bot -f`.
Рестарт: `sudo systemctl restart paperclip-tg-bot`.
