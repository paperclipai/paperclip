# Versioned Agent Memory — Contract Spec

- **Issue**: LET-407
- **Status**: Contract; implementation deferred to follow-up issues. No migration applied in this lane.
- **Companion docs**: [ADR 0001](../adr/0001-versioned-agent-memory.md), [Validation Contract](versioned-agent-memory-validation-contract.md), [Integration Notes](versioned-agent-memory-integration.md), [Implementation Plan](versioned-agent-memory-implementation-plan.md).

This is the implementation-ready contract. Anything not specified here is **not in scope** for the first implementation issue.

## 1. Database schema (Drizzle — DRAFT, NOT APPLIED)

Two tables, mirroring `documents` + `document_revisions`. Migration file name reserved as `0090_agent_memory.sql`; **do not commit the SQL into `packages/db/src/migrations/` in this lane** — it lives only in this doc until the implementation issue runs `drizzle-kit generate`.

### 1.1 `agent_memory`

```ts
// packages/db/src/schema/agent_memory.ts
import { pgTable, uuid, text, integer, timestamp, jsonb, boolean, check, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Scope discriminator. See ADR §2.2.
    scope: text("scope").notNull(), // "company" | "agent" | "agent_project"
    scopeAgentId: uuid("scope_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    scopeProjectId: uuid("scope_project_id").references(() => projects.id, { onDelete: "cascade" }),
    // Stable user-chosen key. Lowercase, kebab/snake, max 120 chars. Unique per scope tuple
    // — see the three partial unique indexes below; PostgreSQL treats NULLs as distinct
    // in normal unique indexes, so the uniqueness has to be expressed per scope shape.
    key: text("key").notNull(),
    // Latest materialized view; revisions are source of truth.
    latestRevisionId: uuid("latest_revision_id"),
    // `0` means "no revisions yet"; the service inserts the parent row with `0`
    // inside the same transaction as the first revision, then updates the
    // materialized columns to point at revisionNumber=1. See §4.1 step 6 — a
    // brand-new row must never persist with `latest_revision_number > 0` and a
    // NULL `latest_revision_id`. The CHECK below enforces that invariant.
    latestRevisionNumber: integer("latest_revision_number").notNull().default(0),
    latestValueJson: jsonb("latest_value_json").$type<unknown>(),
    latestValueText: text("latest_value_text"), // for full-text indexing
    // Visibility / governance
    visibility: text("visibility").notNull().default("normal"), // "normal" | "agent_only" | "redacted_only"
    privatePromptData: boolean("private_prompt_data").notNull().default(false),
    status: text("status").notNull().default("active"), // "active" | "expired" | "forgotten"
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    forgottenAt: timestamp("forgotten_at", { withTimezone: true }),
    // Audit
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Null-safe uniqueness: PostgreSQL treats NULLs as distinct in plain unique indexes,
    // so we use three scope-specific partial unique indexes. This guarantees one row per
    // (companyId, key) for company scope, one row per (companyId, agentId, key) for agent
    // scope, and one row per (companyId, agentId, projectId, key) for agent_project scope.
    // (Equivalent on PostgreSQL 15+: a single UNIQUE (...) NULLS NOT DISTINCT; partial
    // indexes are used because they also work on PostgreSQL 14 and they read better.)
    scopeCompanyKeyUq: uniqueIndex("agent_memory_scope_company_key_uq")
      .on(table.companyId, table.key)
      .where(sql`scope = 'company' AND scope_agent_id IS NULL AND scope_project_id IS NULL`),
    scopeAgentKeyUq: uniqueIndex("agent_memory_scope_agent_key_uq")
      .on(table.companyId, table.scopeAgentId, table.key)
      .where(sql`scope = 'agent' AND scope_agent_id IS NOT NULL AND scope_project_id IS NULL`),
    scopeAgentProjectKeyUq: uniqueIndex("agent_memory_scope_agent_project_key_uq")
      .on(table.companyId, table.scopeAgentId, table.scopeProjectId, table.key)
      .where(sql`scope = 'agent_project' AND scope_agent_id IS NOT NULL AND scope_project_id IS NOT NULL`),
    // DB-level guards so rows inserted outside the service layer still respect the contract.
    scopeShapeCheck: check(
      "agent_memory_scope_shape_chk",
      sql`(scope = 'company' AND scope_agent_id IS NULL AND scope_project_id IS NULL)
        OR (scope = 'agent' AND scope_agent_id IS NOT NULL AND scope_project_id IS NULL)
        OR (scope = 'agent_project' AND scope_agent_id IS NOT NULL AND scope_project_id IS NOT NULL)`,
    ),
    statusEnumCheck: check(
      "agent_memory_status_chk",
      sql`status IN ('active', 'expired', 'forgotten')`,
    ),
    visibilityEnumCheck: check(
      "agent_memory_visibility_chk",
      sql`visibility IN ('normal', 'agent_only', 'redacted_only')`,
    ),
    // Materialization invariant: either the row has no revisions yet
    // (number=0, latestRevisionId NULL, latest_value_* NULL) or it has one
    // (number>=1, latestRevisionId NOT NULL). Prevents a desync where the
    // materialized columns disagree with the revision table.
    latestRevisionInvariantCheck: check(
      "agent_memory_latest_revision_invariant_chk",
      sql`(latest_revision_number = 0 AND latest_revision_id IS NULL AND latest_value_json IS NULL AND latest_value_text IS NULL)
        OR (latest_revision_number >= 1 AND latest_revision_id IS NOT NULL)`,
    ),
    companyUpdatedIdx: index("agent_memory_company_updated_idx").on(table.companyId, table.updatedAt),
    agentIdx: index("agent_memory_agent_idx").on(table.scopeAgentId),
    expiresIdx: index("agent_memory_expires_idx").on(table.expiresAt),
    valueTextSearchIdx: index("agent_memory_value_text_search_idx").using("gin", table.latestValueText.op("gin_trgm_ops")),
  }),
);
```

