# Provider Credentials Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a company-level credential store with UI management and agent-credential picker, supporting Claude OAuth tokens and Qwen API keys as backends for Claude Code.

**Architecture:** New `provider_credentials` table + `credential_id` FK on agents. CRUD API + UI in Company Settings. At agent execution time, credentials are resolved and injected into the adapter env (writing `.credentials.json` for OAuth, setting `ANTHROPIC_BASE_URL` for Qwen proxy).

**Tech Stack:** Drizzle ORM, Express, React + TanStack Query, Zod validation

---

### Task 1: DB Schema — provider_credentials table

**Files:**
- Create: `packages/db/src/schema/provider_credentials.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/agents.ts`

**Step 1: Create provider_credentials schema**

Create `packages/db/src/schema/provider_credentials.ts`:
```typescript
import { pgTable, uuid, text, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    type: text("type").notNull(), // claude_oauth, qwen_api_key
    credential: jsonb("credential").$type<Record<string, unknown>>().notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameIdx: uniqueIndex("provider_credentials_company_name_idx").on(table.companyId, table.name),
    companyTypeIdx: index("provider_credentials_company_type_idx").on(table.companyId, table.type),
  }),
);
```

**Step 2: Add credentialId to agents table**

In `packages/db/src/schema/agents.ts`, add import and column:
```typescript
import { providerCredentials } from "./provider_credentials.js";
// Add column after metadata:
credentialId: uuid("credential_id").references(() => providerCredentials.id),
```

**Step 3: Export from schema index**

In `packages/db/src/schema/index.ts`, add:
```typescript
export { providerCredentials } from "./provider_credentials.js";
```

**Step 4: Generate migration**

Run: `cd packages/db && pnpm build && pnpm drizzle-kit generate`

**Step 5: Verify typecheck**

Run: `pnpm -r typecheck`

---

### Task 2: Shared types + validators + API paths

**Files:**
- Create: `packages/shared/src/types/provider-credential.ts`
- Create: `packages/shared/src/validators/provider-credential.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/validators/agent.ts` (add credentialId to create/update schemas)

**Step 1: Add CREDENTIAL_TYPES constant**

In `packages/shared/src/constants.ts`, add:
```typescript
export const CREDENTIAL_TYPES = ["claude_oauth", "qwen_api_key"] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];
```

**Step 2: Create ProviderCredential type**

Create `packages/shared/src/types/provider-credential.ts`:
```typescript
import type { CredentialType } from "../constants.js";

export interface ProviderCredential {
  id: string;
  companyId: string;
  name: string;
  type: CredentialType;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

Note: No `credential` field in the type — it's write-only.

**Step 3: Export type from types/index.ts**

**Step 4: Create validators**

Create `packages/shared/src/validators/provider-credential.ts`:
```typescript
import { z } from "zod";
import { CREDENTIAL_TYPES } from "../constants.js";

export const createProviderCredentialSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(CREDENTIAL_TYPES),
  credential: z.record(z.unknown()),
  isDefault: z.boolean().optional().default(false),
});

export type CreateProviderCredential = z.infer<typeof createProviderCredentialSchema>;

export const updateProviderCredentialSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  credential: z.record(z.unknown()).optional(),
  isDefault: z.boolean().optional(),
});

export type UpdateProviderCredential = z.infer<typeof updateProviderCredentialSchema>;
```

**Step 5: Export validators from validators/index.ts**

**Step 6: Add credentialId to agent schemas**

In `packages/shared/src/validators/agent.ts`, add to createAgentSchema:
```typescript
credentialId: z.string().uuid().optional().nullable(),
```
And to updateAgentSchema (it inherits from createAgentSchema.partial()).

**Step 7: Add API path**

In `packages/shared/src/api.ts`:
```typescript
credentials: `${API_PREFIX}/credentials`,
```

**Step 8: Export everything from shared/src/index.ts**

**Step 9: Verify typecheck**

Run: `pnpm -r typecheck`

---

### Task 3: Server — Credential service + routes

**Files:**
- Create: `server/src/services/credentials.ts`
- Create: `server/src/routes/credentials.ts`
- Modify: `server/src/routes/index.ts`
- Modify: `server/src/app.ts`

**Step 1: Create credentials service**

`server/src/services/credentials.ts` — CRUD operations:
- `list(companyId)` — returns all credentials (without credential field)
- `getById(id)` — returns single credential (with credential field for internal use)
- `create(companyId, data)` — creates, enforces unique name per company
- `update(id, data)` — updates, handles default toggling
- `remove(id)` — deletes if no agents reference it (409 otherwise)
- `resolveForAgent(agentId)` — resolves credential config for runtime use

**Step 2: Create credentials routes**

`server/src/routes/credentials.ts` — following the secretRoutes pattern:
- GET `/companies/:companyId/credentials`
- POST `/companies/:companyId/credentials`
- PATCH `/credentials/:id`
- DELETE `/credentials/:id`

**Step 3: Mount routes in app.ts**

**Step 4: Verify typecheck + test manually**

---

### Task 4: Server — Runtime credential resolution

**Files:**
- Modify: `server/src/services/agents.ts` or the heartbeat/run execution path
- Modify: `packages/adapters/claude-local/src/server/execute.ts` (or the env injection point)

This task hooks credential resolution into the agent execution flow:
- Before executing an agent, if `credentialId` is set, resolve the credential
- For `claude_oauth`: write `.credentials.json` to agent HOME, ensure HOME is in env
- For `qwen_api_key`: set `ANTHROPIC_BASE_URL=http://localhost:PROXY_PORT` in env, ensure proxy running

The entrypoint.sh approach of writing credentials continues to work as fallback.

---

### Task 5: UI — Credentials API client

**Files:**
- Create: `ui/src/api/credentials.ts`

Simple API client following the secretsApi pattern.

---

### Task 6: UI — Credentials section in Company Settings

**Files:**
- Modify: `ui/src/pages/CompanySettings.tsx`

Add a "Credentials" section between "Notifications" and "Invites" with:
- Table of existing credentials (name, type, default badge, created date)
- "Add Credential" button opening inline form
- Edit/delete actions per row
- Form: name, type dropdown, token/key input, default toggle

---

### Task 7: UI — Credential picker in Agent Config Form

**Files:**
- Modify: `ui/src/components/AgentConfigForm.tsx`
- Modify: `ui/src/components/NewAgentDialog.tsx`

Add a credential dropdown to the agent config form:
- Shown when adapter type is `claude_local`
- Fetches credentials from API
- Auto-selects default credential
- Passes `credentialId` in agent create/update payload

---

### Task 8: QA — Full integration test

- Create a company
- Add Claude OAuth credential
- Add Qwen API key credential
- Create agent with Claude credential
- Create agent with Qwen credential
- Verify typecheck, tests, and build pass

Run:
```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```
