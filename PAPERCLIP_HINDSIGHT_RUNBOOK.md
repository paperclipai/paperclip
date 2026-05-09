# Paperclip Hindsight + Ollama Runbook

**Хост:** `paperclip.thethirdchair.ru` (193.233.211.200, Aeza NL).
**Создано:** THE-393 (2026-05-08).

> **Внимание:** на этой же машине крутится `bot-tg-proxy:31280` — критический SPOF
> для Telegram Bot API (TSPU bypass). При любых операциях контролируй RAM (всего 15 GB)
> и не трогай `bot-tg-proxy`.

---

## 1. Топология деплоя

Два Docker-контейнера в общей сети `hindsight-net`, оба слушают только на loopback (127.0.0.1):

| Контейнер | Образ | Порты | Назначение |
|-----------|-------|-------|------------|
| `ollama` | `ollama/ollama:latest` | 127.0.0.1:11434 → 11434 | LLM-сервер для Hindsight fact extraction (`llama3.2:3b`, ~2 GB). Также `nomic-embed-text` (768 dim) — pulled, но Hindsight 0.6.1 для embeddings его не использует (см. ниже). |
| `hindsight` | `ghcr.io/vectorize-io/hindsight:latest` | 127.0.0.1:8888 → 8888 (API), 127.0.0.1:9999 → 9999 (Control Plane UI) | Hindsight API + встроенный PostgreSQL (`pg0`) с pgvector. Эмбеддинги — `local` (BAAI/bge-small-en-v1.5, 384 dim, in-process sentence-transformers). |

Persistence:
- `ollama_data` — volume для моделей и метаданных Ollama.
- `hindsight_data` — volume для embedded postgres Hindsight (banks, memories, vectors).

**Зачем нужен LLM (а не только embedding-провайдер):** Hindsight `retain` —
это не просто запись в векторную БД. Pipeline такой: chunking → **fact
extraction через chat-LLM** → embedding → store. Без работающего chat-LLM
документы сохраняются, но `memory_unit_count = 0` и recall возвращает пустой
ответ. Поэтому в Ollama есть `llama3.2:3b` (2 GB RSS на загрузку, 0% CPU
idle), который дёргается через `http://ollama:11434/api/chat`. На smoke-test
(2 документа, 4 факта) тратится ~90 секунд.

`HINDSIGHT_API_ENABLE_OBSERVATIONS=false` в Hindsight 0.6.1 — это **plugin-side
флаг** (не сервер-side, в `.env.example` Hindsight его нет; читается плагином
`@vectorize-io/hindsight-paperclip` для подавления background observation jobs).
Тяжёлые модели (gpt-oss:20b, ~16 GB RAM) не нужны и не влезут — `llama3.2:3b`
достаточно для fact extraction коротких heartbeat-чанков.

---

## 2. Запуск с нуля (recreate)

```bash
# 1. Сеть и volumes
docker network create hindsight-net || true
docker volume create ollama_data || true
docker volume create hindsight_data || true

# 2. Ollama
docker run -d --name ollama --restart=unless-stopped --network hindsight-net \
  -p 127.0.0.1:11434:11434 \
  -v ollama_data:/root/.ollama \
  -e OLLAMA_KEEP_ALIVE=30m -e OLLAMA_MAX_LOADED_MODELS=1 \
  ollama/ollama
docker exec ollama ollama pull nomic-embed-text   # ~274 MB (опционально, embeddings provider=local)
docker exec ollama ollama pull llama3.2:3b        # ~2 GB, обязательно для fact extraction

# 3. Hindsight
docker run -d --name hindsight --restart=unless-stopped --network hindsight-net \
  -p 127.0.0.1:8888:8888 -p 127.0.0.1:9999:9999 \
  -v hindsight_data:/var/lib/postgresql/data \
  -e HINDSIGHT_API_LLM_PROVIDER=ollama \
  -e HINDSIGHT_API_LLM_BASE_URL=http://ollama:11434 \
  -e HINDSIGHT_API_LLM_MODEL=llama3.2:3b \
  -e HINDSIGHT_API_LLM_API_KEY=ollama-not-used \
  -e HINDSIGHT_API_EMBEDDINGS_PROVIDER=local \
  -e HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=BAAI/bge-small-en-v1.5 \
  -e HINDSIGHT_API_RERANKER_PROVIDER=local \
  -e HINDSIGHT_API_ENABLE_OBSERVATIONS=false \
  ghcr.io/vectorize-io/hindsight:latest
```

