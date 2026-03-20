# 06 — Mapa do Repositório

## Estrutura de Diretórios (Raiz)

```
paperclip/
├── server/              # API REST + orquestração (Express)
├── ui/                  # Board UI (React + Vite)
├── packages/
│   ├── db/              # Schema Drizzle, migrations, client
│   ├── shared/          # Tipos, constantes, validadores
│   ├── adapters/        # Adapters de agentes (7 plugins)
│   ├── adapter-utils/   # Utilitários compartilhados dos adapters
│   └── plugins/         # Framework de plugins
├── cli/                 # CLI tool (paperclipai)
├── doc/                 # Documentação operacional e de produto
├── docs/                # Documentação publicável (Mintlify)
├── scripts/             # Build, release, backup, smoke tests
├── tests/
│   ├── e2e/             # Testes end-to-end (Playwright)
│   └── release-smoke/   # Smoke tests de release
├── docker/              # Dockerfiles e configs Docker
├── releases/            # Changelogs de releases
├── report/              # Reports gerados
├── skills/              # Skills compartilhados
├── .agents/             # Config e skills de agentes AI
├── .claude/             # Config do Claude
└── .github/             # GitHub Actions / CI
```

## Server — Detalhamento

```
server/src/
├── index.ts             # Entry point (27KB) — bootstrap, DB init, start
├── app.ts               # Express app setup (11KB)
├── config.ts            # Configuração do server (10KB)
├── routes/              # 22 arquivos de rotas
│   ├── access.ts        # Rotas de access control (90KB!)
│   ├── agents.ts        # CRUD de agents (62KB)
│   ├── issues.ts        # CRUD de issues (55KB)
│   ├── plugins.ts       # Rotas de plugins (76KB)
│   ├── companies.ts     # CRUD de companies
│   ├── approvals.ts     # Fluxo de aprovações
│   ├── costs.ts         # Custos e budgets
│   ├── goals.ts         # Goals
│   ├── projects.ts      # Projects
│   ├── assets.ts        # Upload/download de assets
│   ├── activity.ts      # Feed de atividades
│   ├── dashboard.ts     # Dashboard summary
│   ├── health.ts        # Health check
│   ├── secrets.ts       # Gerenciamento de secrets
│   └── ...
├── services/            # 57 arquivos de lógica de negócio
│   ├── heartbeat.ts     # Core heartbeat (132KB — maior arquivo!)
│   ├── issues.ts        # Lógica de issues (60KB)
│   ├── workspace-runtime.ts # Gerenciamento de workspace (53KB)
│   ├── plugin-loader.ts # Carregamento de plugins (72KB)
│   ├── plugin-host-services.ts # Host services para plugins (43KB)
│   ├── budgets.ts       # Enforcement de budget (33KB)
│   ├── company-portability.ts # Import/export de companies (36KB)
│   ├── projects.ts      # Lógica de projects (31KB)
│   ├── agents.ts        # Lógica de agents (24KB)
│   ├── costs.ts         # Processamento de custos (17KB)
│   ├── documents.ts     # Gerenciamento de docs (17KB)
│   ├── cron.ts          # Scheduler/cron (12KB)
│   └── ...
├── middleware/           # Auth, logging, rate limiting
├── adapters/            # Adapter runtime
├── auth/                # Auth handlers
├── secrets/             # Crypto/secrets management
├── storage/             # File storage abstraction
├── realtime/            # SSE/live events
└── types/               # Type definitions
```

## UI — Detalhamento

```
ui/src/
├── App.tsx              # Router principal (15KB)
├── main.tsx             # Entry point (2KB)
├── index.css            # Design system CSS (19KB)
├── pages/               # 32 páginas React
│   ├── AgentDetail.tsx  # Detalhe de agent (117KB — maior!)
│   ├── DesignGuide.tsx  # Guia de design (57KB)
│   ├── Costs.tsx        # Dashboard de custos (50KB)
│   ├── IssueDetail.tsx  # Detalhe de issue (46KB)
│   ├── Inbox.tsx        # Inbox/notificações (36KB)
│   ├── PluginSettings.tsx # Config plugins (36KB)
│   ├── CompanySettings.tsx # Config company (24KB)
│   ├── ProjectDetail.tsx   # Detalhe de projeto (24KB)
│   ├── PluginManager.tsx   # Gerenciador plugins (23KB)
│   ├── Agents.tsx       # Lista de agents (16KB)
│   ├── Dashboard.tsx    # Dashboard principal (16KB)
│   ├── OrgChart.tsx     # Organograma visual (15KB)
│   ├── ApprovalDetail.tsx # Detalhe aprovação (15KB)
│   └── ...
├── api/                 # API client functions
├── components/          # Componentes reutilizáveis
├── context/             # React contexts
├── hooks/               # Custom hooks
├── adapters/            # UI adapter configs
├── plugins/             # Plugin UI integration
├── lib/                 # Utilities
└── fixtures/            # Dados fixture
```

## Packages/DB — Schema (54 arquivos)

```
packages/db/src/schema/
├── index.ts             # Exporta todas as tabelas
├── companies.ts         ├── agents.ts
├── agent_api_keys.ts    ├── agent_config_revisions.ts
├── agent_runtime_state.ts ├── agent_task_sessions.ts
├── agent_wakeup_requests.ts ├── approvals.ts
├── approval_comments.ts ├── assets.ts
├── auth.ts              ├── budget_incidents.ts
├── budget_policies.ts   ├── company_logos.ts
├── company_memberships.ts ├── company_secrets.ts
├── company_secret_versions.ts ├── cost_events.ts
├── documents.ts         ├── document_revisions.ts
├── execution_workspaces.ts ├── finance_events.ts
├── goals.ts             ├── heartbeat_runs.ts
├── heartbeat_run_events.ts ├── instance_settings.ts
├── instance_user_roles.ts ├── invites.ts
├── issues.ts            ├── issue_approvals.ts
├── issue_attachments.ts ├── issue_comments.ts
├── issue_documents.ts   ├── issue_labels.ts
├── issue_read_states.ts ├── issue_work_products.ts
├── join_requests.ts     ├── labels.ts
├── plugins.ts           ├── plugin_company_settings.ts
├── plugin_config.ts     ├── plugin_entities.ts
├── plugin_jobs.ts       ├── plugin_logs.ts
├── plugin_state.ts      ├── plugin_webhooks.ts
├── principal_permission_grants.ts
├── projects.ts          ├── project_goals.ts
├── project_workspaces.ts
├── workspace_operations.ts
└── workspace_runtime_services.ts
```

## Adapters Disponíveis

```
packages/adapters/
├── claude-local/        # Claude Code CLI local
├── codex-local/         # Codex CLI local
├── cursor-local/        # Cursor editor local
├── gemini-local/        # Gemini CLI local
├── opencode-local/      # OpenCode local
├── pi-local/            # Pi local
└── openclaw-gateway/    # OpenClaw via HTTP webhook
```

## Arquivos-Chave de Configuração

| Arquivo | Propósito |
|---|---|
| `package.json` (raiz) | Scripts pnpm workspace |
| `pnpm-workspace.yaml` | Definição do monorepo |
| `tsconfig.base.json` | Config TS base |
| `vitest.config.ts` | Config testes unitários |
| `docker-compose.yml` | Postgres local |
| `Dockerfile` | Build de produção |
| `.env.example` | Variáveis de ambiente |
| `AGENTS.md` | Guia para contribuidores humanos e IA |
