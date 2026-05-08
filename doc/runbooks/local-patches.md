# Local patches — paperclip-instance (paperclip.thethirdchair.ru)

Этот файл — реестр патчей, применённых **локально** на self-hosted paperclip-instance,
которые не смержены (или ещё не смержены) в upstream `paperclipai/paperclip`.

Источник правды деплоя: `/opt/paperclip` на хосте `paperclip.thethirdchair.ru` (193.233.211.200).
Ветка: `master` (local fork, ahead of `origin/master`).
Сервис: `tg_paperclip.service` (systemd, user `paperclip`).
БД: embedded postgres `/home/paperclip/.paperclip/instances/default/db` (порт 54329).

## Применённые patches

| Дата | Commit | Issue | Описание | Upstream PR |
|------|--------|-------|----------|-------------|
| 2026-05-08 | `17be95e7` | [THE-342](https://paperclip.thethirdchair.ru/THE/issues/THE-342) | Telegram link API (`GET/POST/DELETE /api/users/me/telegram-link`) + `0071_telegram_link_columns.sql` миграция (`user.telegram_chat_id/_user_id/_username` + UNIQUE `telegram_chat_id`) + Profile UI секция | [paperclipai/paperclip#5493](https://github.com/paperclipai/paperclip/pull/5493) |
| 2026-05-08 | `a4390b92` | [THE-346](https://paperclip.thethirdchair.ru/THE/issues/THE-346) | Server-side filters: `requestedByUserId` на `GET /api/companies/:cid/approvals` (с `=me` shortcut, 403 для non-board); `createdByUserId` на `GET /api/companies/:cid/issues` | (нет — local-only) |
| 2026-05-08 | `b5132a5b` | [THE-343](https://paperclip.thethirdchair.ru/THE/issues/THE-343) | `packages/telegram-bot/` скелет: 5 команд (`/login`, `/task`, `/issue`, `/approve`, `/deny` + reply→comment), internal-server `/internal/resolve-code`, CodeStore + ReplyStore, 21 тест | (нет — local-only) |
| 2026-05-08 | `799f9bb4` | [THE-344](https://paperclip.thethirdchair.ru/THE/issues/THE-344) | Outbound notifier: 30s poller, 4 шаблона (interaction / approval / blocked / done), JSON file dedup, server-side filtering по THE-346 + client-side defense-in-depth, 22 теста (43/43 total) | (нет — local-only) |
| 2026-05-08 | `49c83868` | [THE-345](https://paperclip.thethirdchair.ru/THE/issues/THE-345) | Deploy artefacts: `docker/systemd/paperclip-tg-bot.service`, `packages/telegram-bot/.env.example`, `doc/runbooks/telegram-bot.md` (Stage 1/2 flow). Не модифицирует server-код. | (нет — local-only) |

Применил: SRE Agent (`sre@thethirdchair.ru`).
Релиз trigger: [THE-347](https://paperclip.thethirdchair.ru/THE/issues/THE-347).

## Стандартный flow применения local-patch

```bash
# 1. Получить патч
cd /opt/paperclip
git fetch origin                          # синк апстрима
# применить patch (cherry-pick, git am, или прямой commit с подписью SRE Agent)
git cherry-pick <sha>                     # либо
# (вариант) git apply ../patches/THE-XXX.patch && git add -A && git commit ...

# 2. Зависимости (если изменились)
sudo -u paperclip pnpm install --frozen-lockfile=false

# 3. Миграции БД
sudo -u paperclip pnpm --filter @paperclipai/db build
sudo -u paperclip pnpm --filter @paperclipai/db run migrate
# Альтернатива: ручной psql запуск файла миграции
# PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -f packages/db/src/migrations/0071_*.sql

# 4. Сборка
sudo -u paperclip pnpm --filter @paperclipai/shared build
sudo -u paperclip pnpm --filter @paperclipai/db build
sudo -u paperclip pnpm --filter @paperclipai/adapter-utils build
sudo -u paperclip pnpm --filter @paperclipai/mcp-server build
sudo -u paperclip pnpm --filter @paperclipai/server build

# 5. Restart
systemctl restart tg_paperclip.service
systemctl status tg_paperclip.service

# 6. Smoke
curl -s http://127.0.0.1:3100/api/health
# проверка нового endpoint'а — 401 без auth (вместо 404)
curl -sw "\nHTTP %{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{"code":"123456"}' http://127.0.0.1:3100/api/users/me/telegram-link
# ожидается: {"error":"Board authentication required"} HTTP 401

# 7. Логи 5 минут
tail -f /home/paperclip/.paperclip/instances/default/logs/server.log | \
  grep -E '"level":"(error|fatal)"|ERROR|FATAL'
```

## Rollback

Если patch вызвал regression:

```bash
cd /opt/paperclip

# 1. Найти проблемный commit
git log --oneline -10

# 2. Revert (не reset — local-fork часто живёт без push, reset потеряет историю)
git revert <sha>

# 3. Если revert конфликтует — вручную откатить файлы и закоммитить
# 4. Rebuild + restart как в стандартном flow выше (шаги 4–7)

# 5. БД-миграция: rollback требует ручного down-скрипта.
#    Для telegram_link_columns: ALTER TABLE "user" DROP COLUMN ... + DROP CONSTRAINT.
#    БЕЗ rollback миграции колонки сохранятся, но это idempotent — повторный
#    apply того же patch'а не сломается.

# 6. Обновить эту таблицу — пометить commit как REVERTED <дата>.
```

## Acceptance check (после каждого apply)

- [ ] `git log --oneline | head -3` показывает применённый commit
- [ ] Соответствующая миграция в `packages/db/src/migrations/` существует
- [ ] Колонки/индексы в БД присутствуют (`psql ... \d <table>`)
- [ ] `curl http://127.0.0.1:3100/api/health` → 200 `{"status":"ok"}`
- [ ] Новый endpoint отвечает 401 (вместо 404) без auth — значит роут зарегистрирован
- [ ] Логи чистые 5 минут — no `level:error|fatal`, no `ERROR/FATAL` в text-логах
- [ ] Запись в этой таблице обновлена

## Замечания

- Коммиты local-fork подписываются `SRE Agent <sre@thethirdchair.ru>` для отделения
  от upstream-коммитов.
- `origin/master` на `paperclipai/paperclip` — публичный апстрим. **Не push'им local-fork commits**
  (без явного board-разрешения), они остаются только в `/opt/paperclip` working tree.
- При обновлении upstream (`git pull origin master`) делается merge, не rebase, чтобы
  сохранить local-fork commits.