Первый старт Hindsight ~ 30–60 сек (загружает sentence-transformers модель).
Готовность: `curl -fs http://127.0.0.1:8888/health` → `{"status":"healthy","database":"connected"}`.

---

## 3. Health-checks (heartbeat-friendly)

```bash
# Ollama
curl -fs http://127.0.0.1:11434/ ; echo
# → "Ollama is running"

curl -fs http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"nomic-embed-text","prompt":"smoke"}' \
  | python3 -c 'import json,sys; v=json.load(sys.stdin)["embedding"]; print(f"OK dim={len(v)}")'
# → OK dim=768

# Hindsight
curl -fs http://127.0.0.1:8888/health ; echo
# → {"status":"healthy","database":"connected"}

curl -fs http://127.0.0.1:8888/v1/default/banks
# → {"banks":[]}  — после установки плагина появятся per-agent банки

# Контейнеры
docker ps --filter name=ollama --filter name=hindsight --format \
  'table {{.Names}}\t{{.Status}}'
```

---

## 4. Стандартный troubleshooting

| Симптом | Что смотреть | Действие |
|---------|--------------|----------|
| Hindsight `/health` 502 / connection refused | `docker logs hindsight --tail=200` | Перезапуск: `docker restart hindsight`. Если `ValueError: Unknown embeddings provider` — env var регрессировала, см. §2. |
| `nomic-embed-text` 404 | `docker exec ollama ollama list` | `docker exec ollama ollama pull nomic-embed-text` |
| RAM > 13 GB на хосте | `free -h`, `docker stats --no-stream` | Срочно: остановить Ollama (`docker stop ollama`) — Hindsight продолжит работу с локальными embeddings. |
| Hindsight UI :9999 не открывается из браузера | nginx-proxy-manager не проксирует | Прокси по умолчанию слушает только loopback (security by design). Для доступа: SSH-tunnel `ssh -L 9999:127.0.0.1:9999 root@193.233.211.200`. |
| Bank/memory queries возвращают пустой ответ | `docker logs hindsight --tail=200` | Проверь, что плагин Paperclip установлен и сконфигурирован (см. §5). |
| `bot-tg-proxy` упал после операций с Docker | `docker ps` | **Critical.** `docker start bot-tg-proxy`. Проверить `curl -x http://127.0.0.1:31280 http://api.telegram.org` → 407 (это норма). |

Обновление Hindsight:
```bash
docker pull ghcr.io/vectorize-io/hindsight:latest
docker stop hindsight && docker rm hindsight
# Запустить заново по §2 (volume hindsight_data сохраняется → миграции применятся автоматически)
```

Полное удаление (destructive):
```bash
docker rm -f hindsight ollama
docker volume rm hindsight_data ollama_data
docker network rm hindsight-net
```

---

## 5. Установка и конфигурация Paperclip плагина — **требует board access**

