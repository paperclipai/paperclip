# SHAA-13: PR CI quality gates baseline (2026-05-25)

## Что внедрено

- В `.github/workflows/pr.yml` добавлен обязательный job `quality_gates`:
  - `pnpm run lint`
  - `pnpm run format:check`
- Aggregator job `verify` теперь зависит от `quality_gates`, поэтому merge-гейт падает при провале lint/format.
- В `package.json` добавлены:
  - `lint`: `typecheck + check:tokens`
  - `format:check`: базовая проверка форматирования.
- Добавлен скрипт `scripts/check-formatting-basics.mjs`:
  - блокирует trailing whitespace;
  - блокирует CRLF в tracked text-файлах.

## Baseline пайплайна (GitHub Actions, workflow `pr.yml`)

Снимок по последним 30 runs на 2026-05-25:

- Completed runs: `30`
- Failures: `10`
- Failure rate: `33%`
- Средняя длительность: `236s` (~3m56s)
- P50: `243s` (~4m03s)
- P95: `255s` (~4m15s)

Примечание по флаки: в baseline есть как минимум нестабильность на уровне run outcome (доля fail 33%), но для разделения «реальный регресс» vs «flake» нужен отдельный сбор причины падений по job/step (следующий этап наблюдения после выката гейтов).

## Branch protection (master)

Требуемые статусы для защиты ветки:

- `verify` (агрегатор всех обязательных PR-проверок)

Команда применения (для токена с `Administration: write` на репозиторий):

```bash
gh api \
  --method PATCH \
  -H "Accept: application/vnd.github+json" \
  repos/paperclipai/paperclip/branches/master/protection/required_status_checks \
  -f strict=true \
  -f contexts[]='verify'
```

Текущее ограничение в этом heartbeat: токен engineering-агента вернул `403 Resource not accessible by personal access token` на branch protection API, поэтому фактическое применение должен выполнить владелец репозитория/администратор.