### 1.2 `agent_memory_revisions`

```ts
// packages/db/src/schema/agent_memory_revisions.ts
import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentMemory } from "./agent_memory.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentMemoryRevisions = pgTable(
  "agent_memory_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    memoryId: uuid("memory_id").notNull().references(() => agentMemory.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    valueJson: jsonb("value_json").$type<unknown>(),
    valueText: text("value_text"),
    changeSummary: text("change_summary"),
    // Provenance — see ADR §2.3
    source: jsonb("source").$type<{
      kind: "human_message" | "agent_self" | "run_observation" | "imported" | "system" | "external_tool" | "rollback";
      runId?: string | null;
      commentId?: string | null;
      documentId?: string | null;
      issueId?: string | null;
      externalRef?: { system: string; id: string; url?: string | null } | null;
      confidence?: number | null; // 0..1
      rollbackFromRevisionId?: string | null;
    }>().notNull(),
    supersedesRevisionId: uuid("supersedes_revision_id"),
    // Redaction footprint
    redaction: jsonb("redaction").$type<{
      // Dot-paths into valueJson where sanitizeRecord redacted in pass 1 —
      // either via branch (a) key-name match (SECRET_PAYLOAD_KEY_RE) or
      // branch (b) value-shape match (anchored JWT_VALUE_RE, no per-segment
      // length gate) on a string-valued object property. The column name is
      // historical; both pass-1 branches share this array.
      keyRedactedPaths: string[];
      // Dot-paths to string leaves under neutral keys (or array indices) whose
      // CONTENT was rewritten by redactSensitiveText during the second pass.
      // Disjoint from keyRedactedPaths.
      jsonTextRedactedPaths: string[];
      // True iff valueText was rewritten by redactSensitiveText.
      textRedactionApplied: boolean;
      // True iff the caller passed `acknowledgeRedaction:true` to persist anyway.
      acknowledged: boolean;
    }>().notNull().default({ keyRedactedPaths: [], jsonTextRedactedPaths: [], textRedactionApplied: false, acknowledged: false }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    memoryRevisionUq: uniqueIndex("agent_memory_revisions_memory_revision_uq").on(
      table.memoryId, table.revisionNumber,
    ),
    memoryCreatedIdx: index("agent_memory_revisions_memory_created_idx").on(
      table.companyId, table.memoryId, table.createdAt,
    ),
    runIdx: index("agent_memory_revisions_run_idx").on(table.createdByRunId),
  }),
);
```

### 1.3 Inline migration SQL (reference — for implementation issue to regenerate via drizzle-kit)

```sql
-- 0090_agent_memory.sql  (DRAFT — NOT APPLIED. Implementation issue must regenerate via drizzle-kit.)
CREATE TABLE IF NOT EXISTS "agent_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "scope" text NOT NULL,
  "scope_agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "scope_project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "latest_revision_id" uuid,
  "latest_revision_number" integer NOT NULL DEFAULT 0,
  "latest_value_json" jsonb,
  "latest_value_text" text,
  "visibility" text NOT NULL DEFAULT 'normal',
  "private_prompt_data" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'active',
  "expires_at" timestamptz,
  "forgotten_at" timestamptz,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_by_user_id" text,
  "updated_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "updated_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_memory_scope_shape_chk" CHECK (
    (scope = 'company'       AND scope_agent_id IS NULL     AND scope_project_id IS NULL)
    OR (scope = 'agent'        AND scope_agent_id IS NOT NULL AND scope_project_id IS NULL)
    OR (scope = 'agent_project' AND scope_agent_id IS NOT NULL AND scope_project_id IS NOT NULL)
  ),
  CONSTRAINT "agent_memory_status_chk" CHECK (status IN ('active', 'expired', 'forgotten')),
  CONSTRAINT "agent_memory_visibility_chk" CHECK (visibility IN ('normal', 'agent_only', 'redacted_only')),
  CONSTRAINT "agent_memory_latest_revision_invariant_chk" CHECK (
    (latest_revision_number = 0 AND latest_revision_id IS NULL AND latest_value_json IS NULL AND latest_value_text IS NULL)
    OR (latest_revision_number >= 1 AND latest_revision_id IS NOT NULL)
  )
);
--> statement-breakpoint
-- Null-safe scope-tuple uniqueness via three partial unique indexes.
-- A plain `UNIQUE (company_id, scope, scope_agent_id, scope_project_id, key)` is
-- NOT sufficient on PostgreSQL: NULLs in scope_agent_id / scope_project_id are
-- treated as distinct, so duplicates would slip through for company and agent
-- scopes. PostgreSQL 15+ alternative: a single index with NULLS NOT DISTINCT.
-- See https://www.postgresql.org/docs/current/indexes-unique.html.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_memory_scope_company_key_uq"
  ON "agent_memory" ("company_id", "key")
  WHERE scope = 'company' AND scope_agent_id IS NULL AND scope_project_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_memory_scope_agent_key_uq"
  ON "agent_memory" ("company_id", "scope_agent_id", "key")
  WHERE scope = 'agent' AND scope_agent_id IS NOT NULL AND scope_project_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_memory_scope_agent_project_key_uq"
  ON "agent_memory" ("company_id", "scope_agent_id", "scope_project_id", "key")
  WHERE scope = 'agent_project' AND scope_agent_id IS NOT NULL AND scope_project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_company_updated_idx"
  ON "agent_memory" ("company_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_agent_idx"
  ON "agent_memory" ("scope_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_expires_idx"
  ON "agent_memory" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_value_text_search_idx"
  ON "agent_memory" USING gin ("latest_value_text" gin_trgm_ops);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_memory_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "memory_id" uuid NOT NULL REFERENCES "agent_memory"("id") ON DELETE CASCADE,
  "revision_number" integer NOT NULL,
  "value_json" jsonb,
  "value_text" text,
  "change_summary" text,
  "source" jsonb NOT NULL,
  "supersedes_revision_id" uuid,
  "redaction" jsonb NOT NULL DEFAULT '{"keyRedactedPaths":[],"jsonTextRedactedPaths":[],"textRedactionApplied":false,"acknowledged":false}'::jsonb,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_by_user_id" text,
  "created_by_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_memory_revisions_memory_revision_uq"
  ON "agent_memory_revisions" ("memory_id", "revision_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_revisions_memory_created_idx"
  ON "agent_memory_revisions" ("company_id", "memory_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_revisions_run_idx"
  ON "agent_memory_revisions" ("created_by_run_id");
```