**Почему этого не сделал SRE-агент:** plugin install идёт через
`POST /api/plugins/install` с `assertInstanceAdmin(req)` (см.
`/opt/paperclip/server/src/routes/plugins.ts:863`). Текущий instance работает
в `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, а agent JWT (`PAPERCLIP_API_KEY`)
имеет роль `agent`, не `board`. Это правильный governance — установка плагина
выполняет внешний код в worker-runtime, поэтому она зарезервирована за board.

### 5.1. Шаги для board-user (instance admin)

1. Залогиниться через `paperclipai`:
   ```bash
   sudo -u paperclip bash -c 'cd /opt/paperclip && pnpm paperclipai auth login --instance-admin'
   ```
   CLI выдаст одноразовую ссылку — открыть её в браузере под уже
   аутентифицированным admin-аккаунтом и подтвердить.

2. Установить плагин:
   ```bash
   sudo -u paperclip bash -c 'cd /opt/paperclip && pnpm paperclipai plugin install @vectorize-io/hindsight-paperclip'
   ```
   Должно вывести `✓ Installed hindsight-memory v0.2.1 (ready)`.

3. Сконфигурировать через UI: **Settings → Plugins → Hindsight Memory →
   Configure**:
   - `hindsightApiUrl: http://localhost:8888`
   - `bankGranularity: ["company", "agent"]`  ← per-agent isolation
   - `recallBudget: mid`
   - `autoRetain: true`

   Альтернативно — через API:
   ```bash
   sudo -u paperclip bash -c 'cd /opt/paperclip && \
     pnpm paperclipai plugin inspect hindsight-memory'
   # затем
   curl -fs -X POST http://127.0.0.1:3100/api/plugins/<plugin-id>/config \
     -H "Authorization: Bearer <BOARD_JWT>" \
     -H "Content-Type: application/json" \
     -d '{"hindsightApiUrl":"http://localhost:8888","bankGranularity":["company","agent"],"recallBudget":"mid","autoRetain":true}'
   ```

### 5.2. Проверка после установки

```bash
sudo -u paperclip bash -c 'cd /opt/paperclip && pnpm paperclipai plugin list'
# → status=ready для hindsight-memory

# Bank list — должен заполняться при первом heartbeat-е любого агента
curl -fs http://127.0.0.1:8888/v1/default/banks | python3 -m json.tool
```

### 5.3. Smoke-test — один heartbeat произвольного агента

После установки и конфига: дождаться следующего heartbeat-а любого агента
(например, SRE 57691608-ab55-4fb2-af90-00834ef57286), затем проверить:

- `docker logs hindsight --tail=200` — должны появиться запросы на
  `POST /v1/default/banks/.../memories/recall` и `.../memories/retain`.
- `curl http://127.0.0.1:8888/v1/default/banks` — список банков непустой,
  bank_id вида `agent_<uuid>` или `company_<uuid>`.
- В Paperclip UI на странице плагина: метрики recall/retain по агентам.

---

## 6. Текущее состояние (2026-05-08)

| Компонент | Статус |
|-----------|--------|
| Ollama | ✅ Up, `nomic-embed-text` загружен, embeddings smoke OK (768 dim) |
| Hindsight API | ✅ Up, `/health` green, embedded PostgreSQL подключён, embeddings = local BAAI/bge-small |
| Hindsight Control Plane UI :9999 | ✅ Up (loopback only) |
| Ollama LLM `llama3.2:3b` | ✅ Pulled, fact extraction работает (chat smoke 2026-05-09) |
| Paperclip plugin `paperclip-plugin-hindsight v0.2.0` | ✅ Installed (board-завершено), id `81895cee-201a-4a11-818e-39b2dbc048f0` |
| Plugin config (per-agent banks) | ✅ Saved: `bankGranularity=[company,agent]`, `recallBudget=mid`, `autoRetain=true` |
| Plugin worker | ✅ Up (`/home/paperclip/.paperclip/plugins/.../worker.js`, child of paperclip server) |
| Smoke recall+retain в heartbeat | ✅ Bank `agent-57691608-sre-smoke-the362` с 2 facts, recall возвращает корректные результаты |
| Direct API smoke | ✅ Bank `smoke-the-393` с 4 facts, recall корректен |

RAM на хосте после загрузки `llama3.2:3b`: 8.6 GB used / 15 GB total (запас 7 GB).
Ollama RSS — 4.4 GB (с моделью в памяти), Hindsight — 1.0 GB.
Один retain (1 chunk → 2 facts) занимает ~90 секунд (LLM bound).
