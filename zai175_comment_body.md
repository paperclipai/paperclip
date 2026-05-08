## Triaged — delegated to Localization Agent (no duplicate)

Проверил активные issues по локализации перед созданием новой — описанные страницы **не покрыты** уже идущими работами:

- ZAI-159 — `/instance/settings/access` (другая страница, не `/SDF/company/settings/access`)
- ZAI-160 — `/instance/settings/experimental`
- ZAI-170 — `/SDF/org`, `/SDF/skills/{id}`, `/SDF/costs`, `/SDF/company/settings/invites` (НЕ `/access`)
- ZAI-139 — общий round-3 сметник; конкретные 4 страницы из ZAI-175 в нём не перечислены
- ZAI-174 — это документ о синхронизации с upstream

Поэтому создаю **child-задачу** под ZAI-175 на конкретные 4 страницы из твоего списка.

## Делегировано — ZAI-178

**Назначено**: Localization Agent (`2c35ae09…`).

**Объём**:
1. `/SDF/company/settings/access` — кнопка `Remove`, текст `You cannot remove yourself.` (последний — серверная строка из `server/src/routes/access.ts:1095`, потребуется решение: вернуть код ошибки и переводить на фронте, либо locale-aware ответ).
2. `/SDF/u/board` — `owner` / `active` (это enum-значения из БД, нужны ключи `user_profile.role.*` и `user_profile.status.*`); заголовки колонок `Last 7 days` / `Last 30 days` / `All time` (приходят с сервера из `server/src/routes/user-profiles.ts:34-38` — отдавать только `key`, переводить на фронте).
3. `/instance/settings/general` — `ui/src/pages/InstanceGeneralSettings.tsx` сейчас содержит **0 вызовов** `useTranslation`/`t()`, вся страница хардкод. Полная локализация по 8 локалям.
4. `/instance/settings/adapters` — `ui/src/pages/AdapterManager.tsx` имеет 4 вызова `t()`, но не покрывает всю страницу. Полная локализация.

**Локали**: все 8 (`en`, `ru`, `de`, `el`, `es`, `pt`, `uk`, `zh`).

**Гард-рейлы** (повтор для агента):
- cwd должен быть `paperclip_fork_Enterprise` (форк), а не upstream — см. ZAI-163/164.
- ветка остаётся `vib-1171-2652-2760-3582-localization`.
- DOM sweep по 4 страницам × 8 локалям перед review.

**Approval gate**: ревью и аппрув идут на меня (CEO), потом на доске.

## Что дальше

ZAI-178 = `todo` → исполнитель пикнет на ближайшем heartbeat. Когда вернёт в `in_review`, перепроверю DOM-отчёт и quote-verdict-verbatim перед эскалацией к доске.

Эта задача (ZAI-175) остаётся открытой как родительская до закрытия ZAI-178.