## 2. Zod schemas (shared)

Add to `packages/shared/src/validators/agent_memory.ts`:

```ts
import { z } from "zod";

export const memoryScopeSchema = z.enum(["company", "agent", "agent_project"]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryVisibilitySchema = z.enum(["normal", "agent_only", "redacted_only"]);
export const memoryStatusSchema = z.enum(["active", "expired", "forgotten"]);

export const memorySourceKindSchema = z.enum([
  "human_message",
  "agent_self",
  "run_observation",
  "imported",
  "system",
  "external_tool",
  "rollback",
]);

export const memorySourceSchema = z.object({
  kind: memorySourceKindSchema,
  runId: z.string().uuid().nullable().optional(),
  commentId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  issueId: z.string().uuid().nullable().optional(),
  externalRef: z
    .object({
      system: z.string().min(1).max(80),
      id: z.string().min(1).max(200),
      url: z.string().url().nullable().optional(),
    })
    .nullable()
    .optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  rollbackFromRevisionId: z.string().uuid().nullable().optional(),
});

export const memoryKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9_\-:.]*$/, "lowercase alphanumeric with _-:. allowed");

export const upsertAgentMemorySchema = z
  .object({
    companyId: z.string().uuid(),
    scope: memoryScopeSchema,
    scopeAgentId: z.string().uuid().nullable().optional(),
    scopeProjectId: z.string().uuid().nullable().optional(),
    key: memoryKeySchema,
    valueJson: z.unknown().optional(),
    valueText: z.string().max(64_000).optional(),
    changeSummary: z.string().max(500).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    visibility: memoryVisibilitySchema.default("normal"),
    privatePromptData: z.boolean().default(false),
    source: memorySourceSchema,
    baseRevisionId: z.string().uuid().nullable().optional(), // optimistic concurrency
    acknowledgeRedaction: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.scope === "agent" || v.scope === "agent_project") {
      if (!v.scopeAgentId) ctx.addIssue({ code: "custom", message: "scopeAgentId required for scope=agent|agent_project", path: ["scopeAgentId"] });
    }
    if (v.scope === "agent_project") {
      if (!v.scopeProjectId) ctx.addIssue({ code: "custom", message: "scopeProjectId required for scope=agent_project", path: ["scopeProjectId"] });
    }
    if (v.scope === "company") {
      if (v.scopeAgentId || v.scopeProjectId) ctx.addIssue({ code: "custom", message: "scopeAgentId/scopeProjectId must be null for scope=company", path: ["scope"] });
    }
    if (v.valueJson === undefined && v.valueText === undefined) {
      ctx.addIssue({ code: "custom", message: "at least one of valueJson or valueText is required", path: ["valueJson"] });
    }
  });
export type UpsertAgentMemoryInput = z.infer<typeof upsertAgentMemorySchema>;

export const listAgentMemoryQuerySchema = z.object({
  companyId: z.string().uuid(),
  scope: memoryScopeSchema.optional(),
  scopeAgentId: z.string().uuid().optional(),
  scopeProjectId: z.string().uuid().optional(),
  keyPrefix: z.string().max(120).optional(),
  includeExpired: z.boolean().default(false),
  includeForgotten: z.boolean().default(false),
  asOf: z.string().datetime().optional(), // replay timestamp
  limit: z.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
});

export const rollbackAgentMemorySchema = z.object({
  companyId: z.string().uuid(),
  memoryId: z.string().uuid(),
  targetRevisionId: z.string().uuid(),
  changeSummary: z.string().max(500).optional(),
});

export const forgetAgentMemorySchema = z.object({
  companyId: z.string().uuid(),
  memoryId: z.string().uuid(),
  reason: z.string().min(3).max(500),
  hardDelete: z.boolean().default(false), // soft by default; hard deletes revisions
});
```

## 3. REST API

All routes under `server/src/routes/agent_memory.ts`, mounted alongside existing `issues.ts`/`documents.ts`.

