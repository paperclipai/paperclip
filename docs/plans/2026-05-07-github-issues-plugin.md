# GitHub Issues Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir um plugin nativo Paperclip (`@paperclipai/plugin-github-issues`) que recebe webhooks do GitHub e gerencia o lifecycle issue↔task com idempotência fundamental em 3 camadas (plataforma + plugin state + domínio).

**Architecture:** Plugin TypeScript no monorepo (`packages/plugins/paperclip-plugin-github-issues/`), worker-side definePlugin com `onWebhook` handler. Roteamento por `payload.action`; criação/atualização de tasks via `ctx.issues` API. Idempotência via `ctx.state` (delivery dedup) + lookup por `originKind/originId` antes de qualquer create. HMAC SHA-256 obrigatório no início do handler. Sem persistência custom — tudo no banco do control plane via SDK.

**Tech Stack:** TypeScript 5.7, esbuild, vitest, `@paperclipai/plugin-sdk`, `@paperclipai/shared`, Node `crypto` builtin para HMAC.

**Spec:** [`docs/specs/github-issues-plugin-v1.md`](../specs/github-issues-plugin-v1.md)

**Premissas:**
- Worktree atual (`relaxed-hypatia-3bab19`) está rebasado sobre `origin/master`.
- Plugin será desenvolvido nesse worktree, branch `claude/relaxed-hypatia-3bab19`. Merge pra master ao final.
- Identificadores externos seguem convenção do exemplo `plugin-orchestration-smoke-example`: `originKind: "plugin:paperclip-plugin-github-issues:issue"`, `originId: <repo>#<number>`.
- Config do plugin (hmacSecret, ceoAgentId, repoToProject, companyId) lido via `ctx.config.get()` no `setup`.

**Premissas SDK (validadas em T0 — ver `2026-05-07-github-issues-plugin-T0-findings.md`):**
- `PluginWebhookInput` NÃO carrega `companyId`. Plugin é instalado por company; o `companyId` vem do **config do plugin**, não do webhook.
- `ctx.issues.findByOrigin` NÃO existe. Lookup idiomático: `ctx.issues.list({ companyId, originKind, originId, limit: 1 })`.
- APIs posicionais: `createComment(issueId, body, companyId)`, `update(issueId, patch, companyId)`.
- `requestWakeup(issueId, companyId, { reason, idempotencyKey })` — **sem campo `payload`**. Padrão adotado: criar comment estruturado (JSON em code block) **imediatamente antes** do wakeup; agente lê último comment ao acordar.
- Manifest é `PaperclipPluginManifestV1` direto (sem `defineManifest`). Webhook declaration usa `endpointKey` (não `key`); sem campo `events` no manifest — filtragem é responsabilidade do handler.
- `ctx.config.get()` retorna config inteiro como objeto; sem chave individual.
- tsconfig estende `../../../tsconfig.base.json` da raiz do repo.

---

## File Structure

```
packages/plugins/paperclip-plugin-github-issues/
├── package.json                       # T1
├── tsconfig.json                      # T1
├── vitest.config.ts                   # T1
├── esbuild.config.mjs                 # T1
├── plugin.json                        # T2 (manifest declarado em código também)
├── README.md                          # T25
├── src/
│   ├── manifest.ts                    # T2 — declara webhook + config schema
│   ├── worker.ts                      # T22 — definePlugin entrypoint
│   ├── verify.ts                      # T3 — HMAC SHA-256
│   ├── origin-ref.ts                  # T4 — helpers originKind/originId
│   ├── label-gate.ts                  # T5 — filtro agent-eligible
│   ├── repo-resolver.ts               # T6 — repoToProject lookup
│   ├── idempotency.ts                 # T7 — camada plugin state
│   ├── lookup.ts                      # T8 — find issue by origin
│   ├── dispatch.ts                    # T9 — roteador por (event, action)
│   ├── observability.ts               # T10 — log estruturado
│   ├── handlers/
│   │   ├── issue-opened.ts            # T11
│   │   ├── issue-edited.ts            # T13
│   │   ├── comment-created.ts         # T14
│   │   ├── issue-closed.ts            # T15
│   │   ├── workflow-run.ts            # T16
│   │   └── pr-merged.ts               # T17
│   └── types.ts                       # T2 — eventos GitHub subset
└── tests/
    ├── verify.test.ts                 # T3
    ├── origin-ref.test.ts             # T4
    ├── label-gate.test.ts             # T5
    ├── repo-resolver.test.ts          # T6
    ├── idempotency.test.ts            # T7
    ├── lookup.test.ts                 # T8
    ├── dispatch.test.ts               # T9
    ├── handlers/
    │   ├── issue-opened.test.ts       # T11
    │   ├── issue-edited.test.ts       # T13
    │   ├── comment-created.test.ts    # T14
    │   ├── issue-closed.test.ts       # T15
    │   ├── workflow-run.test.ts       # T16
    │   └── pr-merged.test.ts          # T17
    ├── integration/
    │   └── full-lifecycle.test.ts     # T23
    └── fixtures/
        ├── issue-opened.json          # T2
        ├── issue-edited.json          # T2
        ├── issue-closed.json          # T2
        ├── issue-comment-created.json # T2
        ├── workflow-run-success.json  # T2
        └── pull-request-merged.json   # T2
```

---

## Task 0: Recon do SDK e do exemplo (read-only, ~10min)

**Files:**
- Read: `packages/plugins/sdk/src/define-plugin.ts:105-240`
- Read: `packages/plugins/sdk/src/types.ts` (PluginContext, ctx.issues)
- Read: `packages/plugins/examples/plugin-orchestration-smoke-example/src/worker.ts`
- Read: `packages/plugins/examples/plugin-orchestration-smoke-example/package.json`

- [ ] **Step 1: Confirmar shape de `PluginWebhookInput`**

Esperado: `{ endpointKey, headers, rawBody, parsedBody, requestId }`.

- [ ] **Step 2: Confirmar API `ctx.issues`**

Esperado: `create({ companyId, title, description, originKind, originId, assigneeAgentId, ... })`, `get(id, companyId)`, `requestWakeup(id, companyId, { reason, payload })`. Confirmar se existe método `findByOrigin(kind, id, companyId)` ou se precisa via `ctx.db.query`.

- [ ] **Step 3: Confirmar API `ctx.state`**

Esperado: `get({ scopeKind, scopeId, namespace, stateKey })` retornando `string | null`; `set(scope, value)` retornando `void`.

- [ ] **Step 4: Confirmar API `ctx.config`**

Como plugin lê config declarada no manifest. Esperado: `ctx.config.get<T>(key)` ou via `setup(ctx)` argumento.

- [ ] **Step 5: Anotar gaps no plano**

Se algum método previsto no plano não existir com nome esperado, atualizar o plano antes de seguir (renomear chamadas em todas as tasks afetadas).

---

## Task 1: Scaffold do pacote

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/package.json`
- Create: `packages/plugins/paperclip-plugin-github-issues/tsconfig.json`
- Create: `packages/plugins/paperclip-plugin-github-issues/vitest.config.ts`
- Create: `packages/plugins/paperclip-plugin-github-issues/esbuild.config.mjs`

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "@paperclipai/plugin-github-issues",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Paperclip plugin: GitHub issues/PRs/CI -> tasks with native idempotency",
  "scripts": {
    "prebuild": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps",
    "build": "node ./esbuild.config.mjs",
    "dev": "node ./esbuild.config.mjs --watch",
    "test": "vitest run --config ./vitest.config.ts",
    "test:watch": "vitest --config ./vitest.config.ts",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*"
  },
  "devDependencies": {
    "@paperclipai/shared": "workspace:*",
    "@types/node": "^24.6.0",
    "esbuild": "^0.27.3",
    "tslib": "^2.8.1",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Criar `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
```

- [ ] **Step 4: Criar `esbuild.config.mjs`**

```js
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({});
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch()]);
  console.log("esbuild watch mode enabled for worker and manifest");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose()]);
}
```

- [ ] **Step 5: Adicionar pacote ao workspace e instalar**

Run: `pnpm install`

Esperado: instalação sem erro, simbólico criado em `node_modules/@paperclipai/plugin-github-issues`.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/
git commit -m "feat(plugin-github-issues): scaffold package"
```

---

