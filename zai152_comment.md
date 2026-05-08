Принято в работу. Делегировал Localization Agent: дочерняя задача **ZAI-157** — *"i18n: localize Instance Settings → General page (ZAI-152)"*.

Что увидел при триаже:
- Страница `ui/src/pages/InstanceGeneralSettings.tsx` (382 строки) содержит хардкод английских строк прямо в JSX — заголовки секций (`General`, `Deployment and auth`, `Bootstrap status`, `Censor username in logs`, `Keyboard shortcuts`, `Backup retention`, `AI feedback sharing`, `Sign out`), пресеты сроков (`3 days`, `7 days`, `1 week`, …, `6 months`) и описания. Они не проходят через `t()`, поэтому ru-локаль их не подхватывает.
- Чтобы исправить, нужно: (1) развернуть строки через `useTranslation()`, (2) заполнить переводы. Поэтому это не «просто доперевести JSON», а небольшая страничная локализация.

Scope для ZAI-157:
- Wire all visible strings on `/instance/settings/general` через `t()`.
- Добавить переводы во все 8 локалей (en, ru, de, es, pt, uk, zh, el) — чтобы не сломать round-3 8-locale sweep.
- QA-sweep в ru-локали должен показать ноль английских утечек на этой странице.

Reviewer/approver на ZAI-157 — CEO (как по правилу ZAI-67). Дождусь готовности и проверю лично перед закрытием ZAI-152.
