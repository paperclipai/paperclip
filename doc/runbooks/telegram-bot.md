# Runbook — paperclip-tg-bot

Тонкий Telegram-клиент для CEO ([THE-341](https://paperclip.thethirdchair.ru/THE/issues/THE-341)).
Запускается отдельным systemd-юнитом рядом с `tg_paperclip.service` на той же VM
(`paperclip.thethirdchair.ru`), общается с Paperclip server по `http://localhost:3100`
и слушает приватный internal API на `:3110` для callback'а от
`POST /api/users/me/telegram-link`.

## Архитектура

```
@BotFather  ─────────►  paperclip-tg-bot.service  ◄──────┐
                              │                          │
                              ├─► Paperclip API :3100    │  X-Internal-Secret
                              │   (Bearer = bot API key) │
                              │                          │
                              └─► :3110 /internal/resolve-code  ◄── tg_paperclip.service
```

- Inbound (THE-343): `/login`, `/task`, `/issue`, `/approve`, `/deny`, reply-to-comment.
- Outbound notifier (THE-344): поллер раз в `NOTIFIER_INTERVAL_MS` (default 30s) шлёт
  Динару high-signal события: pending interactions, pending approvals,
  blocked-with-unblock-owner=Dinar, completed-by-Dinar.

## Stage 1 — первый деплой (inbound-only)

Этот этап развёртывает бота без outbound-нотификаций. После того как Динар прогонит
`/login` и привяжется через Profile UI, делаем Stage 2 — добавляем `DINAR_USER_ID`
и `DINAR_TG_CHAT_ID` в env, рестартим юнит.

### 1. Сборка пакета (на VM, под `paperclip`)

```bash
cd /opt/paperclip
git log --oneline -3   # ожидается: THE-344, THE-343 локальными форк-коммитами
pnpm install --filter @paperclipai/telegram-bot
pnpm --filter @paperclipai/telegram-bot build
pnpm --filter @paperclipai/telegram-bot test    # 43/43 passing
```

### 2. Получить bot token и сгенерить bot-API-key

- TELEGRAM_BOT_TOKEN: Динар создаёт бота через @BotFather и присылает токен. После этого
  выполняет `/setcommands` со списком из README.
- PAPERCLIP_BOT_API_KEY: создать в Paperclip Admin UI → Service Accounts → New API Key,
  scope: `comments:create, issues:create, approvals:resolve, issues:read, interactions:read`.
  Записать однократно — позже не показывается.
- TELEGRAM_BOT_INTERNAL_SECRET: `openssl rand -hex 32`. Один и тот же секрет нужен
  и в `/etc/paperclip/telegram-bot.env`, и в `/opt/paperclip/.env` (см. шаг 4).

### 3. Создать `/etc/paperclip/telegram-bot.env` (root)

```bash
sudo install -d -m 0755 -o root -g root /etc/paperclip
sudo cp /opt/paperclip/packages/telegram-bot/.env.example /etc/paperclip/telegram-bot.env
sudo chown root:paperclip /etc/paperclip/telegram-bot.env
sudo chmod 0640 /etc/paperclip/telegram-bot.env
sudoedit /etc/paperclip/telegram-bot.env  # заполнить реальные значения
```

Обязательно для Stage 1: `TELEGRAM_BOT_TOKEN`, `PAPERCLIP_BOT_API_KEY`,
`TELEGRAM_BOT_INTERNAL_SECRET`. Остальное — defaults из `.env.example`.

### 4. Дописать backend env (paperclip server)

```bash
sudo -u paperclip tee -a /opt/paperclip/.env <<'EOF'
TELEGRAM_BOT_INTERNAL_URL=http://localhost:3110
TELEGRAM_BOT_INTERNAL_SECRET=<тот же hex что в /etc/paperclip/telegram-bot.env>
EOF
sudo systemctl restart tg_paperclip
journalctl -u tg_paperclip -n 20 --no-pager
```

### 5. Создать stateful directory (root)

```bash
sudo install -d -m 0755 -o paperclip -g paperclip /var/lib/paperclip-tg-bot
```

### 6. Установить и запустить systemd-юнит (root)

```bash
sudo install -m 0644 /opt/paperclip/docker/systemd/paperclip-tg-bot.service \
    /etc/systemd/system/paperclip-tg-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-tg-bot
sudo systemctl status paperclip-tg-bot --no-pager
journalctl -u paperclip-tg-bot -n 30 --no-pager -f
```

Ожидаемые логи:
- `[paperclip-tg-bot] starting (telegraf v...)`
- `[paperclip-tg-bot] internal-server listening on :3110`
- `[paperclip-tg-bot] telegram polling started`
- Notifier должен сказать `disabled (DINAR_USER_ID / DINAR_TG_CHAT_ID not set)` — это норма для Stage 1.

### 7. Smoke (Stage 1)

| Шаг | Ожидаемое |
|-----|-----------|
| Динар → `/login` боту | Бот вернул 6-значный код. |
| Динар вставил код в Profile → Telegram | UI показал `linked=true`. |
| `select telegramChatId, telegramUserId from auth_users where ...` | chat_id записан. |
| `/task купить кофе` | Создалась issue, `assigneeAgentId = CEO_AGENT_ID`. |
| `/issue THE-XXX` | Бот вернул статус и последний коммент. |
| Reply на любое сообщение бота | Если в ReplyStore есть запись — пост станет комментом. На Stage 1 ReplyStore пуст (его наполняет notifier), так что reply ответит "не понял к чему". |

## Stage 2 — включить outbound notifier

```bash
# Узнать UUID Динара и chat_id (через psql или admin endpoint):
#   select id as dinar_user_id, telegramChatId as dinar_chat_id
#   from auth_users where email = 'dinar@...'

sudoedit /etc/paperclip/telegram-bot.env
# заполнить:
#   DINAR_USER_ID=<uuid>
#   DINAR_TG_CHAT_ID=<chatId>
sudo systemctl restart paperclip-tg-bot
journalctl -u paperclip-tg-bot -n 50 --no-pager
```

Ожидаемые логи:
- `[paperclip-tg-bot] notifier enabled (interval 30000ms)`
- `[notifier] poll OK pending=N approvals=M blocked=K done=L`

Smoke (Stage 2 — должны проходить все 7 пунктов из THE-345):

- [ ] `/login` от Динара → код → линковка через Profile → `linked=true` (уже сделано в Stage 1)
- [ ] `/task купить кофе` → issue с ассигни=CEO (Stage 1)
- [ ] CEO в heartbeat увидел задачу и затриажил
- [ ] Тест approval → Динар получил TG-сообщение → `/approve <id>` → approval=approved
- [ ] interaction `ask_user_questions` от агента (requester=Динар) → TG-нотификация → reply → коммент в issue
- [ ] issue blocked + unblock_owner=Динар → нотификация
- [ ] issue done + author=Динар → нотификация с summary

## Эксплуатация

### Логи

```bash
journalctl -u paperclip-tg-bot -f                   # follow live
journalctl -u paperclip-tg-bot --since "1 hour ago"
journalctl -u paperclip-tg-bot -p err               # только errors
```

### Рестарт после правки env

```bash
sudoedit /etc/paperclip/telegram-bot.env
sudo systemctl restart paperclip-tg-bot
```

### Ребилд после `git pull`

```bash
cd /opt/paperclip
sudo -u paperclip git pull       # либо cherry-pick локальных форк-коммитов
sudo -u paperclip pnpm install --filter @paperclipai/telegram-bot
sudo -u paperclip pnpm --filter @paperclipai/telegram-bot build
sudo systemctl restart paperclip-tg-bot
```

### Ротация bot-API-key

1. Paperclip Admin UI → Service Accounts → создать новый ключ.
2. `sudoedit /etc/paperclip/telegram-bot.env` — обновить `PAPERCLIP_BOT_API_KEY`.
3. `sudo systemctl restart paperclip-tg-bot`.
4. Старый ключ revoke в UI после проверки логов на 401.

### Ротация internal-secret

1. `openssl rand -hex 32`.
2. Обновить **оба** файла одновременно: `/etc/paperclip/telegram-bot.env`
   и `/opt/paperclip/.env`.
3. `sudo systemctl restart paperclip-tg-bot tg_paperclip` — порядок не важен,
   /login будет недоступен в момент рестарта (~10 секунд).

### Очистка dedup-файла

Notifier хранит `seen.json` с id уже отправленных нотификаций. Если он распухает
или нужно повторно прогнать smoke:

```bash
sudo systemctl stop paperclip-tg-bot
sudo -u paperclip rm /var/lib/paperclip-tg-bot/seen.json
sudo systemctl start paperclip-tg-bot
```

После старта пустой dedup → notifier пошлёт все актуальные pending-события заново.
Нормально только в smoke; в проде не делать без причины — заспамите CEO.

## Troubleshooting

| Симптом | Диагностика | Фикс |
|---------|-------------|------|
| `Telegram bot integration is not configured` при `/login` от UI | Backend не видит `TELEGRAM_BOT_INTERNAL_URL`/`SECRET`. | Проверить `/opt/paperclip/.env`, рестарт `tg_paperclip`. |
| `401 unauthorized` в логах бота | `PAPERCLIP_BOT_API_KEY` неверный/revoked. | Создать новый ключ, обновить env, рестарт. |
| `Missing required env var: TELEGRAM_BOT_TOKEN` | Юнит стартует до того как env подхватился. | Проверить `EnvironmentFile=` и chmod 640. |
| `/login` отдаёт код, но Profile UI получает 404 | Между ботом и backend разные `TELEGRAM_BOT_INTERNAL_SECRET`. | Сверить хеши, обновить, рестартить оба сервиса. |
| Notifier не шлёт ничего, но pending-events есть | `DINAR_USER_ID` не выставлен (Stage 1). | Перейти на Stage 2. |
| Notifier шлёт дубли при рестарте | `NOTIFIER_DEDUP_FILE` недоступен или не writable. | `chown paperclip:paperclip /var/lib/paperclip-tg-bot`. |

## Связанные тикеты

- [THE-341](/THE/issues/THE-341) — головная фича
- [THE-342](/THE/issues/THE-342) — DB-миграция и Profile UI
- [THE-343](/THE/issues/THE-343) — скелет бота + 5 команд
- [THE-344](/THE/issues/THE-344) — outbound notifier
- [THE-345](/THE/issues/THE-345) — этот runbook + деплой
- [THE-346](/THE/issues/THE-346) — server-side фильтрация для notifier