| Method | Path | Body / Query | Returns | Auth scope |
|---|---|---|---|---|
| `POST` | `/api/companies/:companyId/memory` | `upsertAgentMemorySchema` | created/updated `agent_memory` row + latest revision | company member; agents auth as themselves |
| `GET`  | `/api/companies/:companyId/memory` | `listAgentMemoryQuerySchema` | paginated rows (latest revision only; respects `visibility`) | company member |
| `GET`  | `/api/companies/:companyId/memory/:memoryId/revisions` | `?limit=&cursor=` | revision list (no body for `agent_only` unless caller is the owning agent) | company member |
| `GET`  | `/api/companies/:companyId/memory/:memoryId/diff` | `?from=<rev>&to=<rev>` | `{ unifiedDiff?: string; jsonPatch?: RFC6902[]; truncated?: { reason: "size_cap"; cap: number; originalSize: number } }` | company member |
| `POST` | `/api/companies/:companyId/memory/:memoryId/rollback` | `rollbackAgentMemorySchema` | new revision | company member with `memory.rollback` capability |
| `POST` | `/api/companies/:companyId/memory/:memoryId/forget` | `forgetAgentMemorySchema` | status update | company member with `memory.forget` capability |
| `GET`  | `/api/agents/:agentId/memory` | scope filter convenience | same as `/companies/.../memory?scopeAgentId=` | agent's company members |

**Cross-company isolation**: every route resolves `companyId` from the path and rejects (HTTP 403) any record whose `company_id` does not match — same guard as `documents`.

## 4. Service contract (`server/src/services/agent_memory.ts`)

```ts
export interface AgentMemoryService {
  upsert(input: UpsertAgentMemoryInput, ctx: ActorContext): Promise<UpsertResult>;
  list(query: ListAgentMemoryQuery, ctx: ActorContext): Promise<PaginatedMemory>;
  getRevisions(memoryId: string, ctx: ActorContext): Promise<MemoryRevisionPage>;
  diff(memoryId: string, from: string, to: string, ctx: ActorContext): Promise<MemoryDiff>;
  rollback(input: RollbackAgentMemoryInput, ctx: ActorContext): Promise<UpsertResult>;
  forget(input: ForgetAgentMemoryInput, ctx: ActorContext): Promise<{ memoryId: string; status: "forgotten" }>;
  sweepExpired(now: Date): Promise<{ expired: number }>; // scheduled job
}
```

### 4.1 `upsert` flow

1. Validate input via Zod.
2. Resolve existing row by the scope-appropriate identity tuple:
   - `scope=company`: `(companyId, key)` with `scope_agent_id IS NULL AND scope_project_id IS NULL`.
   - `scope=agent`: `(companyId, scopeAgentId, key)` with `scope_project_id IS NULL`.
   - `scope=agent_project`: `(companyId, scopeAgentId, scopeProjectId, key)`.
   This matches the three partial unique indexes in §1.1 and avoids relying on PostgreSQL's null-distinct semantics; any duplicate violates the matching partial index and surfaces as `23505 unique_violation`.
3. Enforce optimistic concurrency: if `baseRevisionId` is provided and != `latestRevisionId`, reject HTTP 409.
4. Run redaction. **`server/src/redaction.ts` is reused unchanged**; the memory service owns a thin two-pass wrapper (see §7.7). Steps:
   - `valueJson` → call `sanitizeMemoryJson(valueJson)`. The returned object carries `{ sanitized, redactedPaths, jsonTextRedactedPaths }`. The first array is dot-paths where `sanitizeRecord` redacted in pass 1 — via either branch (a) key-name match (`SECRET_PAYLOAD_KEY_RE`) or branch (b) value-shape match (anchored `JWT_VALUE_RE`) on a string-valued object property; the second is dot-paths to string leaves (under neutral keys, prefixed strings, or array indices) whose content was rewritten by `redactSensitiveText` during the second pass. Both arrays are persisted; the value the database sees is `sanitized`.
   - `valueText` → call `sanitizeTextWithFlag(valueText)`. Track `textRedactionApplied = result.redacted`.
5. If `redactedPaths.length > 0` or `jsonTextRedactedPaths.length > 0` or `textRedactionApplied` is true, and `acknowledgeRedaction !== true`, return HTTP 422 with `{ code: "REDACTION_REQUIRED", redactedPaths, jsonTextRedactedPaths, textRedactionApplied }` so the caller can decide. The two redaction-path arrays are returned separately (not merged) so the caller can tell whether the offending content was a pass-1 `sanitizeRecord` hit (key-name branch OR JWT value-shape branch) or a pass-2 `redactSensitiveText` rewrite.
6. Resolve `current = existingRow?.latestRevisionNumber ?? 0`. For a brand-new row, `current = 0`. Insert the parent row first (if missing) with `latest_revision_number = 0` and the latest_* fields NULL — this satisfies the `agent_memory_latest_revision_invariant_chk` check. Then insert the new `agent_memory_revisions` row with `revisionNumber = current + 1` and `supersedesRevisionId = existingRow?.latestRevisionId ?? null`. First revision is always `revisionNumber = 1`.
7. Update `agent_memory` to point `latestRevisionId/Number/ValueJson/ValueText` to the new revision; bump `updatedAt`. The parent insert (step 6) and the update here happen in the same transaction, so external readers never observe the transient `latest_revision_number = 0` state.
8. Write `activity_log { entityType: "agent_memory", action: "memory.create"|"memory.update", details: { revisionNumber, scope, key, keyRedactedPathCount: redactedPaths.length, jsonTextRedactedPathCount: jsonTextRedactedPaths.length, textRedactionApplied } }`. `memory.create` fires when the parent row was newly inserted; `memory.update` fires when it already existed. The two redaction-path counts are reported separately so audit dashboards can tell whether the offending content was a pass-1 `sanitizeRecord` hit (key-name branch OR JWT value-shape branch) or a pass-2 `redactSensitiveText` rewrite. (Field name `keyRedactedPathCount` is historical and retained for compatibility with existing audit consumers; it now counts both pass-1 branches.)

