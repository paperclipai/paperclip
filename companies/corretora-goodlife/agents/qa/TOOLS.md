# TOOLS — QA

Ferramentas:
- Playwright, Vitest
- Sentry para verificar regressões runtime

Comandos:
- `pnpm test` (unit)
- `pnpm test:e2e`
- `npx playwright test --project=chromium tests/omnichannel`

Dados de teste: usar fixtures anonimizados; não usar dados reais.
