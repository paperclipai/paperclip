# T0 Recon Findings — GitHub Issues Plugin

**Data:** 2026-05-07
**Worktree:** `relaxed-hypatia-3bab19`

---

## Item 1 — `PluginWebhookInput` shape

**Arquivo:** `packages/plugins/sdk/src/define-plugin.ts:112-123`

Confirmado. Shape exato:

```ts
export interface PluginWebhookInput {
  endpointKey: string;
  headers: Record<string, string | string[]>;
  rawBody: string;
  parsedBody?: unknown;
  requestId: string;
}
```

Sem campos extras. Exatamente o esperado.

**Status: CONFIRMADO**

---

## Item 2 — `onWebhook` signature

**Arquivo:** `packages/plugins/sdk/src/define-plugin.ts:238`

```ts
onWebhook?(input: PluginWebhookInput): Promise<void>;
```

Recebe **somente `input`** — sem `ctx` no parâmetro. O `ctx` é acessível via closure do `setup`. O plugin captura `ctx` dentro de `setup(ctx)` e usa em qualquer handler registrado posteriormente.

A rota do host (via `protocol.ts:489`) confirma: `handleWebhook: [params: PluginWebhookInput, result: void]` — não há companyId no payload do webhook. **O companyId deve ser extraído do `parsedBody` ou dos `headers` do payload do webhook (ex.: GitHub envia `X-GitHub-Hook-Installation-Target-Id`).**

**Status: CONFIRMADO — sem ctx, acesso via closure. ATENÇÃO: companyId não está no PluginWebhookInput — precisa ser determinado pelo conteúdo do webhook.**

---

## Item 3 — `ctx.issues` API

**Arquivo:** `packages/plugins/sdk/src/types.ts:1237-1373`

### `list` — busca por origin (idiomático)

```ts
ctx.issues.list({
  companyId: string,
  originKind?: PluginIssueOriginKind,
  originKindPrefix?: string,
  originId?: string,
  status?: Issue["status"],
  projectId?: string,
  assigneeAgentId?: string,
  includePluginOperations?: boolean,
  limit?: number,
  offset?: number,
}): Promise<Issue[]>
```

**NÃO existe `findByOrigin` nem `findByOriginRef`.** O caminho idiomático é `ctx.issues.list({ companyId, originKind, originId })`. Isso resolve o lookup de issue por origin.

### `create`

```ts
ctx.issues.create({
  companyId: string,          // obrigatório
  projectId?: string,
  goalId?: string,
  parentId?: string,
  inheritExecutionWorkspaceFromIssueId?: string,
  title: string,              // obrigatório
  description?: string,
  status?: Issue["status"],
  workMode?: Issue["workMode"],
  priority?: Issue["priority"],
  assigneeAgentId?: string,
  assigneeUserId?: string | null,
  requestDepth?: number,
  billingCode?: string | null,
  surfaceVisibility?: IssueSurfaceVisibility,
  originKind?: PluginIssueOriginKind,
  originId?: string | null,
  originRunId?: string | null,
  blockedByIssueIds?: string[],
  labelIds?: string[],
  executionWorkspaceId?: string | null,
  executionWorkspacePreference?: string | null,
  executionWorkspaceSettings?: Record<string, unknown> | null,
  actor?: PluginIssueMutationActor,
}): Promise<Issue>
```

### `update`

```ts
ctx.issues.update(
  issueId: string,
  patch: Partial<Pick<Issue, "title"|"description"|"status"|"workMode"|"priority"|
    "assigneeAgentId"|"assigneeUserId"|"billingCode"|"originKind"|"originId"|
    "originRunId"|"requestDepth"|"executionWorkspaceId"|"executionWorkspacePreference">
  > & {
    blockedByIssueIds?: string[];
    labelIds?: string[];
    executionWorkspaceSettings?: Record<string, unknown> | null;
  },
  companyId: string,
  actor?: PluginIssueMutationActor,
): Promise<Issue>
```

