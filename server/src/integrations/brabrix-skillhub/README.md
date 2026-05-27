# Brabrix SkillHub Provider

Integração incremental do SkillHub do Brabrix ao sistema de skills existente.

## Objetivo

Adicionar um novo provider de importação (`brabrix_skillhub`) sem alterar o pipeline atual de persistência/execução de skills.

## Arquitetura

### `brabrix-skillhub-types.ts`
- Contratos tipados de:
  - busca (`BrabrixSkillHubSearchParams`)
  - skill pública (`BrabrixSkillHubSkill`)
  - categorias (`BrabrixSkillHubCategory`)
  - configuração (`BrabrixSkillHubConfig`)

### `brabrix-skillhub-client.ts`
- Cliente HTTP da API pública do SkillHub
- Métodos:
  - `searchSkills()`
  - `getSkillById()`
  - `importSkill()`
  - `getSkillCategories()`
  - `getFeaturedSkills()`
- Retry simples para falhas transitórias
- Logs estruturados por operação HTTP

### `brabrix-skillhub-provider.ts`
- Camada de provider desacoplada
- Cache local simples em memória:
  - skill por id
  - resultados de busca
  - categorias e featured
- Logs estruturados de busca/import com tamanho de contexto estimado

## Fluxo de importação

1. UI seleciona provider `Brabrix SkillHub`.
2. Backend chama o provider para buscar/listar skill pública.
3. `importSkill()` resolve a skill por id/slug.
4. Skill é convertida para markdown (`SKILL.md`) e metadados.
5. Conversão reaproveita o mesmo pipeline existente:
   - `upsertImportedSkills()` em `company-skills.ts`
6. Skill fica disponível na biblioteca da empresa como as demais.

## Endpoints adicionados

- `GET /api/companies/:companyId/skills/providers`
- `GET /api/companies/:companyId/skills/providers/brabrix-skillhub/search`
- `GET /api/companies/:companyId/skills/providers/brabrix-skillhub/settings`
- `PATCH /api/companies/:companyId/skills/providers/brabrix-skillhub/settings`
- `GET /api/companies/:companyId/skills/providers/brabrix-skillhub/categories`
- `GET /api/companies/:companyId/skills/providers/brabrix-skillhub/featured`
- `GET /api/companies/:companyId/skills/providers/brabrix-skillhub/:skillId`
- `POST /api/companies/:companyId/skills/import` com `provider=brabrix_skillhub`

## Payloads esperados

### Search

```json
{
  "q": "backend",
  "category": "api",
  "tags": ["typescript", "architecture"],
  "limit": 12,
  "offset": 0
}
```

### Import

```json
{
  "provider": "brabrix_skillhub",
  "skillId": "skill_backend_patterns"
}
```

## Variáveis de ambiente

- `BRABRIX_SKILLHUB_API_URL=https://api.brabrix.com` (default)
- `BRABRIX_SKILLHUB_ENABLED=true`
- `BRABRIX_SKILLHUB_SEARCH_ENDPOINT=/api/public/dev-hub/items` (default)
- `BRABRIX_SKILLHUB_SKILL_DETAIL_ENDPOINT=/api/public/dev-hub/items/{skillId}` (default)
- `BRABRIX_SKILLHUB_CATEGORIES_ENDPOINT=/api/public/dev-hub/categories` (default)
- `BRABRIX_SKILLHUB_FEATURED_ENDPOINT=/api/public/dev-hub/featured` (default)
- `BRABRIX_SKILLHUB_TOKEN=` (opcional, fallback para `BRABRIX_AGENT_TOKEN`)
- `BRABRIX_SKILLHUB_API_KEY=` (opcional, fallback legado para `BRABRIX_API_KEY`)
- `BRABRIX_SKILLHUB_HTTP_TIMEOUT_MS=10000`
- `BRABRIX_SKILLHUB_HTTP_MAX_RETRIES=1`
- `BRABRIX_SKILLHUB_HTTP_RETRY_DELAY_MS=350`

### Credencial recomendada (cloud-friendly)

- Configure a chave do SkillHub em **Company Settings → Brabrix** usando o sistema de **Secrets**.
- O backend resolve a secret por empresa e injeta no header `x-api-key`.
- As env vars de API key continuam como fallback para compatibilidade com instalações antigas.

## Extensão futura

- skills privadas (token/auth)
- marketplace premium
- versionamento avançado por provider
- favoritos de usuário/empresa
- sync automático periódico

Sem quebrar providers existentes (`github`, `skills_sh`) e mantendo baixo acoplamento.

## Como adicionar novos providers

1. Criar pasta em `server/src/integrations/<provider>/` com `types`, `client` e `provider`.
2. Implementar cache e retry no provider/client.
3. Expor os métodos no `companySkillService` sem alterar `upsertImportedSkills()`.
4. Converter payload externo para `ImportedSkill` e reutilizar o mesmo pipeline de importação.
5. Registrar endpoints de busca/listagem/import em `routes/company-skills.ts`.
6. Adicionar tipos compartilhados em `packages/shared` e cliente no `ui/src/api/companySkills.ts`.