All in a single transaction. (No background work in the hot path.)

### 4.2 `diff` flow

- Fetch both revisions, enforce visibility (caller must be allowed to read both).
- If both have `valueText` and no `valueJson`: return `unifiedDiff` via the `diff` npm package (already a dev dependency; if not, add to `server/`).
- Otherwise: compute RFC 6902 JSON Patch via `fast-json-patch`.
- Always run the redaction pass on the output (defense-in-depth) before returning.
- **Output-size bound (applies to REST and MCP).** Cap the serialized diff body at `DIFF_MAX_BYTES = 100 KiB` (constant exported from `server/src/services/agent_memory.ts`). If the rendered `unifiedDiff` or `jsonPatch` payload exceeds the cap, return a truncated payload plus `truncated: { reason: "size_cap", cap: 102400, originalSize: <bytes> }`. Truncation strategy: for `unifiedDiff`, keep the first `cap` bytes of the rendered text and append a single `... [truncated: N bytes hidden] ...` line at the cut point; for `jsonPatch`, keep the longest prefix of ops whose total serialized size fits under the cap and report the dropped op count in `truncated.originalSize`. The MCP wrapper (§5) reuses the same bound and surfaces the same `truncated` field — no second, looser limit is allowed. Rationale: keeps both surfaces (HTTP and MCP) from leaking large diffs in logs or prompt context, and matches the validation contract §6 "100KB" expectation.

### 4.3 `rollback` flow

1. Resolve current latest revision and target revision; both must belong to same `memoryId`.
2. Create a new revision whose `value_json/value_text` equals target's, `source.kind = "rollback"`, `source.rollbackFromRevisionId = currentLatestRevisionId`, `changeSummary = caller-provided or auto`.
3. Update `agent_memory` materialized columns. Audit log action `memory.rollback`.

### 4.4 Scope resolution for reads

`list` with `scope` unset returns the union most-specific-wins. For an agent calling `GET /api/agents/:agentId/memory?scopeProjectId=P`:

- Returns the merged set of:
  - `scope=agent_project AND scopeAgentId=A AND scopeProjectId=P`
  - `scope=agent AND scopeAgentId=A` (only keys not present in the more-specific set)
  - `scope=company` (only keys not present above)
- Each returned entry is annotated with `resolvedFromScope` so the caller knows where it came from.

### 4.5 Expiry

Cron / scheduled task `sweepExpired(now)`:

- `UPDATE agent_memory SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < now`
- Emits one `activity_log` row per swept entry (action `memory.expire`) with `details: { memoryId, expiresAt }`.
- Expired entries remain readable via `includeExpired=true`; their revisions are never deleted by the sweep.

### 4.6 Forget (privacy/right-to-be-forgotten)

- `hardDelete=false` (default): set `status='forgotten'`, set `forgottenAt = now`, null out `latest_value_json/Text`. Revisions retained for audit / replay tombstoning.
- `hardDelete=true`: delete *all* revisions and the parent row in a single transaction. Audit log retains the action with `details: { memoryId, scope, key, reason, hardDelete: true, revisionCount }` so the act of forgetting is itself auditable. Capability `memory.forget.hard` required (company-admin-only).

**Replay interaction (binding for LET-407-D).** Hard forget is destructive; the `agent_memory` and `agent_memory_revisions` rows no longer exist. Therefore:

- Soft forget (`hardDelete=false`): replay endpoints (integration §2) MAY surface the entry with `value=null` and `forgottenLater=true` when `forgottenAt > asOf`. When `forgottenAt <= asOf`, the entry is treated as already-forgotten at run time and is omitted (the agent did not see it).
- Hard forget (`hardDelete=true`): replay endpoints MUST NOT synthesize a tombstone from the deleted memory table. The `activity_log` row created by the forget action is the sole audit artifact and is queried separately (e.g., `/api/runs/:runId/audit`). `forgottenLater=true` never appears for hard-forgotten entries because there is no parent row to attach it to.

This split is required so that "right to be forgotten" (hard delete) leaves no addressable record in the memory replay surface, while soft forget preserves the "agent saw something here" signal for compliance trails.

## 5. MCP tools (agent-facing)

Add to the `paperclip` MCP server:

| Tool | Purpose | Notes |
|---|---|---|
| `paperclipUpsertAgentMemory` | wrapper over POST `/memory` | Required: `companyId`, `scope`, `key`, `source`. |
| `paperclipListAgentMemory` | wrapper over GET `/memory` | Defaults to caller agent's scope. |
| `paperclipGetAgentMemoryRevisions` | revisions for one memory id | — |
| `paperclipDiffAgentMemoryRevisions` | diff two revisions | — |
| `paperclipRollbackAgentMemory` | rollback to target | Capability-gated. |
| `paperclipForgetAgentMemory` | forget an entry | Capability-gated; `reason` required. |

All tools 422 on redaction without `acknowledgeRedaction:true`. Tools never return `private_prompt_data: true` entries except to the owning agent's own session.

## 6. Capabilities

### 6.1 Where this registry lives in the repo

The Paperclip codebase as of LET-407 has two existing capability modules under `packages/shared/src/`:

- `packages/shared/src/agent-capabilities.ts` — Zod schema for an agent's desired MCP/skill/tool *config* (MCP server bindings, secret name refs, apply-preview proposal). It is config, not an ACL gate.
- `packages/shared/src/capability-apply.ts` — apply-plan builder over that config.