**O plano esperava `update({ issueId, companyId, status })` como objeto único. A assinatura real é posicional: `update(issueId, patch, companyId, actor?)`.**

### `createComment` (antes chamado `addComment`)

```ts
ctx.issues.createComment(
  issueId: string,
  body: string,
  companyId: string,
  options?: { authorAgentId?: string },
): Promise<IssueComment>
```

**O plano usava `addComment({ issueId, companyId, body })`. O nome real é `createComment` com assinatura posicional.**

### `requestWakeup`

```ts
ctx.issues.requestWakeup(
  issueId: string,
  companyId: string,
  options?: {
    reason?: string;
    contextSource?: string;
    idempotencyKey?: string | null;
  } & PluginIssueMutationActor,
): Promise<PluginIssueWakeupResult>
```

O plano esperava `requestWakeup(issueId, companyId, { reason, payload })`. **O campo `payload` NÃO existe — use `reason` (string) e opcionalmente `contextSource` e `idempotencyKey`.**

**Status: GAPS encontrados — ver seção GAPS abaixo.**

---

## Item 4 — `ctx.state` API

**Arquivo:** `packages/plugins/sdk/src/types.ts:690-722`

```ts
ctx.state.get(input: ScopeKey): Promise<unknown>
ctx.state.set(input: ScopeKey, value: unknown): Promise<void>
ctx.state.delete(input: ScopeKey): Promise<void>
```

`ScopeKey`:
```ts
interface ScopeKey {
  scopeKind: PluginStateScopeKind;
  scopeId?: string;
  namespace?: string;
  stateKey: string;
}
```

**Confirmado.** O `scopeKind` para empresa é `"company"` (exato). Valores válidos: `"instance" | "company" | "project" | "project_workspace" | "agent" | "issue" | "goal" | "run"`.

**Status: CONFIRMADO**

---

## Item 5 — `ctx.config`

**Arquivo:** `packages/plugins/sdk/src/types.ts:362-369`

```ts
export interface PluginConfigClient {
  get(): Promise<Record<string, unknown>>;
}
```

Acesso: `const config = await ctx.config.get()`. **Não aceita chave como parâmetro — retorna o objeto completo.** O plano mencionava `ctx.config.get(key)` com chave individual, mas o método real retorna o config inteiro. Acessar campos via `config.githubToken`.

Confirmado pelo docstring em `define-plugin.ts:23`: `const config = await ctx.config.get();`

**Status: GAP MENOR — `get()` sem argumento, não `get(key)`. Ajustar leitura para `(await ctx.config.get()).githubToken`.**

---

## Item 6 — `defineManifest`

**Arquivo:** `packages/plugins/sdk/src/index.ts` — revisado completamente.

**`defineManifest` NÃO existe no SDK.** Os exemplos declaram o manifest como objeto tipado com `PaperclipPluginManifestV1`:

```ts
// packages/plugins/examples/plugin-orchestration-smoke-example/src/manifest.ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
const manifest: PaperclipPluginManifestV1 = { ... };
export default manifest;
```

O array `webhooks` no manifest (tipo `PluginWebhookDeclaration[]`):
```ts
// packages/shared/src/types/plugin.ts:76-85
interface PluginWebhookDeclaration {
  endpointKey: string;    // campo "key" NÃO existe — é "endpointKey"
  displayName: string;
  description?: string;
}
```

**O plano mencionava campo `key` e `events` no array de webhooks. O campo real é `endpointKey`. Não existe campo `events`.**

**Status: GAP — usar `PaperclipPluginManifestV1` diretamente, sem `defineManifest`. Campo é `endpointKey`, não `key`.**

---

## Item 7 — Bundler presets

**Arquivo:** `packages/plugins/sdk/src/bundlers.ts`

```ts
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
```

