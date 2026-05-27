# Brabrix Project Import Pipeline

## Objetivo

Trocar o conceito de "importar goal isolada" para "importar projeto Brabrix completo", preservando compatibilidade com o core atual do Agent.

## Domínio: Project vs Goals vs Issues

- `Brabrix Project` representa o contexto macro do produto.
- `Goals` no Agent representam objetivos/entregas de maior nível (mapeadas de `Feature/Epic`).
- `Issues` no Agent representam backlog executável (mapeadas de `Backlog Items` como task, bug, story).

Importar só Goal perde PRD, specs, backlog e skills. O novo fluxo importa o bundle completo.

## Mapeamento Brabrix -> Agent

- `Brabrix Project` -> `Project + Workspace` local.
- `Brabrix PRD` -> `projectWorkspace.metadata.brabrix.projectContext/prd`.
- `Brabrix Specs` -> `projectWorkspace.metadata.brabrix.technicalSpecs/technicalContext`.
- `Brabrix Backlog` -> `Issues` (com `originKind=brabrix_backlog_item` e `originId`).
- `Brabrix Feature/Epic` -> `Goals`.
- `Brabrix Skill references` -> pipeline existente de skills (`importFromProvider`, `importFromSource` ou local skill markdown).

## Metadata Persistida

Cada workspace importado mantém:

- `brabrixProjectId`
- `brabrixImportedAt`
- `brabrixLastSyncedAt`
- `brabrixSourceUrl`
- `brabrixEntityType`
- mapas auxiliares (`featureGoalMap`, `backlogIssueMap`) para deduplicação/sync incremental.

## Fluxo de Importação

1. Conectar API key/token em `Settings > Brabrix`.
2. Configurar `Tenant ID` (quando a API Brabrix exigir contexto de tenant ativo).
3. `Test Connection`.
4. `List Projects`.
5. Selecionar `projectId`.
6. `Import Project`.

Durante o import:

1. Carrega bundle remoto (project/context/prd/spec/backlog/skills).
2. Cria projeto local caso não exista vínculo por `brabrixProjectId`.
3. Upsert de goals (features).
4. Upsert de issues (backlog não-feature) com vínculo de origem.
5. Importa skills pelo pipeline existente.
6. Persiste metadata de sync.

## Fluxo de Sincronização

`Sync Project` repete o bundle fetch e faz upsert nos mesmos recursos:

- atualiza nome/status/descrição do projeto local
- atualiza goals/issues/skills sem duplicar entidades
- atualiza timestamps e badges (`Imported`, `Synced`, `Out of sync`)

## Endpoints HTTP (server)

- `GET /api/companies/:companyId/brabrix/connection/test`
- `GET /api/companies/:companyId/brabrix/projects`
- `GET /api/companies/:companyId/brabrix/projects/imported`
- `POST /api/companies/:companyId/brabrix/projects/:projectId/import`
- `POST /api/companies/:companyId/brabrix/projects/:projectId/sync`
- `POST /api/companies/:companyId/brabrix/projects/:projectId/disconnect`

Endpoint legado preservado:

- `POST /api/companies/:companyId/brabrix/sync-next-task` (mantido apenas por compatibilidade; não é mais ação principal do UI).

## Exemplo de Project Bundle (normalizado)

```json
{
  "project": { "projectId": "bbx_proj_1", "name": "Payments Revamp" },
  "projectContext": { "projectId": "bbx_proj_1", "name": "Payments Revamp", "description": "..." },
  "prd": { "title": "PRD", "content": "..." },
  "technicalSpecs": [{ "specId": "tech-1", "type": "TECH_SPEC", "title": "API", "content": "..." }],
  "backlogItems": [{ "itemId": "item-1", "projectId": "bbx_proj_1", "type": "TASK", "title": "Create endpoint" }],
  "features": [{ "featureId": "feat-1", "projectId": "bbx_proj_1", "title": "Checkout Flow" }],
  "linkedSkills": [{ "skillId": "skill-1", "name": "Node API Patterns" }]
}
```

## Troubleshooting

- `401/403` ao listar/importar:
  - validar token/API key em Settings.
  - `bbx_` usa header `x-api-key`; outros tokens usam `Authorization: Bearer`.
- `404`:
  - validar endpoint/path e `projectId`.
- `5xx`:
  - erro no upstream Brabrix; tentar novamente.
  - quando disponível, usar `requestId` retornado pela API para suporte Brabrix.
- projeto não aparece como importado:
  - verificar `project_workspace.metadata.brabrix.brabrixProjectId`.
  - conferir permissões de board para import/sync/disconnect.