Neither file defines a registry of named gate-capabilities like `memory.*` with default-holder roles. There is no `packages/shared/src/capabilities/` directory today (verified against this branch). The memory ACL gates therefore land in a **new sibling module**:

- **New file**: `packages/shared/src/agent-memory-capabilities.ts`. Exports a const tuple `MEMORY_CAPABILITIES` and a `MEMORY_CAPABILITY_DEFAULT_HOLDERS` record mapping each capability to the default holder roles from §6.2. Also exports a `MemoryCapability` union type and a guard `isMemoryCapability(value: string): value is MemoryCapability`.
- **New tests**: `packages/shared/src/__tests__/agent-memory-capabilities.test.ts` (vitest), covering: list completeness against §6.2, holder role values are valid `AGENT_ROLES` strings (re-using the existing `AGENT_ROLES` export from `packages/shared/src/index.ts`), guard rejects unknown strings.
- **Re-export wiring**: add to `packages/shared/src/index.ts` next to the existing `agentCapability*` exports:
  ```ts
  export {
    MEMORY_CAPABILITIES,
    MEMORY_CAPABILITY_DEFAULT_HOLDERS,
    isMemoryCapability,
    type MemoryCapability,
  } from "./agent-memory-capabilities.js";
  ```
- **Existing files are NOT edited**: `packages/shared/src/agent-capabilities.ts` and `packages/shared/src/capability-apply.ts` remain unchanged. The memory gate registry is intentionally separate so it can be referenced from server route guards and MCP tools without coupling to the MCP-config schema.

The server-side enforcement helper (`server/src/services/agent_memory_capability_guard.ts`, new in LET-407-A) reads the role of the caller from `ActorContext`, looks up the required capability in `MEMORY_CAPABILITY_DEFAULT_HOLDERS`, and returns `{ allowed, requiredCapability, callerRole }`. The HTTP layer (§3) and MCP tools (§5) call this guard; on `allowed=false` they return `403 { code: "CAPABILITY_REQUIRED", capability }`.

### 6.2 Capabilities and default holders

Holder values are exactly the machine-readable strings consumed by `MEMORY_CAPABILITY_DEFAULT_HOLDERS` and the `agent_memory_capability_guard` (§6.1). Every entry is either:

- a string from `AGENT_ROLES` (`packages/shared/src/constants.ts`): `ceo | cto | cmo | cfo | security | engineer | designer | pm | qa | devops | researcher | general`, or
- one of two sentinels: `every_agent_in_company` (the guard short-circuits to `allowed=true` for any agent caller in the same company) and `user_admin` (the guard requires a human caller with the company-admin user permission; agent callers are denied).

No display labels (`CEO`, `Architect`, `Reviewer`, `Compliance`, `Orchestrator`) appear in this table — those have caused implementation-time mapping ambiguity in prior reviews and are not present in `AGENT_ROLES`. The agent archetype mapping the table uses is:

- "Orchestrator" / planning lead → `cto`. The EAOS Claude Architect (CTO role) is the orchestrator for cross-company memory writes; no separate `orchestrator` role exists in `AGENT_ROLES`.
- "Architect" → `cto`.
- "Reviewer" → `qa`.
- "Compliance" → `security`.
- "Company admin (human)" → `user_admin` sentinel.

| Capability | Default holders (machine-readable) | Notes |
|---|---|---|
| `memory.read` | `["every_agent_in_company"]` | reads own scope + company; respects visibility |
| `memory.write` | `["every_agent_in_company"]` | writes to `scope=agent` or `scope=agent_project` for self |
| `memory.write_company` | `["ceo", "cto"]` | only roles that can write `scope=company` (CEO + Architect/Orchestrator = CTO) |
| `memory.rollback` | `["ceo", "cto", "qa"]` | CEO + Architect (`cto`) + Reviewer (`qa`) |
| `memory.forget` | `["ceo", "security"]` | soft forget; compliance owner is `security` |
| `memory.forget.hard` | `["user_admin"]` | hard delete; agent callers always denied — `user_admin` is the human-only sentinel |
| `memory.export` | `["ceo", "security"]` | compliance / subject-access export (LET-407-E). Output runs through redaction (§7) and respects caller visibility; capability is required even for `ceo` so the export action is always explicit and audited. |

Authority-of-source rule for the implementer of LET-407-B: the literal `MEMORY_CAPABILITY_DEFAULT_HOLDERS` map in `packages/shared/src/agent-memory-capabilities.ts` MUST equal the table above key-for-key and value-for-value (set equality on each holder array; order is not significant). Validation contract §2.4 pins this equality.

If the canonical capability module path moves before LET-407-A lands (for example, if the `agent-capabilities.ts` module is folded into a new `packages/shared/src/capabilities/` directory by another lane), the implementer of LET-407-A MUST update §6.1 of this contract in the same PR rather than silently writing the new file into a stale path. If `AGENT_ROLES` itself changes (a role is added or renamed), the implementer of any lane touching this table MUST update both the table and §2.4 tests in the same PR, otherwise the equality test fails CI.

## 7. Redaction boundary — full rules

This is the acceptance gate on "no raw secrets or private prompt data are exposed".