Defaults:
- `workerEntry`: `"src/worker.ts"`
- `manifestEntry`: `"src/manifest.ts"`
- `outdir`: `"dist"`

Output paths (rollup):
- Worker: `dist/worker.js` (via `entryFileNames: "worker.js"`)
- Manifest: `dist/manifest.js` (via `entryFileNames: "manifest.js"`)
- UI: `dist/ui/index.js`

Com esbuild (sem `entryFileNames`), o output espelha o nome do arquivo source — `src/worker.ts` → `dist/worker.js`, `src/manifest.ts` → `dist/manifest.js`. Confirmado pelo exemplo de manifest: `entrypoints: { worker: "./dist/worker.js" }`.

**Status: CONFIRMADO**

---

## Item 8 — `tsconfig.base.json` do plugin SDK

**Não existe** `packages/plugins/sdk/tsconfig.base.json`. O arquivo existente é:

`packages/plugins/sdk/tsconfig.json`:
```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node", "react"]
  },
  "include": ["src"]
}
```

Herda de `tsconfig.base.json` na raiz do repo:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

**Status: GAP NOMENCLATURA — não há `tsconfig.base.json` no SDK, mas o tsconfig da raiz do repo cumpre o papel. Plugin externo deve usar `module: NodeNext, moduleResolution: NodeNext, target: ES2023, strict: true`.**

---

## Item 9 — Plugin host registration

**Arquivo:** `server/src/services/plugin-loader.ts:74-78`

```ts
export const DEFAULT_LOCAL_PLUGIN_DIR = path.join(
  os.homedir(),
  ".paperclip",
  "plugins",
);
```

O host carrega plugins via `plugin-loader.ts`. Plugins externos são instalados em `~/.paperclip/plugins/node_modules/<packageName>/`. O worker é resolvido via `manifest.entrypoints.worker` (caminho relativo ao pacote).

Instalação: via `POST /plugins/install` com `{ packageName, localPath?, version? }` — pode ser npm ou caminho local.

O `adapter-plugin.md` na raiz é um log de trabalho sobre adapters de agente (não plugins externos de webhook). **Não documenta o fluxo de registro de plugin externo diretamente.**

**Status: CONFIRMADO. Path runtime no container: `~/.paperclip/plugins/node_modules/<pkg>/dist/worker.js`.**

---

## GAPS — Itens que invalidam premissas do plano

### GAP-1: `onWebhook` sem companyId
- **Premissa do plano:** inferiu que `companyId` viria em `PluginWebhookInput`.
- **Real:** `PluginWebhookInput` não tem `companyId`. O plugin deve extrair o companyId do payload do GitHub (ex.: via mapeamento de `installation.id` para `companyId` via `ctx.state`).
- **Decisão:** Adicionar step de resolução de companyId no handler do webhook: buscar no state `scopeKind: "instance", stateKey: "gh-install-{installationId}"` → companyId.

### GAP-2: `addComment` → `createComment` (assinatura posicional)
- **Premissa do plano:** `ctx.issues.addComment({ issueId, companyId, body })`.
- **Real:** `ctx.issues.createComment(issueId, body, companyId, opts?)`.
- **Decisão:** Corrigir todas as chamadas no plano para assinatura posicional.

### GAP-3: `update` é posicional, não objeto
- **Premissa do plano:** `ctx.issues.update({ issueId, companyId, status })`.
- **Real:** `ctx.issues.update(issueId, { status }, companyId, actor?)`.
- **Decisão:** Corrigir para assinatura posicional.

### GAP-4: `requestWakeup` sem campo `payload`
- **Premissa do plano:** `requestWakeup(issueId, companyId, { reason, payload })`.
- **Real:** `requestWakeup(issueId, companyId, { reason?, contextSource?, idempotencyKey? })`.
- **Decisão:** Remover `payload` dos usos. Usar `reason` e `idempotencyKey` para rastreabilidade.