## Task 2: Manifest + tipos + fixtures

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/manifest.ts`
- Create: `packages/plugins/paperclip-plugin-github-issues/src/types.ts`
- Create: `packages/plugins/paperclip-plugin-github-issues/tests/fixtures/issue-opened.json`
- Create: `packages/plugins/paperclip-plugin-github-issues/tests/fixtures/issue-edited.json`
- Create: `packages/plugins/paperclip-plugin-github-issues/tests/fixtures/issue-closed.json`
- Create: `packages/plugins/paperclip-plugin-github-issues/tests/fixtures/issue-comment-created.json`
- Create: `packages/plugins/paperclip-plugin-github-issues/tests/fixtures/workflow-run-success.json`
- Create: `packages/plugins/paperclip-plugin-github-issues/tests/fixtures/pull-request-merged.json`

- [ ] **Step 1: Criar `src/manifest.ts`**

> Importante: `defineManifest` NÃO existe no SDK. Manifest é objeto tipado `PaperclipPluginManifestV1` exportado como default. Webhook declaration usa `endpointKey` (não `key`) e SEM campo `events` — filtragem é dentro do handler.

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-github-issues",
  name: "GitHub Issues",
  version: "0.1.0",
  description: "Bridges GitHub issues, comments, PRs and CI runs into Paperclip tasks with idempotent dedup",
  capabilities: ["webhooks.receive"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: "github",
      displayName: "GitHub Issues / PRs / CI",
      description: "Receives issues, issue_comment, pull_request, workflow_run from GitHub",
    },
  ],
  config: {
    schema: {
      type: "object",
      required: ["hmacSecret", "ceoAgentId", "companyId", "repoToProject"],
      properties: {
        hmacSecret: { type: "string", secret: true, description: "GitHub webhook HMAC secret" },
        ceoAgentId: { type: "string", description: "Agent that receives newly opened issues" },
        labelGate:  { type: "string", default: "agent-eligible" },
        repoToProject: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Map of org/repo -> Paperclip projectId",
        },
        companyId:  { type: "string", description: "Paperclip company id for created issues" },
      },
    },
  },
};

export default manifest;
```

- [ ] **Step 2: Criar `src/types.ts`** com subset mínimo dos eventos GitHub

```ts
export interface GhRepo {
  full_name: string;          // "org/repo"
  name: string;
  owner: { login: string };
  html_url: string;
}

export interface GhLabel { name: string }

export interface GhIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: GhLabel[];
  html_url: string;
  user: { login: string };
}

export interface GhComment {
  id: number;
  node_id: string;
  body: string;
  user: { login: string };
  html_url: string;
}

export interface GhPullRequest {
  id: number;
  node_id: string;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  head: { sha: string; ref: string };
  base: { ref: string };
  html_url: string;
}

export interface GhWorkflowRun {
  id: number;
  node_id: string;
  head_sha: string;
  conclusion: "success" | "failure" | "cancelled" | "neutral" | "skipped" | "timed_out" | "action_required" | null;
  status: "queued" | "in_progress" | "completed";
  pull_requests: Array<{ number: number; head: { sha: string }; base: { ref: string } }>;
  html_url: string;
}

export type GhEvent =
  | { type: "issues"; action: "opened" | "edited" | "closed" | "reopened" | string; issue: GhIssue; repository: GhRepo }
  | { type: "issue_comment"; action: "created" | "edited" | "deleted" | string; issue: GhIssue; comment: GhComment; repository: GhRepo }
  | { type: "pull_request"; action: "opened" | "closed" | "reopened" | "synchronize" | string; pull_request: GhPullRequest; repository: GhRepo }
  | { type: "workflow_run"; action: "completed" | "requested" | string; workflow_run: GhWorkflowRun; repository: GhRepo };

export interface PluginConfig {
  hmacSecret: string;
  ceoAgentId: string;
  labelGate: string;
  repoToProject: Record<string, string>;
  companyId: string;
}
```