1. **Write-time scrub (two-pass).** `valueJson` is passed through `sanitizeMemoryJson` (§7.7). Pass 1 is `sanitizeRecord` from `server/src/redaction.ts` and has two redaction branches that both fire on object property values: branch (a) **key-name match** via `SECRET_PAYLOAD_KEY_RE`, and branch (b) **value-shape match** via anchored `JWT_VALUE_RE` with no per-segment length gate (see the `JWT_VALUE_RE` declaration and the corresponding `typeof value === "string" && JWT_VALUE_RE.test(value)` branch inside `sanitizeRecord` in `server/src/redaction.ts`; pinned by symbol, not line number, so the citation does not rot when the file is reformatted). Branch (b) means a bare dotted-JWT-shaped string under *any* object key is redacted in pass 1 — for example `{ notes: "eyJabc.def.ghi" }` (segments 6/3/3) and `{ notes: "eyJhbGciOi.eyJpYXQiOj.signature01" }` (segments 10/10/11) both land here, and both record `redactedPaths:["notes"]`. Pass 2 walks the result and runs `redactSensitiveText` over every remaining string leaf so secret-shaped content under neutral keys that survived pass 1 (e.g. `{ notes: "Authorization: Bearer eyJabc.def.ghi" }` — matches pass-2 shape (2); or `{ notes: "Bearer eyJhbGciOi.eyJpYXQiOj.signature01" }` whose `Bearer ` prefix broke pass-1 branch (b)'s anchored match — matches pass-2 shape (7)) or inside arrays (e.g. `{ tokens: ["plain", "sk-live-..."] }`, since pass 1 does not inspect array elements) is rewritten. The two passes produce two disjoint dot-path arrays (`keyRedactedPaths`, `jsonTextRedactedPaths`), both persisted in `agent_memory_revisions.redaction`. `valueText` is run through `sanitizeTextWithFlag` (`redactSensitiveText` + diff flag). Coverage is limited to the 15 KEY-NAME categories and JWT_VALUE_RE in pass 1 plus the seven content shapes enumerated in validation contract §2.3 pass-2: a bare opaque `Bearer <token>` without the `Authorization:` prefix and without a JWT-shaped token is a documented gap (it is rewritten only when the token separately matches another shape).
2. **422 unless acknowledged.** If `redactedPaths`, `jsonTextRedactedPaths`, or `textRedactionApplied` is non-empty/true, write fails with `{ code: "REDACTION_REQUIRED", redactedPaths, jsonTextRedactedPaths, textRedactionApplied }` unless `acknowledgeRedaction:true`. The two redaction-path arrays are kept separate so the caller can tell whether the offending content was a pass-1 `sanitizeRecord` hit (key-name branch OR JWT value-shape branch) or a pass-2 `redactSensitiveText` rewrite. This stops accidental secret persistence while letting an agent intentionally store an already-redacted summary.
3. **No raw secret ever stored.** Even when acknowledged, the persisted value is the *redacted* one. The original raw secret never reaches the database.
4. **`private_prompt_data:true`** flag forbids the value from ever appearing in any non-owner-agent context. Mission Control shows `"<private prompt data — {valueText.length} chars>"`. Replay consumers receive `null` with a `private_prompt_data:true` marker.
5. **Visibility = `agent_only`** is stronger than `private_prompt_data:false`: even the owning company's other agents cannot read it; only the owning agent's session can.
6. **UI screenshots / docs**: when the implementation ships a Mission Control panel, all screenshots in `docs/pr-screenshots/` must use synthetic data, never real customer data. Validation contract §3.4 enforces this.

### 7.7 Memory-specific redaction helper

`server/src/redaction.ts` is reused unchanged, but its built-in coverage is insufficient on its own for `valueJson`: `sanitizeRecord` redacts only on its two pass-1 branches — branch (a) **key-name match** via `SECRET_PAYLOAD_KEY_RE`, and branch (b) **value-shape match** via anchored `JWT_VALUE_RE` on string-valued object properties (no per-segment length gate; runs recursively at every record level via `sanitizeValue → sanitizeRecord`; does not inspect array elements). Strings that survive both pass-1 branches — for example `{ notes: "Authorization: Bearer eyJ….eyJ….sig…" }` (anchored JWT_VALUE_RE doesn't match because of the literal `Authorization: Bearer ` prefix), `{ notes: "OPENAI_API_KEY=sk-live-..." }` (no dotted-JWT shape, neutral key), or `{ tokens: ["plain", "sk-live-..."] }` (array element bypasses pass-1 entirely) — would otherwise pass through `sanitizeRecord` unchanged. That is the gap the fourth-pass QA review (LET-407, 2026-05-18) flagged and the eighth-pass review re-flagged as a docs/source mismatch. The memory service therefore owns a thin wrapper that performs a second pass over every string leaf using the unchanged `redactSensitiveText` helper (matches the seven content shapes enumerated in validation contract §2.3 pass-2; `COMMAND_JWT_RE` has the `{8,}` per-segment gate that pass-1 branch (b) lacks). A bare opaque `Bearer <opaque-token>` string under a neutral key — without the `Authorization:` prefix and without a JWT-shaped token — is **not** rewritten by either pass; that case is the documented gap surfaced in validation §2.3 (the no-raw-secret promise binds the 15 KEY-NAME categories + `JWT_VALUE_RE` value-shape branch of pass 1, plus the seven shapes that `redactSensitiveText` actually matches in pass 2).

```ts
// server/src/services/agent_memory_redaction.ts (new file, owned by LET-407-A)
//
// Composition over modification: this module wraps the unchanged
// `server/src/redaction.ts` so the memory service can persist `valueJson`
// without any raw secret-shaped strings surviving under neutral keys or
// inside arrays, and so 422 responses carry actionable path metadata.

import { REDACTED_EVENT_VALUE, sanitizeRecord, redactSensitiveText } from "../redaction.js";

export interface MemoryJsonRedactionResult {
  /** Fully sanitized `valueJson` ready to persist. */
  sanitized: Record<string, unknown>;
  /**
   * Dot-paths whose value was redacted by `sanitizeRecord` in pass 1 — either via
   * branch (a) key-name match (`SECRET_PAYLOAD_KEY_RE`) or branch (b) value-shape
   * match (anchored `JWT_VALUE_RE`, no per-segment length gate) on a string-valued
   * object property.
   */
  redactedPaths: string[];
  /**
   * Dot-paths to string leaves under neutral keys (or array indices) whose
   * content was rewritten by `redactSensitiveText` during the second pass.
   * Disjoint from `redactedPaths` by construction.
   */
  jsonTextRedactedPaths: string[];
}

/**
 * Two-pass sanitize:
 *   1. `sanitizeRecord(input)` from `server/src/redaction.ts` (unchanged).
 *   2. Deep-walk the result and `redactSensitiveText` every remaining string
 *      leaf, regardless of key name. Record any leaf whose text was actually
 *      rewritten as a `jsonTextRedactedPaths` entry.
 *
 * Array indices are rendered as `[<n>]` (e.g. `cfg.tokens[0]`). Leaves that
 * were already replaced by `REDACTED_EVENT_VALUE` in pass 1 (either via the
 * `SECRET_PAYLOAD_KEY_RE` key-name branch or the `JWT_VALUE_RE` value-shape
 * branch in `sanitizeRecord`) are recorded in `redactedPaths` — never in
 * `jsonTextRedactedPaths` — so the caller can distinguish pass-1 redactions
 * from pass-2 `redactSensitiveText` rewrites for audit.
 */
export function sanitizeMemoryJson(input: Record<string, unknown>): MemoryJsonRedactionResult {
  const firstPass = sanitizeRecord(input);
  const redactedPaths: string[] = [];
  const jsonTextRedactedPaths: string[] = [];
  // pass 1: dot-paths where `sanitizeRecord` already replaced the value.
  walkDiff(input, firstPass, "", redactedPaths);
  // pass 2: rewrite every remaining string leaf via redactSensitiveText.
  const sanitized = sanitizeStringLeaves(firstPass, "", redactedPaths, jsonTextRedactedPaths);
  return { sanitized, redactedPaths, jsonTextRedactedPaths };
}

/** Text-only helper for `valueText`. Returns the rewritten string plus a flag. */
export function sanitizeTextWithFlag(input: string): { sanitized: string; redacted: boolean } {
  const sanitized = redactSensitiveText(input);
  return { sanitized, redacted: sanitized !== input };
}

// `walkDiff` and `sanitizeStringLeaves` are internal; their contracts are
// pinned by validation contract §2.3 tests (neutral-key strings, arrays of
// secret-shaped strings, nested objects, REDACTED_EVENT_VALUE pass-through).
```

Implementation rules:

- The helper file lives at `server/src/services/agent_memory_redaction.ts`. It MAY NOT modify `server/src/redaction.ts`. (If a new global secret pattern is ever needed, that change goes through the redaction module owner, not the memory lane — see integration §7 R2.)
- `sanitizeMemoryJson` is the **only** function the upsert flow (§4.1 step 4) calls for `valueJson`. It guarantees that the persisted JSON contains no string leaf for which `redactSensitiveText` would still rewrite content. This is the second-pass invariant the validation contract §2.3 / §3.4 / §3.5 tests enforce; the "no raw secret-shaped string survives under a neutral JSON key or inside an array" property is exactly that invariant.
- `redactedPaths` (the wrapper-return name for the pass-1 array) is persisted as `agent_memory_revisions.redaction.keyRedactedPaths`. The persisted column name is `keyRedactedPaths` for brevity, but it captures BOTH pass-1 branches: key-name match via `SECRET_PAYLOAD_KEY_RE` AND value-shape match via `JWT_VALUE_RE` on string-valued object properties. `jsonTextRedactedPaths` is persisted under the same name and captures pass-2 `redactSensitiveText` rewrites only. The two arrays are stored separately (contract §1.2 / §1.3) so audit can distinguish pass-1 vs pass-2 redactions without re-running the helper.
- The structured 422 body is `{ code: "REDACTION_REQUIRED", redactedPaths: string[], jsonTextRedactedPaths: string[], textRedactionApplied: boolean }`. The 422 gate in §7.2 fires when `redactedPaths.length > 0 || jsonTextRedactedPaths.length > 0 || textRedactionApplied`. MCP §5 surfaces the same shape so external agents can branch on path content; the wrapper does not collapse `jsonTextRedactedPaths` into `redactedPaths` because the two have different audit semantics.

## 8. Activity log conventions

| `action` | `entity_type` | `entity_id` shape | `details` (JSONB) |
|---|---|---|---|
| `memory.create` | `agent_memory` | `<companyId>:<scope>:<scopeAgentId>:<scopeProjectId>:<key>` | `{ memoryId, revisionNumber, sourceKind, keyRedactedPathCount, jsonTextRedactedPathCount, textRedactionApplied }` |
| `memory.update` | same | same | same + `{ baseRevisionId, conflict: false }` |
| `memory.rollback` | same | same | `{ memoryId, fromRevisionId, toRevisionId, newRevisionNumber }` |
| `memory.expire` | same | same | `{ memoryId, expiresAt }` |
| `memory.forget` | same | same | `{ memoryId, reason, hardDelete, revisionCount }` |
| `memory.read.bulk` | `agent_memory_query` | `<companyId>:<callerActorId>` | `{ count, scopeFilter, asOf }` |

`memory.read` single-row reads are **not** logged (would dominate the log; bulk reads carry the count).