### GAP-5: `defineManifest` não existe; campo webhook é `endpointKey`, não `key`
- **Premissa do plano:** `defineManifest({ webhooks: [{ key: "github", events: [...] }] })`.
- **Real:** Usar `PaperclipPluginManifestV1` diretamente. O campo é `endpointKey`. Não há campo `events` na declaração — o filtro de eventos é responsabilidade do plugin dentro do handler.
- **Decisão:** `manifest.webhooks = [{ endpointKey: "github", displayName: "GitHub Issues" }]`.

### GAP-6: `ctx.config.get()` retorna objeto completo, não por chave
- **Premissa do plano:** `ctx.config.get("githubToken")`.
- **Real:** `(await ctx.config.get()).githubToken`.
- **Decisão:** Chamar `ctx.config.get()` uma vez e desestruturar.

### GAP-7: Sem `tsconfig.base.json` no SDK — usar config da raiz como referência
- **Premissa do plano:** herdar de `packages/plugins/sdk/tsconfig.base.json`.
- **Real:** Não existe. Plugin externo deve criar seu próprio tsconfig com `module: NodeNext`.
- **Decisão:** Plugin externo usa tsconfig próprio com os mesmos compiler options da raiz do repo.

---

## DECISÕES — ajustes no plano

| GAP | Ajuste |
|---|---|
| GAP-1 | Webhook handler implementa resolução de companyId via `ctx.state` usando `installation_id` do GitHub como chave. Step adicional: `setup` deve registrar mapeamento `installationId→companyId` via evento de instalação do GitHub App. |
| GAP-2 | Substituir `addComment` por `createComment(issueId, body, companyId)` em todo o plano. |
| GAP-3 | Substituir `update({ issueId, companyId, ... })` por `update(issueId, patch, companyId)`. |
| GAP-4 | Remover `payload` de `requestWakeup`. Usar `reason: "github:issue_updated"` e `idempotencyKey`. |
| GAP-5 | Manifest usa `PaperclipPluginManifestV1` com `webhooks: [{ endpointKey: "github", displayName: "..." }]`. Sem `defineManifest`. Sem campo `events`. |
| GAP-6 | Leitura de config: `const cfg = await ctx.config.get(); cfg.githubAppId`. |
| GAP-7 | tsconfig externo com `module: NodeNext, moduleResolution: NodeNext, target: ES2023, strict: true`. |

---

## Referências de arquivo (line references)

| Item | Arquivo | Linhas |
|---|---|---|
| PluginWebhookInput | `packages/plugins/sdk/src/define-plugin.ts` | 112-123 |
| onWebhook signature | `packages/plugins/sdk/src/define-plugin.ts` | 238 |
| PluginIssuesClient.list | `packages/plugins/sdk/src/types.ts` | 1238-1249 |
| PluginIssuesClient.create | `packages/plugins/sdk/src/types.ts` | 1251-1276 |
| PluginIssuesClient.update | `packages/plugins/sdk/src/types.ts` | 1277-1302 |
| PluginIssuesClient.createComment | `packages/plugins/sdk/src/types.ts` | 1337-1342 |
| PluginIssuesClient.requestWakeup | `packages/plugins/sdk/src/types.ts` | 1318-1335 |
| ctx.state API | `packages/plugins/sdk/src/types.ts` | 690-722 |
| ScopeKey / PluginStateScopeKind | `packages/plugins/sdk/src/types.ts` | 133-142 |
| PluginConfigClient | `packages/plugins/sdk/src/types.ts` | 362-369 |
| createPluginBundlerPresets | `packages/plugins/sdk/src/bundlers.ts` | 61-161 |
| PluginWebhookDeclaration (sem events) | `packages/shared/src/types/plugin.ts` | 76-85 |
| DEFAULT_LOCAL_PLUGIN_DIR | `server/src/services/plugin-loader.ts` | 74-78 |
| tsconfig raiz | `tsconfig.base.json` | (inteiro) |