- [ ] **Step 3: Capturar 6 fixtures de webhooks reais** (ou usar exemplos de `gh-analyzer/src/fixtures` se existirem; senão pegar de https://docs.github.com/en/webhooks/webhook-events-and-payloads)

Salvar em `tests/fixtures/` os 6 arquivos JSON (issue-opened, issue-edited, issue-closed, issue-comment-created, workflow-run-success, pull-request-merged). Cada um deve ter ≥1 issue/PR com label `agent-eligible` e o repo `org/sample-repo`.

- [ ] **Step 4: Build seco pra confirmar tipos**

Run: `pnpm --filter @paperclipai/plugin-github-issues typecheck`
Esperado: 0 erros.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/manifest.ts \
        packages/plugins/paperclip-plugin-github-issues/src/types.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/fixtures/
git commit -m "feat(plugin-github-issues): manifest, types, webhook fixtures"
```

---

## Task 3: HMAC verification (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/verify.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/verify.test.ts`

- [ ] **Step 1: Escrever teste falhando**

```ts
// tests/verify.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/verify.js";

const SECRET = "topsecret";
const BODY = '{"hello":"world"}';

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifySignature", () => {
  it("accepts a valid signature", () => {
    expect(verifySignature(BODY, sign(SECRET, BODY), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature('{"hello":"WORLD"}', sign(SECRET, BODY), SECRET)).toBe(false);
  });

  it("rejects when signature header is missing", () => {
    expect(verifySignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects when prefix is wrong", () => {
    expect(verifySignature(BODY, "sha1=" + sign(SECRET, BODY).slice(7), SECRET)).toBe(false);
  });

  it("uses constant-time comparison", () => {
    // Both signatures of identical length but different content
    const a = sign(SECRET, BODY);
    const b = "sha256=" + "0".repeat(64);
    expect(verifySignature(BODY, b, SECRET)).toBe(false);
    // Sanity: a is still valid
    expect(verifySignature(BODY, a, SECRET)).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar teste — verificar que falha**

Run: `pnpm --filter @paperclipai/plugin-github-issues test verify`
Esperado: erro de import (módulo `../src/verify.js` não existe).

- [ ] **Step 3: Implementação mínima**

```ts
// src/verify.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signatureHeader.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Rodar teste — todos passam**

Run: `pnpm --filter @paperclipai/plugin-github-issues test verify`
Esperado: 5/5 passam.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/verify.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/verify.test.ts
git commit -m "feat(plugin-github-issues): HMAC SHA-256 signature verification with constant-time compare"
```

---

## Task 4: origin-ref helpers (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/origin-ref.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/origin-ref.test.ts`

- [ ] **Step 1: Test falhando**

```ts
// tests/origin-ref.test.ts
import { describe, it, expect } from "vitest";
import { issueOriginKind, issueOriginId, prOriginKind, prOriginId, parseOriginId } from "../src/origin-ref.js";

describe("origin-ref", () => {
  it("issueOriginKind is namespaced by plugin id", () => {
    expect(issueOriginKind()).toBe("plugin:paperclip-plugin-github-issues:issue");
  });

  it("issueOriginId combines repo+number deterministically", () => {
    expect(issueOriginId("acme/foo", 42)).toBe("acme/foo#42");
  });

  it("prOriginKind is distinct from issue", () => {
    expect(prOriginKind()).toBe("plugin:paperclip-plugin-github-issues:pr");
    expect(prOriginKind()).not.toBe(issueOriginKind());
  });

  it("prOriginId combines repo+number", () => {
    expect(prOriginId("acme/foo", 7)).toBe("acme/foo#7");
  });

  it("parseOriginId roundtrips", () => {
    expect(parseOriginId("acme/foo#42")).toEqual({ repo: "acme/foo", number: 42 });
  });

  it("parseOriginId returns null on garbage", () => {
    expect(parseOriginId("not-a-valid-id")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar — falha**

Run: `pnpm --filter @paperclipai/plugin-github-issues test origin-ref`

- [ ] **Step 3: Implementação**

```ts
// src/origin-ref.ts
const PLUGIN_ID = "paperclip-plugin-github-issues";

export const issueOriginKind = (): string => `plugin:${PLUGIN_ID}:issue`;
export const prOriginKind = (): string => `plugin:${PLUGIN_ID}:pr`;

export const issueOriginId = (repo: string, number: number): string => `${repo}#${number}`;
export const prOriginId = (repo: string, number: number): string => `${repo}#${number}`;

export function parseOriginId(originId: string): { repo: string; number: number } | null {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(originId);
  if (!match) return null;
  return { repo: match[1], number: Number(match[2]) };
}
```

- [ ] **Step 4: Test passa**

Run: `pnpm --filter @paperclipai/plugin-github-issues test origin-ref`
Esperado: 6/6 passam.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/origin-ref.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/origin-ref.test.ts
git commit -m "feat(plugin-github-issues): originKind/originId helpers for issue and PR linking"
```

---

## Task 5: Label gate (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/label-gate.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/label-gate.test.ts`

- [ ] **Step 1: Test falhando**

```ts
// tests/label-gate.test.ts
import { describe, it, expect } from "vitest";
import { hasEligibleLabel } from "../src/label-gate.js";

describe("hasEligibleLabel", () => {
  it("accepts when label present", () => {
    expect(hasEligibleLabel([{ name: "agent-eligible" }, { name: "bug" }], "agent-eligible")).toBe(true);
  });
  it("rejects when label absent", () => {
    expect(hasEligibleLabel([{ name: "bug" }], "agent-eligible")).toBe(false);
  });
  it("rejects empty labels", () => {
    expect(hasEligibleLabel([], "agent-eligible")).toBe(false);
  });
  it("is case-sensitive", () => {
    expect(hasEligibleLabel([{ name: "Agent-Eligible" }], "agent-eligible")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar — falha**

- [ ] **Step 3: Implementação**

```ts
// src/label-gate.ts
import type { GhLabel } from "./types.js";

export function hasEligibleLabel(labels: GhLabel[], gate: string): boolean {
  return labels.some((l) => l.name === gate);
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/label-gate.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/label-gate.test.ts
git commit -m "feat(plugin-github-issues): label-gate filter for agent-eligible"
```

---

## Task 6: Repo→project resolver (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/repo-resolver.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/repo-resolver.test.ts`

- [ ] **Step 1: Test falhando**

```ts
// tests/repo-resolver.test.ts
import { describe, it, expect } from "vitest";
import { resolveProjectId } from "../src/repo-resolver.js";

const MAP = { "acme/foo": "proj-1", "acme/bar": "proj-2" };

describe("resolveProjectId", () => {
  it("returns project for mapped repo", () => {
    expect(resolveProjectId("acme/foo", MAP)).toBe("proj-1");
  });
  it("returns null for unmapped repo", () => {
    expect(resolveProjectId("acme/baz", MAP)).toBeNull();
  });
  it("returns null for empty map", () => {
    expect(resolveProjectId("acme/foo", {})).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar — falha**

- [ ] **Step 3: Implementação**

```ts
// src/repo-resolver.ts
export function resolveProjectId(repoFullName: string, map: Record<string, string>): string | null {
  return map[repoFullName] ?? null;
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/repo-resolver.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/repo-resolver.test.ts
git commit -m "feat(plugin-github-issues): repo->project resolver"
```

---

## Task 7: Idempotency (plugin state layer) (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/idempotency.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/idempotency.test.ts`

- [ ] **Step 1: Test falhando**

```ts
// tests/idempotency.test.ts
import { describe, it, expect, vi } from "vitest";
import { acquireDelivery } from "../src/idempotency.js";

function fakeState() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (scope: any) => store.get(scope.stateKey) ?? null),
    set: vi.fn(async (scope: any, value: string) => { store.set(scope.stateKey, value); }),
  };
}

describe("acquireDelivery", () => {
  it("returns true on first delivery and stores marker", async () => {
    const state = fakeState();
    const acquired = await acquireDelivery(state as any, "company-1", "delivery-abc");
    expect(acquired).toBe(true);
    expect(state.set).toHaveBeenCalledOnce();
  });

  it("returns false on subsequent delivery with same id", async () => {
    const state = fakeState();
    expect(await acquireDelivery(state as any, "company-1", "delivery-abc")).toBe(true);
    expect(await acquireDelivery(state as any, "company-1", "delivery-abc")).toBe(false);
    expect(await acquireDelivery(state as any, "company-1", "delivery-abc")).toBe(false);
  });

  it("isolates by companyId", async () => {
    const state = fakeState();
    expect(await acquireDelivery(state as any, "company-1", "delivery-abc")).toBe(true);
    expect(await acquireDelivery(state as any, "company-2", "delivery-abc")).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar — falha**

- [ ] **Step 3: Implementação**

```ts
// src/idempotency.ts
export interface StateApi {
  get(scope: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }): Promise<string | null>;
  set(scope: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }, value: string): Promise<void>;
}

const NAMESPACE = "github";

function key(deliveryId: string): string { return `delivery:${deliveryId}`; }

/**
 * Idempotency layer 2: plugin state. Returns true if this is the first time
 * we see this deliveryId for the given company. Returns false on duplicate.
 *
 * Layer 1 (platform plugin_webhook_deliveries) and layer 3 (origin lookup)
 * live elsewhere — this only protects mutations from re-execution.
 */
export async function acquireDelivery(state: StateApi, companyId: string, deliveryId: string): Promise<boolean> {
  const scope = { scopeKind: "company" as const, scopeId: companyId, namespace: NAMESPACE, stateKey: key(deliveryId) };
  const existing = await state.get(scope);
  if (existing) return false;
  await state.set(scope, new Date().toISOString());
  return true;
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/idempotency.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/idempotency.test.ts
git commit -m "feat(plugin-github-issues): plugin-state idempotency layer (acquireDelivery)"
```

---

## Task 8: Lookup de issue por origin (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/lookup.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/lookup.test.ts`

> **API real (validada em T0)**: `ctx.issues.findByOrigin` NÃO existe. O caminho idiomático é `ctx.issues.list({ companyId, originKind, originId, limit: 1 })`. O wrapper abaixo encapsula isso. Tests mockam `IssuesListApi.list`.

- [ ] **Step 1: Test falhando**

```ts
// tests/lookup.test.ts
import { describe, it, expect, vi } from "vitest";
import { findIssueByOrigin } from "../src/lookup.js";

describe("findIssueByOrigin", () => {
  it("returns the issue id when found", async () => {
    const issuesApi = { list: vi.fn(async () => [{ id: "issue-paperclip-1" }]) };
    const result = await findIssueByOrigin(issuesApi as any, "company-1", "kind", "acme/foo#42");
    expect(result).toBe("issue-paperclip-1");
    expect(issuesApi.list).toHaveBeenCalledWith({
      companyId: "company-1",
      originKind: "kind",
      originId: "acme/foo#42",
      limit: 1,
    });
  });

  it("returns null when not found (empty array)", async () => {
    const issuesApi = { list: vi.fn(async () => []) };
    expect(await findIssueByOrigin(issuesApi as any, "company-1", "kind", "acme/foo#42")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar — falha**

- [ ] **Step 3: Implementação**

```ts
// src/lookup.ts
export interface IssuesListApi {
  list(input: { companyId: string; originKind: string; originId: string; limit?: number }): Promise<Array<{ id: string }>>;
}

export async function findIssueByOrigin(api: IssuesListApi, companyId: string, originKind: string, originId: string): Promise<string | null> {
  const results = await api.list({ companyId, originKind, originId, limit: 1 });
  return results[0]?.id ?? null;
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/lookup.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/lookup.test.ts
git commit -m "feat(plugin-github-issues): findIssueByOrigin (idempotency layer 3)"
```

---

## Task 9: Dispatch router (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/dispatch.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/dispatch.test.ts`

- [ ] **Step 1: Test falhando**

```ts
// tests/dispatch.test.ts
import { describe, it, expect, vi } from "vitest";
import { dispatch } from "../src/dispatch.js";

function makeHandlers() {
  return {
    issueOpened: vi.fn(),
    issueEdited: vi.fn(),
    issueClosed: vi.fn(),
    commentCreated: vi.fn(),
    workflowRun: vi.fn(),
    prMerged: vi.fn(),
  };
}

describe("dispatch", () => {
  it("routes issues.opened", async () => {
    const h = makeHandlers();
    await dispatch("issues", { action: "opened", issue: {}, repository: {} } as any, {} as any, h);
    expect(h.issueOpened).toHaveBeenCalledOnce();
  });

  it("routes issues.edited", async () => {
    const h = makeHandlers();
    await dispatch("issues", { action: "edited", issue: {}, repository: {} } as any, {} as any, h);
    expect(h.issueEdited).toHaveBeenCalledOnce();
  });

  it("routes issues.closed", async () => {
    const h = makeHandlers();
    await dispatch("issues", { action: "closed", issue: {}, repository: {} } as any, {} as any, h);
    expect(h.issueClosed).toHaveBeenCalledOnce();
  });

  it("routes issue_comment.created", async () => {
    const h = makeHandlers();
    await dispatch("issue_comment", { action: "created", issue: {}, comment: {}, repository: {} } as any, {} as any, h);
    expect(h.commentCreated).toHaveBeenCalledOnce();
  });

  it("routes workflow_run.completed only on success", async () => {
    const h = makeHandlers();
    await dispatch("workflow_run", { action: "completed", workflow_run: { conclusion: "success" }, repository: {} } as any, {} as any, h);
    expect(h.workflowRun).toHaveBeenCalledOnce();
  });

  it("drops workflow_run.completed when conclusion!=success", async () => {
    const h = makeHandlers();
    await dispatch("workflow_run", { action: "completed", workflow_run: { conclusion: "failure" }, repository: {} } as any, {} as any, h);
    expect(h.workflowRun).not.toHaveBeenCalled();
  });

  it("routes pull_request.closed merged=true", async () => {
    const h = makeHandlers();
    await dispatch("pull_request", { action: "closed", pull_request: { merged: true }, repository: {} } as any, {} as any, h);
    expect(h.prMerged).toHaveBeenCalledOnce();
  });

  it("drops pull_request.closed merged=false", async () => {
    const h = makeHandlers();
    await dispatch("pull_request", { action: "closed", pull_request: { merged: false }, repository: {} } as any, {} as any, h);
    expect(h.prMerged).not.toHaveBeenCalled();
  });

  it("drops unknown actions silently", async () => {
    const h = makeHandlers();
    await dispatch("issues", { action: "labeled", issue: {}, repository: {} } as any, {} as any, h);
    expect(h.issueOpened).not.toHaveBeenCalled();
    expect(h.issueEdited).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar — falha**

- [ ] **Step 3: Implementação**

```ts
// src/dispatch.ts
import type { PluginConfig } from "./types.js";

export interface Handlers {
  issueOpened(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  issueEdited(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  issueClosed(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  commentCreated(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  workflowRun(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  prMerged(payload: any, ctx: any, config: PluginConfig): Promise<void>;
}

export async function dispatch(
  event: string,
  payload: any,
  ctx: { config: PluginConfig },
  handlers: Handlers,
): Promise<void> {
  if (event === "issues") {
    if (payload.action === "opened")  return handlers.issueOpened(payload, ctx, ctx.config);
    if (payload.action === "edited")  return handlers.issueEdited(payload, ctx, ctx.config);
    if (payload.action === "closed")  return handlers.issueClosed(payload, ctx, ctx.config);
    return;
  }
  if (event === "issue_comment") {
    if (payload.action === "created") return handlers.commentCreated(payload, ctx, ctx.config);
    return;
  }
  if (event === "workflow_run") {
    if (payload.action === "completed" && payload.workflow_run?.conclusion === "success") {
      return handlers.workflowRun(payload, ctx, ctx.config);
    }
    return;
  }
  if (event === "pull_request") {
    if (payload.action === "closed" && payload.pull_request?.merged === true) {
      return handlers.prMerged(payload, ctx, ctx.config);
    }
    return;
  }
}
```

- [ ] **Step 4: Test passa**

Run: `pnpm --filter @paperclipai/plugin-github-issues test dispatch`
Esperado: 9/9.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/dispatch.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/dispatch.test.ts
git commit -m "feat(plugin-github-issues): event dispatcher with action/conclusion guards"
```

---

## Task 10: Observability — log estruturado

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/observability.ts`
- Test: incluído nas tests dos handlers (logs verificados via `vi.spyOn(console, "log")`)

- [ ] **Step 1: Implementação direta (sem TDD — utilitário trivial)**

```ts
// src/observability.ts
export type Outcome = "created" | "updated" | "closed" | "duplicate" | "filtered" | "error";

export interface DeliveryLog {
  deliveryId: string;
  event: string;
  action?: string;
  repo?: string;
  outcome: Outcome;
  durationMs: number;
  error?: string;
}

export function logDelivery(entry: DeliveryLog): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString(), plugin: "paperclip-plugin-github-issues" }));
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/observability.ts
git commit -m "feat(plugin-github-issues): structured delivery logger"
```

---

## Task 11: Handler `issue.opened` (TDD)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/handlers/issue-opened.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/handlers/issue-opened.test.ts`

- [ ] **Step 1: Test falhando**

```ts
// tests/handlers/issue-opened.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleIssueOpened } from "../../src/handlers/issue-opened.js";
import fixture from "../fixtures/issue-opened.json" with { type: "json" };

const config = {
  hmacSecret: "x",
  ceoAgentId: "agent-ceo",
  labelGate: "agent-eligible",
  repoToProject: { "acme/sample-repo": "project-1" },
  companyId: "company-1",
};

function makeCtx(found: { id: string } | null = null) {
  return {
    issues: {
      list:   vi.fn(async () => (found ? [found] : [])),
      create: vi.fn(async () => ({ id: "issue-new" })),
    },
    config,
  };
}

describe("handleIssueOpened", () => {
  it("creates a Paperclip issue when label present and repo mapped", async () => {
    const ctx = makeCtx(null);
    await handleIssueOpened(fixture as any, ctx as any, config);
    expect(ctx.issues.create).toHaveBeenCalledOnce();
    const args = ctx.issues.create.mock.calls[0][0];
    expect(args.companyId).toBe("company-1");
    expect(args.assigneeAgentId).toBe("agent-ceo");
    expect(args.originKind).toBe("plugin:paperclip-plugin-github-issues:issue");
    expect(args.originId).toMatch(/acme\/sample-repo#\d+/);
    expect(args.projectId).toBe("project-1");
  });

  it("noops when issue already exists by origin (idempotency layer 3)", async () => {
    const ctx = makeCtx({ id: "issue-existing" });
    await handleIssueOpened(fixture as any, ctx as any, config);
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });

  it("noops when label not present", async () => {
    const ctx = makeCtx(null);
    const filtered = { ...(fixture as any), issue: { ...(fixture as any).issue, labels: [{ name: "bug" }] } };
    await handleIssueOpened(filtered, ctx as any, config);
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });

  it("noops when repo not mapped", async () => {
    const ctx = makeCtx(null);
    const otherRepo = { ...(fixture as any), repository: { ...(fixture as any).repository, full_name: "acme/other" } };
    await handleIssueOpened(otherRepo, ctx as any, config);
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar — falha**

- [ ] **Step 3: Implementação**

```ts
// src/handlers/issue-opened.ts
import type { GhEvent, PluginConfig } from "../types.js";
import { hasEligibleLabel } from "../label-gate.js";
import { resolveProjectId } from "../repo-resolver.js";
import { issueOriginKind, issueOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleIssueOpened(payload: Extract<GhEvent, { type: "issues" }> | any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  const projectId = resolveProjectId(repo, config.repoToProject);
  if (!projectId) return;

  if (!hasEligibleLabel(payload.issue.labels, config.labelGate)) return;

  const originKind = issueOriginKind();
  const originId = issueOriginId(repo, payload.issue.number);

  const existing = await findIssueByOrigin(ctx.issues, config.companyId, originKind, originId);
  if (existing) return;

  await ctx.issues.create({
    companyId: config.companyId,
    projectId,
    title: payload.issue.title,
    description: `${payload.issue.body ?? ""}\n\n---\nFonte: ${payload.issue.html_url}`,
    assigneeAgentId: config.ceoAgentId,
    originKind,
    originId,
    status: "todo",
  });
}
```

- [ ] **Step 4: Test passa**

Run: `pnpm --filter @paperclipai/plugin-github-issues test handlers/issue-opened`
Esperado: 4/4.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/handlers/issue-opened.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/handlers/issue-opened.test.ts
git commit -m "feat(plugin-github-issues): issue.opened handler with origin-based dedup"
```

---

## Task 12: Idempotência cross-layer — 5x repeat test

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/tests/idempotency-e2e.test.ts`

> Esse teste prova **a métrica primária do PRD**: zero duplicatas em redelivery.

- [ ] **Step 1: Escrever teste**

```ts
// tests/idempotency-e2e.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleIssueOpened } from "../src/handlers/issue-opened.js";
import { acquireDelivery } from "../src/idempotency.js";
import fixture from "./fixtures/issue-opened.json" with { type: "json" };

const config = {
  hmacSecret: "x",
  ceoAgentId: "agent-ceo",
  labelGate: "agent-eligible",
  repoToProject: { "acme/sample-repo": "project-1" },
  companyId: "company-1",
};

describe("idempotency end-to-end (PRD primary metric)", () => {
  it("5 deliveries of the same payload create exactly 1 task", async () => {
    const stateStore = new Map<string, string>();
    const issueStore = new Map<string, { id: string; originKind: string; originId: string }>();
    const ctx = {
      state: {
        get: async (s: any) => stateStore.get(s.stateKey) ?? null,
        set: async (s: any, v: string) => { stateStore.set(s.stateKey, v); },
      },
      issues: {
        list: vi.fn(async (q: any) => {
          for (const [, v] of issueStore) if (v.originKind === q.originKind && v.originId === q.originId) return [{ id: v.id }];
          return [];
        }),
        create: vi.fn(async (input: any) => {
          const id = `issue-${issueStore.size + 1}`;
          issueStore.set(id, { id, originKind: input.originKind, originId: input.originId });
          return { id };
        }),
      },
      config,
    };
    const deliveryId = "delivery-abc-123";
    let runs = 0;
    for (let i = 0; i < 5; i++) {
      const acquired = await acquireDelivery(ctx.state as any, config.companyId, deliveryId);
      if (!acquired) continue;  // layer 2 short-circuit
      await handleIssueOpened(fixture as any, ctx as any, config);
      runs++;
    }
    expect(runs).toBe(1);
    expect(ctx.issues.create).toHaveBeenCalledOnce();
    expect(issueStore.size).toBe(1);
  });

  it("if state layer is bypassed (degraded), origin lookup still prevents duplicates", async () => {
    const issueStore = new Map<string, { id: string; originKind: string; originId: string }>();
    const ctx = {
      issues: {
        list: vi.fn(async (q: any) => {
          for (const [, v] of issueStore) if (v.originKind === q.originKind && v.originId === q.originId) return [{ id: v.id }];
          return [];
        }),
        create: vi.fn(async (input: any) => {
          const id = `issue-${issueStore.size + 1}`;
          issueStore.set(id, { id, originKind: input.originKind, originId: input.originId });
          return { id };
        }),
      },
      config,
    };
    for (let i = 0; i < 5; i++) {
      await handleIssueOpened(fixture as any, ctx as any, config);
    }
    expect(issueStore.size).toBe(1);
    expect(ctx.issues.create).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Rodar — esperado passar**

Run: `pnpm --filter @paperclipai/plugin-github-issues test idempotency-e2e`
Esperado: 2/2.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/tests/idempotency-e2e.test.ts
git commit -m "test(plugin-github-issues): 5x redelivery -> 1 task (PRD primary metric)"
```

---

## Task 13: Handler `issue.edited`

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/handlers/issue-edited.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/handlers/issue-edited.test.ts`

- [ ] **Step 1: Test falhando**

```ts
// tests/handlers/issue-edited.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleIssueEdited } from "../../src/handlers/issue-edited.js";
import fixture from "../fixtures/issue-edited.json" with { type: "json" };

const config = {
  hmacSecret: "x",
  ceoAgentId: "agent-ceo",
  labelGate: "agent-eligible",
  repoToProject: { "acme/sample-repo": "project-1" },
  companyId: "company-1",
};

function makeCtx(found: { id: string } | null = { id: "issue-1" }) {
  return {
    issues: {
      list:          vi.fn(async () => (found ? [found] : [])),
      createComment: vi.fn(async () => undefined),
      requestWakeup: vi.fn(async () => undefined),
    },
    config,
  };
}

describe("handleIssueEdited", () => {
  it("adds comment with wake_payload + wakes when issue exists", async () => {
    const ctx = makeCtx();
    await handleIssueEdited(fixture as any, ctx as any, config);
    expect(ctx.issues.createComment).toHaveBeenCalledOnce();
    expect(ctx.issues.createComment.mock.calls[0][1]).toContain("wake_payload");
    expect(ctx.issues.requestWakeup).toHaveBeenCalledOnce();
    const wakeArgs = ctx.issues.requestWakeup.mock.calls[0];
    expect(wakeArgs[0]).toBe("issue-1");
    expect(wakeArgs[1]).toBe("company-1");
    expect(wakeArgs[2].reason).toBe("github_issue_updated");
    expect(wakeArgs[2].idempotencyKey).toBeTruthy();
  });

  it("noops when issue does not exist (race: edit arrived before opened)", async () => {
    const ctx = makeCtx(null);
    await handleIssueEdited(fixture as any, ctx as any, config);
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("noops when repo unmapped", async () => {
    const ctx = makeCtx();
    const other = { ...(fixture as any), repository: { ...(fixture as any).repository, full_name: "acme/other" } };
    await handleIssueEdited(other, ctx as any, config);
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar — falha**

- [ ] **Step 3: Implementação**

> Padrão de payload do wakeup: como `requestWakeup` não aceita `payload`, criamos um comment com JSON estruturado em code block ANTES do wakeup. Agente lê o último comment ao acordar.

```ts
// src/handlers/issue-edited.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { issueOriginKind, issueOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleIssueEdited(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, issueOriginKind(), issueOriginId(repo, payload.issue.number),
  );
  if (!issueId) return;

  const wakePayload = { action: "edited", issueNumber: payload.issue.number, repo, title: payload.issue.title };
  const body = [
    `**GitHub edit:** ${payload.issue.title}`,
    "",
    payload.issue.body ?? "",
    "",
    payload.issue.html_url,
    "",
    "```json:wake_payload",
    JSON.stringify(wakePayload, null, 2),
    "```",
  ].join("\n");

  await ctx.issues.createComment(issueId, body, config.companyId);
  await ctx.issues.requestWakeup(issueId, config.companyId, {
    reason: "github_issue_updated",
    idempotencyKey: `gh-edit:${repo}#${payload.issue.number}:${payload.issue.updated_at ?? Date.now()}`,
  });
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/handlers/issue-edited.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/handlers/issue-edited.test.ts
git commit -m "feat(plugin-github-issues): issue.edited handler -> comment + wakeup"
```

---

## Task 14: Handler `issue_comment.created`

Mesma estrutura da Task 13. Reusa fixture `issue-comment-created.json`. Comportamento:
- Lookup por origin da issue.
- `createComment` (posicional) com body do comment + bloco JSON `wake_payload` no final.
- `requestWakeup` com `reason: "github_comment_created"` e `idempotencyKey: "gh-comment:<id>"`.
- Noop se issue não existe.

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/handlers/comment-created.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/handlers/comment-created.test.ts`

- [ ] **Step 1: Escrever teste** (estrutura idêntica à Task 13, payload usa `comment.body` em vez de `issue.body`)

- [ ] **Step 2: Falha**

- [ ] **Step 3: Implementação**

```ts
// src/handlers/comment-created.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { issueOriginKind, issueOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleCommentCreated(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, issueOriginKind(), issueOriginId(repo, payload.issue.number),
  );
  if (!issueId) return;

  const wakePayload = {
    action: "comment_created",
    commentId: payload.comment.id,
    author: payload.comment.user.login,
    repo,
  };
  const body = [
    `**GitHub comment by @${payload.comment.user.login}:**`,
    "",
    payload.comment.body,
    "",
    payload.comment.html_url,
    "",
    "```json:wake_payload",
    JSON.stringify(wakePayload, null, 2),
    "```",
  ].join("\n");

  await ctx.issues.createComment(issueId, body, config.companyId);
  await ctx.issues.requestWakeup(issueId, config.companyId, {
    reason: "github_comment_created",
    idempotencyKey: `gh-comment:${payload.comment.id}`,
  });
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/handlers/comment-created.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/handlers/comment-created.test.ts
git commit -m "feat(plugin-github-issues): issue_comment.created handler"
```

---

## Task 15: Handler `issue.closed`

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/handlers/issue-closed.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/handlers/issue-closed.test.ts`

- [ ] **Step 1: Test falhando**

```ts
import { describe, it, expect, vi } from "vitest";
import { handleIssueClosed } from "../../src/handlers/issue-closed.js";
import fixture from "../fixtures/issue-closed.json" with { type: "json" };

const config = { hmacSecret:"x", ceoAgentId:"agent-ceo", labelGate:"agent-eligible",
                 repoToProject:{ "acme/sample-repo":"project-1" }, companyId:"company-1" };

describe("handleIssueClosed", () => {
  it("marks Paperclip task done when found", async () => {
    const ctx = {
      issues: {
        list:   vi.fn(async () => [{ id: "issue-1" }]),
        update: vi.fn(async () => undefined),
      },
      config,
    };
    await handleIssueClosed(fixture as any, ctx as any, config);
    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "done" }, "company-1");
  });

  it("noops when not found", async () => {
    const ctx = { issues: { list: vi.fn(async () => []), update: vi.fn() }, config };
    await handleIssueClosed(fixture as any, ctx as any, config);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Falha**

- [ ] **Step 3: Implementação**

```ts
// src/handlers/issue-closed.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { issueOriginKind, issueOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleIssueClosed(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, issueOriginKind(), issueOriginId(repo, payload.issue.number),
  );
  if (!issueId) return;

  await ctx.issues.update(issueId, { status: "done" }, config.companyId);
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/handlers/issue-closed.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/handlers/issue-closed.test.ts
git commit -m "feat(plugin-github-issues): issue.closed handler -> mark task done"
```

---

## Task 16: Handler `workflow_run.completed` (CI green)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/handlers/workflow-run.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/handlers/workflow-run.test.ts`

- [ ] **Step 1: Test falhando**

```ts
import { describe, it, expect, vi } from "vitest";
import { handleWorkflowRun } from "../../src/handlers/workflow-run.js";
import fixture from "../fixtures/workflow-run-success.json" with { type: "json" };

const config = { hmacSecret:"x", ceoAgentId:"agent-ceo", labelGate:"agent-eligible",
                 repoToProject:{ "acme/sample-repo":"project-1" }, companyId:"company-1" };

describe("handleWorkflowRun", () => {
  it("wakes assignee with ci_green when PR linked task exists", async () => {
    const ctx = {
      issues: {
        list:          vi.fn(async () => [{ id: "issue-1" }]),
        createComment: vi.fn(async () => undefined),
        requestWakeup: vi.fn(async () => undefined),
      },
      config,
    };
    await handleWorkflowRun(fixture as any, ctx as any, config);
    expect(ctx.issues.requestWakeup).toHaveBeenCalledOnce();
    const args = ctx.issues.requestWakeup.mock.calls[0];
    expect(args[0]).toBe("issue-1");
    expect(args[1]).toBe("company-1");
    expect(args[2].reason).toBe("ci_green");
    // payload encoded into preceding comment
    expect(ctx.issues.createComment).toHaveBeenCalledOnce();
    expect(ctx.issues.createComment.mock.calls[0][1]).toContain("wake_payload");
  });

  it("noops when no linked PR in payload", async () => {
    const ctx = { issues: { list: vi.fn(), createComment: vi.fn(), requestWakeup: vi.fn() }, config };
    const noPr = { ...(fixture as any), workflow_run: { ...(fixture as any).workflow_run, pull_requests: [] } };
    await handleWorkflowRun(noPr, ctx as any, config);
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("noops when PR-linked task not found", async () => {
    const ctx = { issues: { list: vi.fn(async () => []), createComment: vi.fn(), requestWakeup: vi.fn() }, config };
    await handleWorkflowRun(fixture as any, ctx as any, config);
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Falha**

- [ ] **Step 3: Implementação**

```ts
// src/handlers/workflow-run.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { prOriginKind, prOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleWorkflowRun(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const prs = payload.workflow_run?.pull_requests ?? [];
  if (prs.length === 0) return;
  const prNumber = prs[0].number;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, prOriginKind(), prOriginId(repo, prNumber),
  );
  if (!issueId) return;

  const wakePayload = {
    action: "ci_green",
    headSha: payload.workflow_run.head_sha,
    runId: payload.workflow_run.id,
    prNumber,
    repo,
    runUrl: payload.workflow_run.html_url,
  };
  const body = [
    `**CI green** — workflow run ${payload.workflow_run.id} succeeded for PR #${prNumber}.`,
    "",
    `head_sha: \`${payload.workflow_run.head_sha}\``,
    payload.workflow_run.html_url,
    "",
    "```json:wake_payload",
    JSON.stringify(wakePayload, null, 2),
    "```",
  ].join("\n");

  await ctx.issues.createComment(issueId, body, config.companyId);
  await ctx.issues.requestWakeup(issueId, config.companyId, {
    reason: "ci_green",
    idempotencyKey: `gh-ci:${payload.workflow_run.id}`,
  });
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/handlers/workflow-run.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/handlers/workflow-run.test.ts
git commit -m "feat(plugin-github-issues): workflow_run.completed handler (ci_green wakeup)"
```

---

## Task 17: Handler `pull_request.closed merged=true`

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/handlers/pr-merged.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/handlers/pr-merged.test.ts`

- [ ] **Step 1: Test falhando**

```ts
import { describe, it, expect, vi } from "vitest";
import { handlePrMerged } from "../../src/handlers/pr-merged.js";
import fixture from "../fixtures/pull-request-merged.json" with { type: "json" };

const config = { hmacSecret:"x", ceoAgentId:"agent-ceo", labelGate:"agent-eligible",
                 repoToProject:{ "acme/sample-repo":"project-1" }, companyId:"company-1" };

describe("handlePrMerged", () => {
  it("marks linked task done", async () => {
    const ctx = {
      issues: {
        list:   vi.fn(async () => [{ id: "issue-1" }]),
        update: vi.fn(async () => undefined),
      },
      config,
    };
    await handlePrMerged(fixture as any, ctx as any, config);
    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "done" }, "company-1");
  });

  it("noops when no linked task", async () => {
    const ctx = { issues: { list: vi.fn(async () => []), update: vi.fn() }, config };
    await handlePrMerged(fixture as any, ctx as any, config);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Falha**

- [ ] **Step 3: Implementação**

```ts
// src/handlers/pr-merged.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { prOriginKind, prOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handlePrMerged(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, prOriginKind(), prOriginId(repo, payload.pull_request.number),
  );
  if (!issueId) return;

  await ctx.issues.update(issueId, { status: "done" }, config.companyId);
}
```

- [ ] **Step 4: Test passa**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/handlers/pr-merged.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/handlers/pr-merged.test.ts
git commit -m "feat(plugin-github-issues): pr-merged handler -> close task"
```

---

## Task 18-21: Tests adicionais de borda

**Files:**
- Modify: tests existentes

- [ ] **Step 1: HMAC inválido em integração** — adicionar test que valida `onWebhook` retorna early sem chamar handlers se HMAC falha. (será testado em Task 22.)

- [ ] **Step 2: workflow_run sem `head_sha`** — verificar que handler não trava (defensivo).

- [ ] **Step 3: issue.opened com label adicionada depois (`labeled` action)** — confirmado no dispatcher: drop silencioso. Deixar comentário em `dispatch.test.ts` documentando o comportamento.

- [ ] **Step 4: cobertura ≥80% nas branches críticas** — rodar `pnpm --filter @paperclipai/plugin-github-issues test --coverage`. Se < 80%, adicionar tests faltantes em `dispatch.test.ts` ou nos handlers.

- [ ] **Step 5: Commit**

```bash
git commit -am "test(plugin-github-issues): edge cases + coverage to 80%"
```

---

## Task 22: Worker entrypoint (definePlugin + onWebhook)

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/src/worker.ts`
- Test: `packages/plugins/paperclip-plugin-github-issues/tests/integration/full-lifecycle.test.ts`

- [ ] **Step 1: Test de integração falhando**

```ts
// tests/integration/full-lifecycle.test.ts
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import opened   from "../fixtures/issue-opened.json"            with { type: "json" };
import edited   from "../fixtures/issue-edited.json"            with { type: "json" };
import closed   from "../fixtures/issue-closed.json"            with { type: "json" };
import { handleWebhook } from "../../src/worker.js";

const SECRET = "topsecret";
const config = { hmacSecret: SECRET, ceoAgentId:"agent-ceo", labelGate:"agent-eligible",
                 repoToProject:{ "acme/sample-repo":"project-1" }, companyId:"company-1" };

function sign(body: string) {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeCtx() {
  const issues = new Map<string, any>();
  return {
    config,
    state: { _store: new Map<string,string>(),
             get: async function (s: any) { return this._store.get(s.stateKey) ?? null; },
             set: async function (s: any, v: string) { this._store.set(s.stateKey, v); } },
    issues: {
      list: vi.fn(async (q: any) => {
        const out: any[] = [];
        for (const v of issues.values()) if (v.originKind === q.originKind && v.originId === q.originId) out.push({ id: v.id });
        return out;
      }),
      create: vi.fn(async (input: any) => {
        const v = { id: `i-${issues.size+1}`, ...input, status: input.status ?? "todo" };
        issues.set(v.id, v);
        return v;
      }),
      update: vi.fn(async (issueId: string, patch: any, _companyId: string) => {
        const e = issues.get(issueId); if (e) Object.assign(e, patch);
        return e;
      }),
      createComment: vi.fn(async () => undefined),
      requestWakeup: vi.fn(async () => undefined),
    },
    _issues: issues,
  };
}

async function deliver(ctx: any, event: string, payload: unknown, deliveryId: string) {
  const body = JSON.stringify(payload);
  await handleWebhook({
    endpointKey: "github",
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": event,
      "x-github-delivery": deliveryId,
    },
    rawBody: body,
    parsedBody: payload,
    requestId: deliveryId,
  } as any, ctx as any, config);
}

describe("full lifecycle", () => {
  it("opened -> edited -> closed", async () => {
    const ctx = makeCtx();
    await deliver(ctx, "issues", opened, "d1");
    expect(ctx._issues.size).toBe(1);
    await deliver(ctx, "issues", edited, "d2");
    expect(ctx.issues.createComment).toHaveBeenCalled();
    expect(ctx.issues.requestWakeup).toHaveBeenCalled();
    await deliver(ctx, "issues", closed, "d3");
    const [created] = [...ctx._issues.values()];
    expect(created.status).toBe("done");
  });

  it("rejects bad signature without side effects", async () => {
    const ctx = makeCtx();
    const body = JSON.stringify(opened);
    await handleWebhook({
      endpointKey: "github",
      headers: { "x-hub-signature-256": "sha256=00", "x-github-event": "issues", "x-github-delivery": "d-bad" },
      rawBody: body, parsedBody: opened, requestId: "d-bad",
    } as any, ctx as any, config);
    expect(ctx._issues.size).toBe(0);
  });

  it("redelivery (same deliveryId) is no-op", async () => {
    const ctx = makeCtx();
    await deliver(ctx, "issues", opened, "d-same");
    await deliver(ctx, "issues", opened, "d-same");
    await deliver(ctx, "issues", opened, "d-same");
    expect(ctx._issues.size).toBe(1);
    expect(ctx.issues.create).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Falha** (`worker.ts` ainda não exporta `handleWebhook`)

- [ ] **Step 3: Implementação do worker**

```ts
// src/worker.ts
import { definePlugin } from "@paperclipai/plugin-sdk";
import { verifySignature } from "./verify.js";
import { acquireDelivery } from "./idempotency.js";
import { dispatch, type Handlers } from "./dispatch.js";
import { logDelivery } from "./observability.js";
import { handleIssueOpened }    from "./handlers/issue-opened.js";
import { handleIssueEdited }    from "./handlers/issue-edited.js";
import { handleIssueClosed }    from "./handlers/issue-closed.js";
import { handleCommentCreated } from "./handlers/comment-created.js";
import { handleWorkflowRun }    from "./handlers/workflow-run.js";
import { handlePrMerged }       from "./handlers/pr-merged.js";
import type { PluginConfig } from "./types.js";

const HANDLERS: Handlers = {
  issueOpened:    handleIssueOpened,
  issueEdited:    handleIssueEdited,
  issueClosed:    handleIssueClosed,
  commentCreated: handleCommentCreated,
  workflowRun:    handleWorkflowRun,
  prMerged:       handlePrMerged,
};

function header(headers: Record<string, string | string[]>, key: string): string {
  const raw = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

/**
 * Test seam: same body the SDK calls, exported for integration tests.
 * Receives `ctx` explicitly (in production, captured via closure in setup()).
 */
export async function handleWebhook(input: any, ctx: any, config: PluginConfig): Promise<void> {
  const start = Date.now();
  const event   = header(input.headers, "x-github-event");
  const delivery = header(input.headers, "x-github-delivery") || input.requestId;
  const sig      = header(input.headers, "x-hub-signature-256");
  const repo     = (input.parsedBody as any)?.repository?.full_name;
  const action   = (input.parsedBody as any)?.action;

  try {
    if (!verifySignature(input.rawBody, sig, config.hmacSecret)) {
      logDelivery({ deliveryId: delivery, event, action, repo, outcome: "filtered", durationMs: Date.now()-start, error: "bad_signature" });
      return;
    }

    const acquired = await acquireDelivery(ctx.state, config.companyId, delivery);
    if (!acquired) {
      logDelivery({ deliveryId: delivery, event, action, repo, outcome: "duplicate", durationMs: Date.now()-start });
      return;
    }

    // Inject config into ctx so handlers can access via ctx.config (kept for parity)
    const ctxWithConfig = { ...ctx, config };
    await dispatch(event, input.parsedBody, ctxWithConfig, HANDLERS);
    logDelivery({ deliveryId: delivery, event, action, repo, outcome: "created", durationMs: Date.now()-start });
  } catch (err) {
    logDelivery({ deliveryId: delivery, event, action, repo, outcome: "error", durationMs: Date.now()-start, error: String(err) });
    throw err;
  }
}

export default definePlugin({
  async setup(ctx) {
    // ctx.config.get() retorna o objeto inteiro; cache-amos uma vez.
    const cfg = (await ctx.config.get()) as PluginConfig;
    // Capture ctx + cfg in closure for onWebhook handler.
    (this as any)._capturedCtx = ctx;
    (this as any)._capturedCfg = cfg;
  },
  async onWebhook(input) {
    const ctx = (this as any)._capturedCtx;
    const cfg = (this as any)._capturedCfg;
    if (!ctx || !cfg) throw new Error("Plugin not initialized: setup() did not run before onWebhook");
    return handleWebhook(input, ctx, cfg);
  },
});
```

> Os testes de integração chamam `handleWebhook(input, ctx, config)` diretamente (test seam) — não dependem da semântica de captura via `this`. Em produção, o SDK chama `setup()` antes de qualquer `onWebhook()`, então a captura é sempre prévia ao primeiro webhook.

- [ ] **Step 4: Tests de integração passam**

Run: `pnpm --filter @paperclipai/plugin-github-issues test integration`
Esperado: 3/3 passam.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/src/worker.ts \
        packages/plugins/paperclip-plugin-github-issues/tests/integration/
git commit -m "feat(plugin-github-issues): worker entrypoint with HMAC + idempotency + dispatch"
```

---

## Task 23: Build verify

**Files:**
- (sem novos arquivos)

- [ ] **Step 1: Build do plugin**

Run: `pnpm --filter @paperclipai/plugin-github-issues build`
Esperado: gera `dist/manifest.js` e `dist/worker.js` sem erro.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @paperclipai/plugin-github-issues typecheck`
Esperado: 0 erros.

- [ ] **Step 3: Test suite completa**

Run: `pnpm --filter @paperclipai/plugin-github-issues test`
Esperado: todos os tests passam, coverage ≥ 80% em `dispatch.ts` e `idempotency.ts`.

- [ ] **Step 4: Commit (se algum ajuste)**

```bash
git commit -am "chore(plugin-github-issues): build + typecheck pass"
```

---

## Task 24: Registrar plugin no host (manual / integração)

**Files:**
- Modify: configuração do host de plugins (`~/.paperclip/adapter-plugins.json` ou equivalente — confirmar em Task 0)

- [ ] **Step 1: Localizar arquivo de registro de plugins**

Run: `docker exec docker-paperclip-1 sh -c 'ls /paperclip/instances/default/'`
Procurar arquivo de plugins. Se não existir, criar conforme `adapter-plugin.md`.

- [ ] **Step 2: Adicionar entry**

```jsonc
{
  "plugins": [
    {
      "id": "paperclip-plugin-github-issues",
      "manifest": "/app/packages/plugins/paperclip-plugin-github-issues/dist/manifest.js",
      "worker":   "/app/packages/plugins/paperclip-plugin-github-issues/dist/worker.js",
      "config": {
        "hmacSecret":  "${GITHUB_WEBHOOK_HMAC_SECRET}",
        "ceoAgentId":  "${PAPERCLIP_CEO_AGENT_ID}",
        "labelGate":   "agent-eligible",
        "repoToProject": {
          "acme/repo-1": "${PROJECT_ID_REPO_1}",
          "acme/repo-2": "${PROJECT_ID_REPO_2}",
          "acme/repo-3": "${PROJECT_ID_REPO_3}"
        },
        "companyId":   "${PAPERCLIP_COMPANY_ID}"
      }
    }
  ]
}
```

- [ ] **Step 3: Smoke check via API**

Run: `curl -s $PAPERCLIP_API_URL/api/plugins | jq '.[] | select(.id=="paperclip-plugin-github-issues")'`
Esperado: registro retornado com status `ready`.

- [ ] **Step 4: Commit (se config.json for versionado; senão skip)**

---

## Task 25: README

**Files:**
- Create: `packages/plugins/paperclip-plugin-github-issues/README.md`

- [ ] **Step 1: Escrever README** com seções:
  - Visão geral + diagrama de fluxo
  - Setup local (`pnpm install`, `pnpm build`, `pnpm test`)
  - Config schema (tabela)
  - Como gerar HMAC secret (`openssl rand -hex 32`)
  - Como registrar webhook no GitHub (URL, content type, events)
  - Idempotência — 3 camadas explicadas
  - Logs estruturados — formato + exemplo de query no Grafana/Loki
  - Troubleshooting (HMAC inválido, repo não mapeado, label faltando)
  - Decommissioning de `gh-analyzer` (link pra issue de tracking)

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/paperclip-plugin-github-issues/README.md
git commit -m "docs(plugin-github-issues): README with setup, config, troubleshooting"
```

---

## Task 26: Configurar webhook nos 3 repos GitHub (manual)

**Files:**
- (sem código — operacional)

> Pré-requisito: `GITHUB_WEBHOOK_HMAC_SECRET` definido (mesmo valor usado em Task 24).

- [ ] **Step 1: Gerar secret HMAC** (uma vez, reuse nos 3 repos)

```bash
openssl rand -hex 32 > /tmp/gh-webhook-secret  # guardar e setar como GITHUB_WEBHOOK_HMAC_SECRET no .env do compose
```

- [ ] **Step 2: Para cada repo dos 3 (placeholder `org/repo`)**, configurar webhook via `gh`:

```bash
SECRET=$(cat /tmp/gh-webhook-secret)
URL="$PAPERCLIP_PUBLIC_URL/api/plugins/paperclip-plugin-github-issues/webhooks/github"

for repo in org/repo-1 org/repo-2 org/repo-3; do
  gh api -X POST "/repos/$repo/hooks" \
    -f name=web \
    -f active=true \
    -f config[url]="$URL" \
    -f config[content_type]=json \
    -f config[secret]="$SECRET" \
    -f config[insecure_ssl]=0 \
    -f events[]=issues \
    -f events[]=issue_comment \
    -f events[]=pull_request \
    -f events[]=workflow_run
done
```

- [ ] **Step 3: Verificar entrega de teste**

Cada repo tem aba *Settings → Webhooks → Recent Deliveries*. Esperado: status 200/202 do Paperclip.

- [ ] **Step 4: Documentar mapping `org/repo → projectId` no README** (Task 25 já tem placeholder).

---

## Task 27: Smoke test end-to-end (manual + observado)

- [ ] **Step 1: Criar issue real em `org/repo-1`** com body curto e label `agent-eligible`.

- [ ] **Step 2: Verificar criação no Paperclip**

```bash
curl -s "$PAPERCLIP_API_URL/api/issues?company_id=$PAPERCLIP_COMPANY_ID&origin_kind=plugin:paperclip-plugin-github-issues:issue" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq '.[] | { id, title, status, originId, assigneeAgentId }'
```

Esperado: 1 entry com `assigneeAgentId == ceoAgentId`.

- [ ] **Step 3: Triggerar redelivery do mesmo webhook** (Settings → Webhooks → Recent Deliveries → "Redeliver").

- [ ] **Step 4: Verificar zero duplicatas**

```bash
curl -s "$PAPERCLIP_API_URL/api/issues?company_id=$PAPERCLIP_COMPANY_ID&origin_id=org/repo-1#<issue_number>" | jq 'length'
```

Esperado: `1`.

- [ ] **Step 5: Editar a issue no GitHub** (alterar título). Verificar wakeup do CEO via `activity_log`:

```bash
curl -s "$PAPERCLIP_API_URL/api/activity?action=agent.wakeup_queued" | jq '.[0]'
```

Esperado: entry recente com `reason: github_issue_updated`.

- [ ] **Step 6: Fechar a issue no GitHub**. Verificar status = `done` no Paperclip.

- [ ] **Step 7: Documentar resultados em comment na issue Paperclip de tracking**

- [ ] **Step 8: Marcar plano como concluído**

---

## Self-Review

**Spec coverage:**
- [P0.1] scaffold → Task 1 ✓
- [P0.2] manifest webhook → Task 2 ✓
- [P0.3] config schema → Task 2 ✓
- [P0.4] platform delivery dedup → consumido pelo SDK, sem código (validado em Task 22 redelivery test)
- [P0.5] plugin state idempotency → Task 7 ✓
- [P0.6] origin lookup → Task 8 + Task 12 (e2e) ✓
- [P0.7] issues.opened → Task 11 ✓
- [P0.8] issues.edited + comment → Tasks 13, 14 ✓
- [P0.9] issues.closed → Task 15 ✓
- [P0.10] workflow_run.completed success → Task 16 ✓
- [P0.11] pr merged → Task 17 ✓
- [P0.12] eventos não tratados drop silencioso → Task 9 (dispatch) ✓
- [P0.13] HMAC verify → Task 3 + Task 22 ✓
- [P0.14] label gate → Task 5 + Task 11 ✓
- [P0.15] repo unmapped drop → Task 6 + handlers ✓
- [P0.16] log estruturado → Task 10 + Task 22 ✓
- [P0.17] vitest cobrindo cenários → Tasks 3-22 ✓
- [P0.18] coverage ≥80% → Task 18 ✓
- [P0.19] build do plugin → Task 23 ✓
- [P0.20] README → Task 25 ✓
- [P0.21] decom plan → fora do escopo desse plano (Plan C)

**Placeholder scan:** sem TBDs/TODOs nos steps. Único marker é "Task 0 deve confirmar X" — esse é o ponto de pesquisa explícito do SDK, não placeholder.

**Type consistency:** `originKind` / `originId` consistentes (sempre via `origin-ref.ts`); lookup uniforme via `findIssueByOrigin(api, companyId, originKind, originId)` que internamente chama `ctx.issues.list({ companyId, originKind, originId, limit: 1 })`; `requestWakeup(issueId, companyId, { reason, idempotencyKey })` consistente; payload do wakeup encodado como bloco JSON em comment criado imediatamente antes do `requestWakeup`.

**Gaps resolvidos pelo T0:**
- `ctx.issues.findByOrigin` não existe → wrapper `findIssueByOrigin` usa `ctx.issues.list`.
- `ctx.issues.update` posicional → `update(issueId, patch, companyId)`.
- `ctx.issues.createComment` posicional (não `addComment`).
- `requestWakeup` não aceita `payload` → padrão de comment `wake_payload`.
- Manifest sem `defineManifest`; webhook usa `endpointKey`, sem `events`.
- `ctx.config.get()` sem args → leitura única no `setup()`, captura via closure.
- tsconfig estende `../../../tsconfig.base.json` da raiz do repo.

---

## Plan Status

**Saved to:** `docs/plans/2026-05-07-github-issues-plugin.md`

**Total tasks:** 27 (incluindo Task 0 recon)
**Estimated time:** 3–5 dias de trabalho concentrado, assumindo Task 0 não revelar surpresa estrutural no SDK.
**Critical path:** Task 0 → Task 1 → Task 2 → Task 3-9 (paralelizável) → Task 11-17 → Task 22 → Task 23-27.
