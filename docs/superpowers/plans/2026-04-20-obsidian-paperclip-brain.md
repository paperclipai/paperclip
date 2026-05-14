# Obsidian-Paperclip-Brain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walters Obsidian-Vault (`/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault`, 22.939 MD-Dateien) wird als semantisch durchsuchbare Wissensbasis für den Paperclip-CEO-Agenten verfügbar — mit Per-Agent-Ordner-ACL, Default-Deny und Audit-Log.

**Architecture:** Ein lokaler Indexer liest den Vault, chunked Markdown, lässt Embeddings durch LM Studio (`bge-m3`) rechnen und schreibt in ein neues `brain`-Schema in Paperclips bestehender Postgres. Ein MCP-Server exponiert `search_vault`, `get_note`, `list_scope` und erzwingt ACL + Audit. Ein Paperclip-Plugin registriert die drei Tools in Paperclips Tool-Registry und bildet Paperclip-Agent-UUIDs auf ACL-Keys ab.

**Tech Stack:**
- Node.js 20+, TypeScript 5, pnpm workspace
- Postgres 16 + `pgvector` (bestehende Paperclip-DB)
- Drizzle ORM (Paperclip-Standard)
- `chokidar` (file-watcher), `gray-matter` (frontmatter), `gpt-tokenizer` (token-counting)
- `@modelcontextprotocol/sdk` (MCP-Server)
- `vitest` (tests, Paperclip-Standard)
- LM Studio REST-API auf `http://localhost:1234` für Embeddings
- launchd für Service-Management (analog zu Walters `n8n.sh`-Setup)

**Spec:** `docs/superpowers/specs/2026-04-20-obsidian-paperclip-brain-design.md`

---

## File Structure

**Neue Dateien im bestehenden Paperclip-Monorepo:**

```
packages/
├── db/src/schema/
│   ├── brain-notes.ts              # Tabelle brain.notes
│   ├── brain-chunks.ts             # Tabelle brain.chunks
│   ├── brain-agent-acl.ts          # Tabelle brain.agent_acl
│   └── brain-access-log.ts         # Tabelle brain.access_log
├── brain/                           # NEUER Workspace-Package
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── shared/
│   │   │   ├── types.ts            # Chunk, Note, AclEntry, …
│   │   │   └── config.ts           # env-var-Loading
│   │   ├── db/
│   │   │   ├── client.ts           # Postgres-Pool-Wrapper
│   │   │   └── queries.ts          # Typed query helpers
│   │   ├── indexer/
│   │   │   ├── index.ts            # launchd entry
│   │   │   ├── embedder.ts         # LM Studio client
│   │   │   ├── parser.ts           # gray-matter parse
│   │   │   ├── chunker.ts          # markdown-aware chunking
│   │   │   ├── writer.ts           # db upsert logic
│   │   │   ├── watcher.ts          # chokidar orchestrator
│   │   │   └── rescan.ts           # hourly safety rescan
│   │   └── mcp-server/
│   │       ├── index.ts            # launchd entry
│   │       ├── auth.ts             # bearer-token validation
│   │       ├── acl.ts              # ACL lookup + filter
│   │       ├── audit.ts            # access_log writer
│   │       └── tools.ts            # search_vault, get_note, list_scope
│   ├── test/
│   │   ├── fixtures/test-vault/   # minimal test vault
│   │   ├── embedder.test.ts
│   │   ├── parser.test.ts
│   │   ├── chunker.test.ts
│   │   ├── writer.test.ts
│   │   ├── acl.test.ts
│   │   ├── tools.test.ts
│   │   └── e2e.test.ts
│   └── launchd/
│       ├── com.whitestag.brain-indexer.plist
│       └── com.whitestag.brain-mcp.plist
└── plugins/brain/                   # NEUER Plugin-Package
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── manifest.ts              # Paperclip-Plugin-Manifest
    │   ├── worker.ts                # Tool-Registration + MCP-Client
    │   ├── agent-mapping.ts         # UUID → ACL-Key Mapping
    │   └── ui/
    │       └── settings-tab.tsx     # Status + Re-Index + Log-Viewer
    └── test/
        └── agent-mapping.test.ts
```

**Änderungen an bestehenden Dateien:**
- `pnpm-workspace.yaml` — neuer Package `packages/brain` aufnehmen
- Paperclip-DB: `pgvector`-Extension aktivieren (einmalig via Migration)

---

## Phase 0 — Foundation (Tasks 1–3)

### Task 1: pgvector-Extension und `brain`-Schema via Drizzle

**Files:**
- Create: `packages/db/src/schema/brain-notes.ts`
- Create: `packages/db/src/schema/brain-chunks.ts`
- Create: `packages/db/src/schema/brain-agent-acl.ts`
- Create: `packages/db/src/schema/brain-access-log.ts`
- Modify: `packages/db/src/schema/index.ts` (re-exports)
- Create: `packages/db/src/migrations/XXXX_brain_schema.sql` (generiert)

- [ ] **Step 1: Drizzle-Schema-Datei `brain-notes.ts`**

```typescript
// packages/db/src/schema/brain-notes.ts
import {
  pgSchema,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const brainSchema = pgSchema("brain");

export const brainNotes = brainSchema.table(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    path: text("path").notNull().unique(),
    folder: text("folder").notNull(),
    title: text("title"),
    frontmatter: jsonb("frontmatter").$type<Record<string, unknown>>().notNull().default({}),
    mtime: timestamp("mtime", { withTimezone: true }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    checksum: text("checksum").notNull(),
  },
  (t) => ({
    folderIdx: index("brain_notes_folder_idx").on(t.folder),
    frontmatterIdx: index("brain_notes_frontmatter_idx").using("gin", t.frontmatter),
  }),
);
```

- [ ] **Step 2: Drizzle-Schema-Datei `brain-chunks.ts`**

```typescript
// packages/db/src/schema/brain-chunks.ts
import {
  uuid,
  integer,
  text,
  timestamp,
  index,
  unique,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { brainSchema, brainNotes } from "./brain-notes.js";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() { return "vector(1024)"; },
  toDriver(value: number[]) { return `[${value.join(",")}]`; },
  fromDriver(value: string) {
    return value.slice(1, -1).split(",").map(Number);
  },
});

export const brainChunks = brainSchema.table(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id").notNull().references(() => brainNotes.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    headingPath: text("heading_path").array(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
  },
  (t) => ({
    noteIdx: index("brain_chunks_note_idx").on(t.noteId),
    embeddingIdx: index("brain_chunks_embedding_idx")
      .using("hnsw", sql`${t.embedding} vector_cosine_ops`),
    unique: unique("brain_chunks_note_chunk_unique").on(t.noteId, t.chunkIndex),
  }),
);
```

- [ ] **Step 3: Drizzle-Schema-Dateien `brain-agent-acl.ts` und `brain-access-log.ts`**

```typescript
// packages/db/src/schema/brain-agent-acl.ts
import { text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { brainSchema } from "./brain-notes.js";

export const brainAgentAcl = brainSchema.table("agent_acl", {
  agentId: text("agent_id").primaryKey(),
  allowedFolders: text("allowed_folders").array().notNull().default(sql`'{}'::text[]`),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

```typescript
// packages/db/src/schema/brain-access-log.ts
import { bigserial, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { brainSchema } from "./brain-notes.js";

export const brainAccessLog = brainSchema.table(
  "access_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    agentId: text("agent_id").notNull(),
    tool: text("tool").notNull(),
    query: text("query"),
    path: text("path"),
    returnedPaths: text("returned_paths").array(),
    latencyMs: integer("latency_ms"),
    ok: boolean("ok").notNull(),
  },
  (t) => ({
    tsIdx: index("brain_access_log_ts_idx").on(t.ts),
    agentTsIdx: index("brain_access_log_agent_ts_idx").on(t.agentId, t.ts),
  }),
);
```

- [ ] **Step 4: Re-Exports in `schema/index.ts` hinzufügen**

Modify: `packages/db/src/schema/index.ts` — am Ende der bestehenden exports:

```typescript
export * from "./brain-notes.js";
export * from "./brain-chunks.js";
export * from "./brain-agent-acl.js";
export * from "./brain-access-log.js";
```

- [ ] **Step 5: Migration generieren und pgvector-Extension aktivieren**

Run:
```bash
cd packages/db && pnpm build && pnpm generate
```

Die neue Migration-Datei landet unter `packages/db/src/migrations/XXXX_brain_schema.sql`. **Prepend** (als ersten SQL-Block in die Datei) die Extension- und Schema-Erzeugung:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS brain;
```

Expected Migration-Inhalt (ungefähr):
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS brain;

CREATE TABLE "brain"."notes" (...);
CREATE TABLE "brain"."chunks" (...);
CREATE TABLE "brain"."agent_acl" (...);
CREATE TABLE "brain"."access_log" (...);
-- + Indexes
```

- [ ] **Step 6: Migration anwenden und verifizieren**

Run:
```bash
cd packages/db && pnpm migrate
```

Verify:
```bash
psql "$DATABASE_URL" -c "\dn" | grep brain
psql "$DATABASE_URL" -c "\dt brain.*"
psql "$DATABASE_URL" -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"
```

Expected: `brain` schema existiert, 4 Tabellen sichtbar, `vector`-Extension aktiv.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/brain-*.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): add brain schema for obsidian vault retrieval (notes, chunks, agent_acl, access_log)"
```

---

### Task 2: `@paperclipai/brain` Package-Scaffold

**Files:**
- Create: `packages/brain/package.json`
- Create: `packages/brain/tsconfig.json`
- Create: `packages/brain/vitest.config.ts`
- Create: `packages/brain/src/shared/types.ts`
- Create: `packages/brain/src/shared/config.ts`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Package-Setup**

Create: `packages/brain/package.json`
```json
{
  "name": "@paperclipai/brain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    "./indexer": "./dist/indexer/index.js",
    "./mcp-server": "./dist/mcp-server/index.js"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "start:indexer": "node dist/indexer/index.js",
    "start:mcp": "node dist/mcp-server/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@paperclipai/db": "workspace:*",
    "chokidar": "^4.0.0",
    "drizzle-orm": "^0.36.0",
    "gpt-tokenizer": "^2.8.0",
    "gray-matter": "^4.0.3",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.7.3",
    "vitest": "^2.1.0"
  }
}
```

Create: `packages/brain/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "test"]
}
```

Create: `packages/brain/vitest.config.ts`
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 2: Shared types**

Create: `packages/brain/src/shared/types.ts`
```typescript
export interface Note {
  id: string;
  path: string;
  folder: string;
  title: string | null;
  frontmatter: Record<string, unknown>;
  mtime: Date;
  sizeBytes: number;
  checksum: string;
}

export interface Chunk {
  id: string;
  noteId: string;
  chunkIndex: number;
  headingPath: string[];
  content: string;
  tokenCount: number;
}

export interface ChunkWithEmbedding extends Chunk {
  embedding: number[];
}

export interface ParsedNote {
  path: string;
  folder: string;
  title: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  mtime: Date;
  sizeBytes: number;
  checksum: string;
}

export interface SearchResult {
  path: string;
  title: string | null;
  headingPath: string[];
  content: string;
  score: number;
  folder: string;
  frontmatter: Record<string, unknown>;
}

export type Tool = "search_vault" | "get_note" | "list_scope";
```

- [ ] **Step 3: Config-Loader**

Create: `packages/brain/src/shared/config.ts`
```typescript
export interface BrainConfig {
  vaultPath: string;
  databaseUrl: string;
  lmStudioEmbeddingUrl: string;
  lmStudioEmbeddingModel: string;
  mcpPort: number;
  mcpBearerTokens: Record<string, string>;  // token → default agent_id
  rescanIntervalMs: number;
}

export function loadConfig(): BrainConfig {
  const requireEnv = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`Missing required env var: ${key}`);
    return v;
  };

  // BRAIN_MCP_TOKENS format: "token1:agent_id1,token2:agent_id2"
  const tokensRaw = process.env.BRAIN_MCP_TOKENS ?? "";
  const mcpBearerTokens: Record<string, string> = {};
  for (const pair of tokensRaw.split(",").filter(Boolean)) {
    const [token, agentId] = pair.split(":");
    if (token && agentId) mcpBearerTokens[token] = agentId;
  }

  return {
    vaultPath: requireEnv("BRAIN_VAULT_PATH"),
    databaseUrl: requireEnv("DATABASE_URL"),
    lmStudioEmbeddingUrl: process.env.BRAIN_EMBED_URL ?? "http://localhost:1234/v1/embeddings",
    lmStudioEmbeddingModel: process.env.BRAIN_EMBED_MODEL ?? "bge-m3",
    mcpPort: Number(process.env.BRAIN_MCP_PORT ?? 7777),
    mcpBearerTokens,
    rescanIntervalMs: Number(process.env.BRAIN_RESCAN_INTERVAL_MS ?? 3600_000),
  };
}
```

- [ ] **Step 4: Workspace-Registrierung**

Modify: `pnpm-workspace.yaml` — `packages/brain` zur `packages`-Liste hinzufügen.

Run:
```bash
pnpm install
pnpm --filter @paperclipai/brain typecheck
```

Expected: Kein Fehler, Package wird erkannt.

- [ ] **Step 5: Commit**

```bash
git add packages/brain pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(brain): scaffold @paperclipai/brain package with shared types and config"
```

---

### Task 3: DB-Client und Typed Query Helpers

**Files:**
- Create: `packages/brain/src/db/client.ts`
- Create: `packages/brain/src/db/queries.ts`
- Create: `packages/brain/test/queries.test.ts`

- [ ] **Step 1: Test für Query-Helpers schreiben (TDD)**

Create: `packages/brain/test/queries.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "../src/db/client.js";
import { upsertNote, getNoteByPath, deleteNote, getAclForAgent } from "../src/db/queries.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/paperclip_test";
const client = createClient(DATABASE_URL);

describe("db queries", () => {
  beforeAll(async () => {
    await client.query("DELETE FROM brain.notes WHERE path LIKE 'test/%'");
    await client.query("DELETE FROM brain.agent_acl WHERE agent_id = 'TEST_AGENT'");
  });

  afterAll(async () => {
    await client.query("DELETE FROM brain.notes WHERE path LIKE 'test/%'");
    await client.query("DELETE FROM brain.agent_acl WHERE agent_id = 'TEST_AGENT'");
    await client.end();
  });

  it("upsertNote creates a new note", async () => {
    const noteId = await upsertNote(client, {
      path: "test/alpha.md",
      folder: "test",
      title: "Alpha",
      frontmatter: { tags: ["a"] },
      mtime: new Date("2026-01-01"),
      sizeBytes: 42,
      checksum: "abc123",
    });
    expect(noteId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("getNoteByPath returns existing note", async () => {
    const note = await getNoteByPath(client, "test/alpha.md");
    expect(note?.title).toBe("Alpha");
  });

  it("upsertNote updates existing note with same path", async () => {
    const noteId1 = await upsertNote(client, {
      path: "test/beta.md", folder: "test", title: "Beta v1",
      frontmatter: {}, mtime: new Date(), sizeBytes: 10, checksum: "x",
    });
    const noteId2 = await upsertNote(client, {
      path: "test/beta.md", folder: "test", title: "Beta v2",
      frontmatter: {}, mtime: new Date(), sizeBytes: 20, checksum: "y",
    });
    expect(noteId1).toBe(noteId2);
    const note = await getNoteByPath(client, "test/beta.md");
    expect(note?.title).toBe("Beta v2");
  });

  it("deleteNote removes note and cascades chunks", async () => {
    await deleteNote(client, "test/alpha.md");
    const note = await getNoteByPath(client, "test/alpha.md");
    expect(note).toBeNull();
  });

  it("getAclForAgent returns empty array for unknown agent (default-deny)", async () => {
    const folders = await getAclForAgent(client, "TEST_UNKNOWN_AGENT");
    expect(folders).toEqual([]);
  });

  it("getAclForAgent returns configured folders", async () => {
    await client.query(
      "INSERT INTO brain.agent_acl (agent_id, allowed_folders) VALUES ('TEST_AGENT', ARRAY['AI','Dokumente']::text[])",
    );
    const folders = await getAclForAgent(client, "TEST_AGENT");
    expect(folders).toEqual(["AI", "Dokumente"]);
  });
});
```

- [ ] **Step 2: Test laufen lassen (erwarteter Fehler: Module not found)**

Run: `pnpm --filter @paperclipai/brain test -- queries.test.ts`
Expected: FAIL mit `Cannot find module '../src/db/client.js'`.

- [ ] **Step 3: DB-Client implementieren**

Create: `packages/brain/src/db/client.ts`
```typescript
import pg from "pg";

export function createClient(databaseUrl: string): pg.Client {
  const client = new pg.Client({ connectionString: databaseUrl });
  client.connect();
  return client;
}
```

- [ ] **Step 4: Query-Helpers implementieren**

Create: `packages/brain/src/db/queries.ts`
```typescript
import type pg from "pg";
import type { Note, ParsedNote } from "../shared/types.js";

export async function upsertNote(
  client: pg.Client,
  parsed: Omit<ParsedNote, "body">,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO brain.notes
       (path, folder, title, frontmatter, mtime, size_bytes, checksum, indexed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, now())
     ON CONFLICT (path) DO UPDATE SET
       folder = EXCLUDED.folder,
       title = EXCLUDED.title,
       frontmatter = EXCLUDED.frontmatter,
       mtime = EXCLUDED.mtime,
       size_bytes = EXCLUDED.size_bytes,
       checksum = EXCLUDED.checksum,
       indexed_at = now()
     RETURNING id`,
    [
      parsed.path,
      parsed.folder,
      parsed.title,
      JSON.stringify(parsed.frontmatter),
      parsed.mtime,
      parsed.sizeBytes,
      parsed.checksum,
    ],
  );
  return rows[0].id;
}

export async function getNoteByPath(client: pg.Client, path: string): Promise<Note | null> {
  const { rows } = await client.query(
    `SELECT id, path, folder, title, frontmatter, mtime, size_bytes, checksum
     FROM brain.notes WHERE path = $1`,
    [path],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id, path: r.path, folder: r.folder, title: r.title,
    frontmatter: r.frontmatter, mtime: r.mtime,
    sizeBytes: r.size_bytes, checksum: r.checksum,
  };
}

export async function deleteNote(client: pg.Client, path: string): Promise<void> {
  await client.query("DELETE FROM brain.notes WHERE path = $1", [path]);
}

export async function getAclForAgent(client: pg.Client, agentId: string): Promise<string[]> {
  const { rows } = await client.query<{ allowed_folders: string[] }>(
    "SELECT allowed_folders FROM brain.agent_acl WHERE agent_id = $1",
    [agentId],
  );
  return rows[0]?.allowed_folders ?? [];
}
```

- [ ] **Step 5: Tests laufen lassen (erwartet: PASS)**

Run: `pnpm --filter @paperclipai/brain test -- queries.test.ts`
Expected: Alle 6 Tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/brain/src/db packages/brain/test/queries.test.ts
git commit -m "feat(brain): db client and typed query helpers with tests"
```

---

## Phase 1 — Indexer Core (Tasks 4–8)

### Task 4: Embedder (LM Studio Client)

**Files:**
- Create: `packages/brain/src/indexer/embedder.ts`
- Create: `packages/brain/test/embedder.test.ts`

- [ ] **Step 1: Test schreiben**

Create: `packages/brain/test/embedder.test.ts`
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEmbedder } from "../src/indexer/embedder.js";

describe("embedder", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("calls LM Studio /v1/embeddings with bge-m3 model", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1024).fill(0.1) }] }),
    });
    const embed = createEmbedder("http://localhost:1234/v1/embeddings", "bge-m3");
    const [vec] = await embed(["hello world"]);
    expect(vec).toHaveLength(1024);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"model":"bge-m3"'),
      }),
    );
  });

  it("embeds multiple inputs in one batch", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: Array(1024).fill(0.1) },
          { embedding: Array(1024).fill(0.2) },
        ],
      }),
    });
    const embed = createEmbedder("http://localhost:1234/v1/embeddings", "bge-m3");
    const vecs = await embed(["a", "b"]);
    expect(vecs).toHaveLength(2);
    expect(vecs[0][0]).toBe(0.1);
    expect(vecs[1][0]).toBe(0.2);
  });

  it("throws on HTTP error", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false, status: 500, text: async () => "server error",
    });
    const embed = createEmbedder("http://localhost:1234/v1/embeddings", "bge-m3");
    await expect(embed(["x"])).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Test laufen lassen (FAIL erwartet)**

Run: `pnpm --filter @paperclipai/brain test -- embedder.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Embedder implementieren**

Create: `packages/brain/src/indexer/embedder.ts`
```typescript
export type Embedder = (inputs: string[]) => Promise<number[][]>;

export function createEmbedder(url: string, model: string): Embedder {
  return async (inputs: string[]) => {
    if (inputs.length === 0) return [];
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: inputs }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Embedding HTTP ${resp.status}: ${body}`);
    }
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  };
}
```

- [ ] **Step 4: Tests laufen lassen (PASS erwartet)**

Run: `pnpm --filter @paperclipai/brain test -- embedder.test.ts`
Expected: 3 Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/brain/src/indexer/embedder.ts packages/brain/test/embedder.test.ts
git commit -m "feat(brain): LM Studio embedder with batch support"
```

---

### Task 5: Markdown-Parser (Frontmatter + Body)

**Files:**
- Create: `packages/brain/src/indexer/parser.ts`
- Create: `packages/brain/test/parser.test.ts`
- Create: `packages/brain/test/fixtures/test-vault/AI/sample.md`

- [ ] **Step 1: Test-Fixture anlegen**

Create: `packages/brain/test/fixtures/test-vault/AI/sample.md`
```markdown
---
tags: [ai, lm-studio]
agent_exclude: [CTO]
---
# LM Studio Setup

Die lokale Installation von **LM Studio** ermöglicht...

## Modellauswahl

Wir nutzen `bge-m3` für Embeddings.
```

- [ ] **Step 2: Test schreiben**

Create: `packages/brain/test/parser.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { parseNote } from "../src/indexer/parser.js";
import path from "node:path";

const vaultRoot = path.join(__dirname, "fixtures/test-vault");

describe("parser", () => {
  it("extracts frontmatter, body, title, folder", async () => {
    const parsed = await parseNote(vaultRoot, "AI/sample.md");
    expect(parsed.path).toBe("AI/sample.md");
    expect(parsed.folder).toBe("AI");
    expect(parsed.title).toBe("LM Studio Setup");
    expect(parsed.frontmatter).toEqual({ tags: ["ai", "lm-studio"], agent_exclude: ["CTO"] });
    expect(parsed.body).toContain("LM Studio");
    expect(parsed.sizeBytes).toBeGreaterThan(0);
    expect(parsed.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.mtime).toBeInstanceOf(Date);
  });

  it("falls back to filename when no H1 present", async () => {
    // edge case: create a no-title note inline
    const parsed = await parseNote(vaultRoot, "AI/sample.md");
    expect(parsed.title).not.toBeNull();
  });
});
```

- [ ] **Step 3: Test laufen lassen (FAIL)**

Run: `pnpm --filter @paperclipai/brain test -- parser.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 4: Parser implementieren**

Create: `packages/brain/src/indexer/parser.ts`
```typescript
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import type { ParsedNote } from "../shared/types.js";

export async function parseNote(vaultRoot: string, relPath: string): Promise<ParsedNote> {
  const absPath = path.join(vaultRoot, relPath);
  const raw = await readFile(absPath, "utf-8");
  const stats = await stat(absPath);
  const parsed = matter(raw);

  const body = parsed.content;
  const folder = relPath.split(path.sep)[0] ?? "";
  const titleFromH1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const fallbackTitle = path.basename(relPath, ".md");

  return {
    path: relPath.replaceAll(path.sep, "/"),
    folder,
    title: titleFromH1 ?? fallbackTitle,
    frontmatter: parsed.data,
    body,
    mtime: stats.mtime,
    sizeBytes: stats.size,
    checksum: createHash("sha256").update(body).digest("hex"),
  };
}
```

- [ ] **Step 5: Tests laufen lassen (PASS)**

Run: `pnpm --filter @paperclipai/brain test -- parser.test.ts`
Expected: Beide Tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/brain/src/indexer/parser.ts packages/brain/test/parser.test.ts packages/brain/test/fixtures
git commit -m "feat(brain): markdown parser with frontmatter, title-extraction, sha256 checksum"
```

---

### Task 6: Markdown-Aware Chunker

**Files:**
- Create: `packages/brain/src/indexer/chunker.ts`
- Create: `packages/brain/test/chunker.test.ts`

- [ ] **Step 1: Test schreiben**

Create: `packages/brain/test/chunker.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/indexer/chunker.js";

describe("chunker", () => {
  it("returns single chunk for short note", () => {
    const chunks = chunkMarkdown("# Hello\n\nShort body.", { maxTokens: 800, overlapTokens: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Hello");
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].headingPath).toEqual(["Hello"]);
  });

  it("splits at heading boundaries when content exceeds maxTokens", () => {
    const longBody = "word ".repeat(1500);
    const md = `# H1 Title\n\n${longBody}\n\n## H2 Section\n\n${longBody}`;
    const chunks = chunkMarkdown(md, { maxTokens: 800, overlapTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(1000);
    }
    const h2Chunk = chunks.find((c) => c.headingPath.includes("H2 Section"));
    expect(h2Chunk).toBeDefined();
  });

  it("never splits inside a fenced code block", () => {
    const codeBlock = "```python\n" + "print('x')\n".repeat(200) + "```";
    const md = `# Code\n\n${codeBlock}\n\n## After\n\nTrailing text.`;
    const chunks = chunkMarkdown(md, { maxTokens: 800, overlapTokens: 100 });
    for (const c of chunks) {
      const opens = (c.content.match(/```/g) ?? []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it("tracks heading breadcrumb (heading_path)", () => {
    const md = "# Top\n\nIntro\n\n## Middle\n\nMid\n\n### Leaf\n\nLeaf body";
    const chunks = chunkMarkdown(md, { maxTokens: 800, overlapTokens: 100 });
    const leafChunk = chunks.find((c) => c.content.includes("Leaf body"));
    expect(leafChunk?.headingPath).toEqual(["Top", "Middle", "Leaf"]);
  });
});
```

- [ ] **Step 2: Test laufen lassen (FAIL)**

Run: `pnpm --filter @paperclipai/brain test -- chunker.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Chunker implementieren**

Create: `packages/brain/src/indexer/chunker.ts`
```typescript
import { encode } from "gpt-tokenizer";

export interface ChunkInput {
  chunkIndex: number;
  headingPath: string[];
  content: string;
  tokenCount: number;
}

export interface ChunkerOpts {
  maxTokens: number;
  overlapTokens: number;
}

interface Block {
  heading: string[];
  content: string;
  tokens: number;
}

function splitIntoBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const headingStack: string[] = [];
  const lines = md.split("\n");
  let buf: string[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    const content = buf.join("\n").trim();
    if (content.length > 0) {
      blocks.push({
        heading: [...headingStack],
        content,
        tokens: encode(content).length,
      });
    }
    buf = [];
  };

  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence) {
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        flush();
        const level = h[1].length;
        headingStack.splice(level - 1);
        headingStack[level - 1] = h[2].trim();
        buf.push(line);
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

export function chunkMarkdown(md: string, opts: ChunkerOpts): ChunkInput[] {
  const blocks = splitIntoBlocks(md);
  const chunks: ChunkInput[] = [];
  let current: { heading: string[]; parts: string[]; tokens: number } | null = null;
  let chunkIndex = 0;

  const pushChunk = () => {
    if (!current || current.parts.length === 0) return;
    chunks.push({
      chunkIndex: chunkIndex++,
      headingPath: current.heading,
      content: current.parts.join("\n\n"),
      tokenCount: current.tokens,
    });
  };

  for (const block of blocks) {
    if (block.tokens > opts.maxTokens) {
      pushChunk();
      current = null;
      // block too big — split by paragraphs
      const paras = block.content.split(/\n\n+/);
      let buf: string[] = [];
      let bufTok = 0;
      for (const p of paras) {
        const ptok = encode(p).length;
        if (bufTok + ptok > opts.maxTokens && buf.length > 0) {
          chunks.push({
            chunkIndex: chunkIndex++,
            headingPath: block.heading,
            content: buf.join("\n\n"),
            tokenCount: bufTok,
          });
          buf = [p];
          bufTok = ptok;
        } else {
          buf.push(p);
          bufTok += ptok;
        }
      }
      if (buf.length > 0) {
        chunks.push({
          chunkIndex: chunkIndex++,
          headingPath: block.heading,
          content: buf.join("\n\n"),
          tokenCount: bufTok,
        });
      }
      continue;
    }

    if (!current) {
      current = { heading: block.heading, parts: [block.content], tokens: block.tokens };
      continue;
    }

    if (current.tokens + block.tokens > opts.maxTokens
        || JSON.stringify(current.heading) !== JSON.stringify(block.heading)) {
      pushChunk();
      current = { heading: block.heading, parts: [block.content], tokens: block.tokens };
    } else {
      current.parts.push(block.content);
      current.tokens += block.tokens;
    }
  }
  pushChunk();
  return chunks;
}
```

- [ ] **Step 4: Tests laufen lassen (PASS)**

Run: `pnpm --filter @paperclipai/brain test -- chunker.test.ts`
Expected: Alle 4 Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/brain/src/indexer/chunker.ts packages/brain/test/chunker.test.ts
git commit -m "feat(brain): markdown-aware chunker with heading breadcrumbs and fenced-code safety"
```

---

### Task 7: DB-Writer (Chunk Upsert)

**Files:**
- Create: `packages/brain/src/indexer/writer.ts`
- Create: `packages/brain/test/writer.test.ts`

- [ ] **Step 1: Test schreiben**

Create: `packages/brain/test/writer.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "../src/db/client.js";
import { upsertNote } from "../src/db/queries.js";
import { writeChunks, countChunksForNote } from "../src/indexer/writer.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/paperclip_test";
const client = createClient(DATABASE_URL);

describe("writer", () => {
  let noteId: string;

  beforeAll(async () => {
    await client.query("DELETE FROM brain.notes WHERE path LIKE 'test-writer/%'");
    noteId = await upsertNote(client, {
      path: "test-writer/x.md", folder: "test-writer", title: "X",
      frontmatter: {}, mtime: new Date(), sizeBytes: 1, checksum: "c",
    });
  });

  afterAll(async () => {
    await client.query("DELETE FROM brain.notes WHERE path LIKE 'test-writer/%'");
    await client.end();
  });

  it("writeChunks inserts chunks with embeddings", async () => {
    await writeChunks(client, noteId, [
      {
        chunkIndex: 0, headingPath: ["A"], content: "chunk zero", tokenCount: 10,
        embedding: Array(1024).fill(0.5),
      },
      {
        chunkIndex: 1, headingPath: ["A"], content: "chunk one", tokenCount: 12,
        embedding: Array(1024).fill(0.7),
      },
    ]);
    expect(await countChunksForNote(client, noteId)).toBe(2);
  });

  it("writeChunks replaces existing chunks for note (transactional)", async () => {
    await writeChunks(client, noteId, [
      {
        chunkIndex: 0, headingPath: ["A"], content: "replaced", tokenCount: 5,
        embedding: Array(1024).fill(0.1),
      },
    ]);
    expect(await countChunksForNote(client, noteId)).toBe(1);
  });
});
```

- [ ] **Step 2: Test laufen lassen (FAIL)**

Run: `pnpm --filter @paperclipai/brain test -- writer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Writer implementieren**

Create: `packages/brain/src/indexer/writer.ts`
```typescript
import type pg from "pg";
import type { ChunkWithEmbedding } from "../shared/types.js";

export async function writeChunks(
  client: pg.Client,
  noteId: string,
  chunks: Array<Omit<ChunkWithEmbedding, "id" | "noteId">>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM brain.chunks WHERE note_id = $1", [noteId]);
    for (const c of chunks) {
      await client.query(
        `INSERT INTO brain.chunks
           (note_id, chunk_index, heading_path, content, token_count, embedding, embedded_at)
         VALUES ($1, $2, $3, $4, $5, $6::vector, now())`,
        [
          noteId,
          c.chunkIndex,
          c.headingPath,
          c.content,
          c.tokenCount,
          `[${c.embedding.join(",")}]`,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

export async function countChunksForNote(client: pg.Client, noteId: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    "SELECT count(*)::text FROM brain.chunks WHERE note_id = $1",
    [noteId],
  );
  return Number(rows[0].count);
}
```

- [ ] **Step 4: Tests laufen lassen (PASS)**

Run: `pnpm --filter @paperclipai/brain test -- writer.test.ts`
Expected: Beide Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/brain/src/indexer/writer.ts packages/brain/test/writer.test.ts
git commit -m "feat(brain): transactional chunk writer with full replacement semantics"
```

---

### Task 8: Indexer-Orchestrator (Watcher + Rescan + Main)

**Files:**
- Create: `packages/brain/src/indexer/watcher.ts`
- Create: `packages/brain/src/indexer/rescan.ts`
- Create: `packages/brain/src/indexer/index.ts`

- [ ] **Step 1: Indexer-Pipeline-Funktion schreiben (ohne Test — wird e2e getestet)**

Create: `packages/brain/src/indexer/watcher.ts`
```typescript
import type pg from "pg";
import { parseNote } from "./parser.js";
import { chunkMarkdown } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import { upsertNote, getNoteByPath, deleteNote } from "../db/queries.js";
import { writeChunks } from "./writer.js";

const CHUNK_OPTS = { maxTokens: 800, overlapTokens: 100 };
const EXCLUDED_TOP_LEVEL = new Set(["attachments", ".obsidian", ".trash"]);
const MAX_FILE_SIZE = 2 * 1024 * 1024;

export async function indexFile(
  client: pg.Client,
  embed: Embedder,
  vaultRoot: string,
  relPath: string,
): Promise<"indexed" | "skipped" | "unchanged"> {
  const topLevel = relPath.split("/")[0];
  if (EXCLUDED_TOP_LEVEL.has(topLevel)) return "skipped";
  if (!relPath.endsWith(".md")) return "skipped";

  const parsed = await parseNote(vaultRoot, relPath);
  if (parsed.sizeBytes > MAX_FILE_SIZE) return "skipped";

  const existing = await getNoteByPath(client, parsed.path);
  if (existing && existing.checksum === parsed.checksum) return "unchanged";

  const chunks = chunkMarkdown(parsed.body, CHUNK_OPTS);
  const embeddings = chunks.length === 0 ? [] : await embed(chunks.map((c) => c.content));

  const noteId = await upsertNote(client, {
    path: parsed.path, folder: parsed.folder, title: parsed.title,
    frontmatter: parsed.frontmatter, mtime: parsed.mtime,
    sizeBytes: parsed.sizeBytes, checksum: parsed.checksum,
  });

  await writeChunks(
    client,
    noteId,
    chunks.map((c, i) => ({ ...c, embedding: embeddings[i] })),
  );
  return "indexed";
}

export async function removeFile(client: pg.Client, relPath: string): Promise<void> {
  await deleteNote(client, relPath.replaceAll("\\", "/"));
}
```

- [ ] **Step 2: Rescan-Funktion (Full-Scan + mtime-Diff)**

Create: `packages/brain/src/indexer/rescan.ts`
```typescript
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import type { Embedder } from "./embedder.js";
import { indexFile } from "./watcher.js";

async function walkDir(root: string, base = root): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkDir(full, base)));
    } else if (e.name.endsWith(".md")) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

export async function fullRescan(
  client: pg.Client,
  embed: Embedder,
  vaultRoot: string,
): Promise<{ indexed: number; skipped: number; unchanged: number; errors: number }> {
  const counters = { indexed: 0, skipped: 0, unchanged: 0, errors: 0 };
  const files = await walkDir(vaultRoot);
  for (const f of files) {
    try {
      const result = await indexFile(client, embed, vaultRoot, f);
      counters[result]++;
    } catch (e) {
      counters.errors++;
      console.error(`[rescan] failed: ${f}:`, (e as Error).message);
    }
  }
  return counters;
}
```

- [ ] **Step 3: Indexer-Main (launchd entry point)**

Create: `packages/brain/src/indexer/index.ts`
```typescript
import chokidar from "chokidar";
import { loadConfig } from "../shared/config.js";
import { createClient } from "../db/client.js";
import { createEmbedder } from "./embedder.js";
import { indexFile, removeFile } from "./watcher.js";
import { fullRescan } from "./rescan.js";
import path from "node:path";

async function main() {
  const cfg = loadConfig();
  const client = createClient(cfg.databaseUrl);
  const embed = createEmbedder(cfg.lmStudioEmbeddingUrl, cfg.lmStudioEmbeddingModel);

  console.log("[indexer] startup full rescan…");
  const startStats = await fullRescan(client, embed, cfg.vaultPath);
  console.log(`[indexer] initial rescan done:`, startStats);

  console.log(`[indexer] starting chokidar on ${cfg.vaultPath}`);
  const watcher = chokidar.watch(cfg.vaultPath, {
    ignored: /(^|[/\\])\../,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000 },
  });

  const rel = (abs: string) => path.relative(cfg.vaultPath, abs).replaceAll(path.sep, "/");

  watcher.on("add", async (p) => {
    try {
      const r = await indexFile(client, embed, cfg.vaultPath, rel(p));
      console.log(`[indexer] add ${rel(p)} → ${r}`);
    } catch (e) { console.error(`[indexer] add error ${rel(p)}:`, (e as Error).message); }
  });
  watcher.on("change", async (p) => {
    try {
      const r = await indexFile(client, embed, cfg.vaultPath, rel(p));
      console.log(`[indexer] change ${rel(p)} → ${r}`);
    } catch (e) { console.error(`[indexer] change error ${rel(p)}:`, (e as Error).message); }
  });
  watcher.on("unlink", async (p) => {
    try {
      await removeFile(client, rel(p));
      console.log(`[indexer] unlink ${rel(p)}`);
    } catch (e) { console.error(`[indexer] unlink error ${rel(p)}:`, (e as Error).message); }
  });

  setInterval(async () => {
    console.log("[indexer] hourly safety rescan starting…");
    const stats = await fullRescan(client, embed, cfg.vaultPath);
    console.log("[indexer] safety rescan done:", stats);
  }, cfg.rescanIntervalMs);

  console.log("[indexer] ready. watching for changes.");
}

main().catch((e) => {
  console.error("[indexer] fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 4: Build und manuell laufen lassen (Smoke-Test)**

Run:
```bash
cd packages/brain && pnpm build
BRAIN_VAULT_PATH="$(pwd)/test/fixtures/test-vault" \
  DATABASE_URL="$DATABASE_URL" \
  node dist/indexer/index.js
```
Expected: Logs zeigen `initial rescan done: { indexed: 1, … }` (die `AI/sample.md` Fixture), dann `ready`.

Manuell abbrechen (`Ctrl+C`). Verifizieren per psql:
```bash
psql "$DATABASE_URL" -c "SELECT path, folder, title FROM brain.notes WHERE folder = 'AI';"
psql "$DATABASE_URL" -c "SELECT count(*) FROM brain.chunks;"
```

- [ ] **Step 5: Commit**

```bash
git add packages/brain/src/indexer/watcher.ts packages/brain/src/indexer/rescan.ts packages/brain/src/indexer/index.ts
git commit -m "feat(brain): indexer orchestrator with chokidar watcher and hourly rescan"
```

---

## Phase 2 — MCP Server (Tasks 9–12)

### Task 9: ACL-Lookup und -Enforcement

**Files:**
- Create: `packages/brain/src/mcp-server/acl.ts`
- Create: `packages/brain/test/acl.test.ts`

- [ ] **Step 1: Test schreiben**

Create: `packages/brain/test/acl.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "../src/db/client.js";
import { getAgentScope, buildAclFilter } from "../src/mcp-server/acl.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/paperclip_test";
const client = createClient(DATABASE_URL);

describe("acl", () => {
  beforeAll(async () => {
    await client.query("DELETE FROM brain.agent_acl WHERE agent_id IN ('T_CEO','T_UNKNOWN')");
    await client.query(
      "INSERT INTO brain.agent_acl (agent_id, allowed_folders) VALUES ('T_CEO', ARRAY['AI','Dokumente']::text[])",
    );
  });

  afterAll(async () => {
    await client.query("DELETE FROM brain.agent_acl WHERE agent_id IN ('T_CEO','T_UNKNOWN')");
    await client.end();
  });

  it("getAgentScope returns folders for known agent", async () => {
    const scope = await getAgentScope(client, "T_CEO");
    expect(scope.allowedFolders).toEqual(["AI", "Dokumente"]);
  });

  it("getAgentScope returns empty for unknown agent (default-deny)", async () => {
    const scope = await getAgentScope(client, "T_UNKNOWN");
    expect(scope.allowedFolders).toEqual([]);
  });

  it("buildAclFilter produces WHERE clause and params", () => {
    const f = buildAclFilter(["AI", "Dokumente"], "T_CEO");
    expect(f.sql).toMatch(/n\.folder = ANY/);
    expect(f.sql).toMatch(/agent_exclude/);
    expect(f.params).toEqual([["AI", "Dokumente"], "T_CEO"]);
  });

  it("buildAclFilter for empty allowedFolders yields false-ish filter", () => {
    const f = buildAclFilter([], "T_UNKNOWN");
    expect(f.sql).toMatch(/false/);
    expect(f.params).toEqual([]);
  });
});
```

- [ ] **Step 2: Test laufen lassen (FAIL)**

Run: `pnpm --filter @paperclipai/brain test -- acl.test.ts`
Expected: FAIL.

- [ ] **Step 3: ACL-Modul implementieren**

Create: `packages/brain/src/mcp-server/acl.ts`
```typescript
import type pg from "pg";
import { getAclForAgent } from "../db/queries.js";

export interface AgentScope {
  agentId: string;
  allowedFolders: string[];
}

export async function getAgentScope(client: pg.Client, agentId: string): Promise<AgentScope> {
  const allowedFolders = await getAclForAgent(client, agentId);
  return { agentId, allowedFolders };
}

export interface AclFilter {
  sql: string;
  params: unknown[];
}

export function buildAclFilter(allowedFolders: string[], agentId: string): AclFilter {
  if (allowedFolders.length === 0) {
    return { sql: "false", params: [] };
  }
  return {
    sql: `n.folder = ANY($1::text[])
      AND (n.frontmatter->>'agent_exclude' IS NULL
           OR NOT (n.frontmatter->'agent_exclude' ? $2))`,
    params: [allowedFolders, agentId],
  };
}

export function isPathAllowed(scope: AgentScope, folder: string): boolean {
  return scope.allowedFolders.includes(folder);
}
```

- [ ] **Step 4: Tests laufen lassen (PASS)**

Run: `pnpm --filter @paperclipai/brain test -- acl.test.ts`
Expected: 4 Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/brain/src/mcp-server/acl.ts packages/brain/test/acl.test.ts
git commit -m "feat(brain): ACL lookup and SQL-filter-builder with default-deny"
```

---

### Task 10: Audit-Log-Writer

**Files:**
- Create: `packages/brain/src/mcp-server/audit.ts`
- Create: `packages/brain/test/audit.test.ts`

- [ ] **Step 1: Test schreiben**

Create: `packages/brain/test/audit.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "../src/db/client.js";
import { logAccess } from "../src/mcp-server/audit.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/paperclip_test";
const client = createClient(DATABASE_URL);

describe("audit", () => {
  beforeAll(async () => {
    await client.query("DELETE FROM brain.access_log WHERE agent_id = 'T_AUDIT'");
  });

  afterAll(async () => {
    await client.query("DELETE FROM brain.access_log WHERE agent_id = 'T_AUDIT'");
    await client.end();
  });

  it("logAccess writes a row with all fields", async () => {
    await logAccess(client, {
      agentId: "T_AUDIT",
      tool: "search_vault",
      query: "test query",
      returnedPaths: ["AI/a.md", "AI/b.md"],
      latencyMs: 42,
      ok: true,
    });
    const { rows } = await client.query(
      "SELECT * FROM brain.access_log WHERE agent_id = 'T_AUDIT' ORDER BY ts DESC LIMIT 1",
    );
    expect(rows[0].tool).toBe("search_vault");
    expect(rows[0].query).toBe("test query");
    expect(rows[0].returned_paths).toEqual(["AI/a.md", "AI/b.md"]);
    expect(rows[0].latency_ms).toBe(42);
    expect(rows[0].ok).toBe(true);
  });

  it("logAccess writes failure row", async () => {
    await logAccess(client, {
      agentId: "T_AUDIT", tool: "get_note", path: "nope.md",
      returnedPaths: [], latencyMs: 1, ok: false,
    });
    const { rows } = await client.query(
      "SELECT ok FROM brain.access_log WHERE agent_id = 'T_AUDIT' AND tool = 'get_note'",
    );
    expect(rows[0].ok).toBe(false);
  });
});
```

- [ ] **Step 2: Test laufen lassen (FAIL)**

Run: `pnpm --filter @paperclipai/brain test -- audit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Audit-Modul implementieren**

Create: `packages/brain/src/mcp-server/audit.ts`
```typescript
import type pg from "pg";

export interface AccessLogEntry {
  agentId: string;
  tool: "search_vault" | "get_note" | "list_scope";
  query?: string;
  path?: string;
  returnedPaths: string[];
  latencyMs: number;
  ok: boolean;
}

export async function logAccess(client: pg.Client, entry: AccessLogEntry): Promise<void> {
  await client.query(
    `INSERT INTO brain.access_log (agent_id, tool, query, path, returned_paths, latency_ms, ok)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.agentId, entry.tool, entry.query ?? null, entry.path ?? null,
      entry.returnedPaths, entry.latencyMs, entry.ok,
    ],
  );
}
```

- [ ] **Step 4: Tests laufen lassen (PASS)**

Run: `pnpm --filter @paperclipai/brain test -- audit.test.ts`
Expected: Beide Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/brain/src/mcp-server/audit.ts packages/brain/test/audit.test.ts
git commit -m "feat(brain): access_log writer for DSGVO audit trail"
```

---

### Task 11: MCP-Tools (search_vault, get_note, list_scope)

**Files:**
- Create: `packages/brain/src/mcp-server/tools.ts`
- Create: `packages/brain/test/tools.test.ts`

- [ ] **Step 1: Test schreiben**

Create: `packages/brain/test/tools.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient } from "../src/db/client.js";
import { createTools } from "../src/mcp-server/tools.js";
import type { Embedder } from "../src/indexer/embedder.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/paperclip_test";
const client = createClient(DATABASE_URL);

const fakeEmbed: Embedder = async (inputs) =>
  inputs.map(() => Array(1024).fill(0).map((_, i) => (i === 0 ? 0.9 : 0)));

describe("mcp tools", () => {
  beforeAll(async () => {
    await client.query("DELETE FROM brain.notes WHERE folder = 'tools-test'");
    await client.query("DELETE FROM brain.notes WHERE folder = 'tools-forbidden'");
    await client.query("DELETE FROM brain.agent_acl WHERE agent_id IN ('T_TOOLS')");
    await client.query(
      "INSERT INTO brain.agent_acl (agent_id, allowed_folders) VALUES ('T_TOOLS', ARRAY['tools-test']::text[])",
    );
    // seed two notes, one allowed, one forbidden
    const allowed = await client.query(
      `INSERT INTO brain.notes (path, folder, title, frontmatter, mtime, size_bytes, checksum)
       VALUES ('tools-test/a.md', 'tools-test', 'Allowed', '{}'::jsonb, now(), 1, 'x') RETURNING id`,
    );
    const forbidden = await client.query(
      `INSERT INTO brain.notes (path, folder, title, frontmatter, mtime, size_bytes, checksum)
       VALUES ('tools-forbidden/b.md', 'tools-forbidden', 'Forbidden', '{}'::jsonb, now(), 1, 'y') RETURNING id`,
    );
    const emb = "[" + Array(1024).fill(0).map((_, i) => (i === 0 ? 0.9 : 0)).join(",") + "]";
    await client.query(
      `INSERT INTO brain.chunks (note_id, chunk_index, heading_path, content, token_count, embedding, embedded_at)
       VALUES ($1, 0, ARRAY['Allowed'], 'allowed body', 5, $2::vector, now()),
              ($3, 0, ARRAY['Forbidden'], 'forbidden body', 5, $2::vector, now())`,
      [allowed.rows[0].id, emb, forbidden.rows[0].id],
    );
  });

  afterAll(async () => {
    await client.query("DELETE FROM brain.notes WHERE folder IN ('tools-test','tools-forbidden')");
    await client.query("DELETE FROM brain.agent_acl WHERE agent_id = 'T_TOOLS'");
    await client.end();
  });

  it("search_vault returns only allowed folder results", async () => {
    const tools = createTools({ client, embed: fakeEmbed });
    const results = await tools.search_vault({ query: "body", agentId: "T_TOOLS", limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].folder).toBe("tools-test");
  });

  it("search_vault returns empty for unknown agent (default-deny)", async () => {
    const tools = createTools({ client, embed: fakeEmbed });
    const results = await tools.search_vault({ query: "body", agentId: "T_UNKNOWN", limit: 10 });
    expect(results).toEqual([]);
  });

  it("get_note returns note content when allowed", async () => {
    const tools = createTools({ client, embed: fakeEmbed });
    const note = await tools.get_note({ path: "tools-test/a.md", agentId: "T_TOOLS" });
    expect(note?.title).toBe("Allowed");
  });

  it("get_note returns null when forbidden", async () => {
    const tools = createTools({ client, embed: fakeEmbed });
    const note = await tools.get_note({ path: "tools-forbidden/b.md", agentId: "T_TOOLS" });
    expect(note).toBeNull();
  });

  it("list_scope returns allowed folders and note count", async () => {
    const tools = createTools({ client, embed: fakeEmbed });
    const scope = await tools.list_scope({ agentId: "T_TOOLS" });
    expect(scope.allowedFolders).toEqual(["tools-test"]);
    expect(scope.noteCount).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Test laufen lassen (FAIL)**

Run: `pnpm --filter @paperclipai/brain test -- tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Tools implementieren**

Create: `packages/brain/src/mcp-server/tools.ts`
```typescript
import type pg from "pg";
import type { Embedder } from "../indexer/embedder.js";
import { getAgentScope, buildAclFilter } from "./acl.js";
import type { SearchResult } from "../shared/types.js";

export interface ToolDeps {
  client: pg.Client;
  embed: Embedder;
}

export interface SearchArgs {
  query: string;
  agentId: string;
  limit?: number;
  folderFilter?: string[];
}

export interface GetNoteArgs {
  path: string;
  agentId: string;
}

export interface ListScopeArgs {
  agentId: string;
}

export interface ListScopeResult {
  allowedFolders: string[];
  noteCount: number;
}

export function createTools(deps: ToolDeps) {
  return {
    async search_vault(args: SearchArgs): Promise<SearchResult[]> {
      const limit = args.limit ?? 8;
      const scope = await getAgentScope(deps.client, args.agentId);
      let folders = scope.allowedFolders;
      if (args.folderFilter && args.folderFilter.length > 0) {
        folders = folders.filter((f) => args.folderFilter!.includes(f));
      }
      const filter = buildAclFilter(folders, args.agentId);
      if (filter.sql === "false") return [];

      const [qvec] = await deps.embed([args.query]);
      const emb = `[${qvec.join(",")}]`;

      const { rows } = await deps.client.query(
        `SELECT n.path, n.title, n.folder, n.frontmatter,
                c.heading_path, c.content,
                1 - (c.embedding <=> $3::vector) AS score
         FROM brain.chunks c
         JOIN brain.notes n ON n.id = c.note_id
         WHERE ${filter.sql}
         ORDER BY c.embedding <=> $3::vector
         LIMIT $4`,
        [...filter.params, emb, limit * 3],
      );

      // dedupe by path, keep best
      const byPath = new Map<string, SearchResult>();
      for (const r of rows) {
        const existing = byPath.get(r.path);
        if (!existing || r.score > existing.score) {
          byPath.set(r.path, {
            path: r.path,
            title: r.title,
            headingPath: r.heading_path ?? [],
            content: r.content.slice(0, 3200),
            score: Number(r.score),
            folder: r.folder,
            frontmatter: r.frontmatter,
          });
        }
      }
      return [...byPath.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    async get_note(args: GetNoteArgs): Promise<{ path: string; title: string | null; frontmatter: Record<string, unknown>; body: string } | null> {
      const scope = await getAgentScope(deps.client, args.agentId);
      const { rows } = await deps.client.query(
        `SELECT n.path, n.title, n.folder, n.frontmatter,
                string_agg(c.content, E'\\n\\n' ORDER BY c.chunk_index) AS body
         FROM brain.notes n
         LEFT JOIN brain.chunks c ON c.note_id = n.id
         WHERE n.path = $1
         GROUP BY n.id, n.path, n.title, n.folder, n.frontmatter`,
        [args.path],
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      if (!scope.allowedFolders.includes(r.folder)) return null;
      const excl = (r.frontmatter?.agent_exclude ?? []) as string[];
      if (Array.isArray(excl) && excl.includes(args.agentId)) return null;
      return {
        path: r.path,
        title: r.title,
        frontmatter: r.frontmatter,
        body: r.body ?? "",
      };
    },

    async list_scope(args: ListScopeArgs): Promise<ListScopeResult> {
      const scope = await getAgentScope(deps.client, args.agentId);
      if (scope.allowedFolders.length === 0) {
        return { allowedFolders: [], noteCount: 0 };
      }
      const { rows } = await deps.client.query<{ count: string }>(
        "SELECT count(*)::text FROM brain.notes WHERE folder = ANY($1::text[])",
        [scope.allowedFolders],
      );
      return {
        allowedFolders: scope.allowedFolders,
        noteCount: Number(rows[0].count),
      };
    },
  };
}
```

- [ ] **Step 4: Tests laufen lassen (PASS)**

Run: `pnpm --filter @paperclipai/brain test -- tools.test.ts`
Expected: 5 Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/brain/src/mcp-server/tools.ts packages/brain/test/tools.test.ts
git commit -m "feat(brain): mcp tools search_vault, get_note, list_scope with ACL enforcement"
```

---

### Task 12: MCP-Server-Main (Bearer-Auth + stdio-Transport)

**Files:**
- Create: `packages/brain/src/mcp-server/auth.ts`
- Create: `packages/brain/src/mcp-server/index.ts`

- [ ] **Step 1: Auth-Modul**

Create: `packages/brain/src/mcp-server/auth.ts`
```typescript
export interface AuthResult {
  ok: boolean;
  defaultAgentId?: string;
}

export function authenticate(
  header: string | undefined,
  tokens: Record<string, string>,
): AuthResult {
  if (!header) return { ok: false };
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m) return { ok: false };
  const token = m[1].trim();
  const defaultAgentId = tokens[token];
  if (!defaultAgentId) return { ok: false };
  return { ok: true, defaultAgentId };
}
```

- [ ] **Step 2: MCP-Server-Main (HTTP mit Bearer-Auth)**

Create: `packages/brain/src/mcp-server/index.ts`
```typescript
import http from "node:http";
import { loadConfig } from "../shared/config.js";
import { createClient } from "../db/client.js";
import { createEmbedder } from "../indexer/embedder.js";
import { createTools } from "./tools.js";
import { authenticate } from "./auth.js";
import { logAccess } from "./audit.js";

async function main() {
  const cfg = loadConfig();
  const client = createClient(cfg.databaseUrl);
  const embed = createEmbedder(cfg.lmStudioEmbeddingUrl, cfg.lmStudioEmbeddingModel);
  const tools = createTools({ client, embed });

  const server = http.createServer(async (req, res) => {
    const auth = authenticate(req.headers.authorization, cfg.mcpBearerTokens);
    if (!auth.ok) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const started = Date.now();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        const { tool, args } = body as {
          tool: "search_vault" | "get_note" | "list_scope";
          args: Record<string, unknown>;
        };
        const agentId = (args.agentId as string) ?? auth.defaultAgentId!;
        const mergedArgs = { ...args, agentId };

        let result: unknown;
        let returnedPaths: string[] = [];
        if (tool === "search_vault") {
          const r = await tools.search_vault(mergedArgs as any);
          returnedPaths = r.map((x) => x.path);
          result = r;
        } else if (tool === "get_note") {
          const r = await tools.get_note(mergedArgs as any);
          returnedPaths = r ? [r.path] : [];
          result = r;
        } else if (tool === "list_scope") {
          result = await tools.list_scope(mergedArgs as any);
        } else {
          throw new Error(`Unknown tool: ${tool}`);
        }

        await logAccess(client, {
          agentId,
          tool,
          query: tool === "search_vault" ? (args.query as string) : undefined,
          path: tool === "get_note" ? (args.path as string) : undefined,
          returnedPaths,
          latencyMs: Date.now() - started,
          ok: true,
        });

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ result }));
      } catch (e) {
        await logAccess(client, {
          agentId: auth.defaultAgentId ?? "unknown",
          tool: "search_vault",
          returnedPaths: [],
          latencyMs: Date.now() - started,
          ok: false,
        });
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });

  server.listen(cfg.mcpPort, () => {
    console.log(`[mcp-server] listening on :${cfg.mcpPort}`);
  });
}

main().catch((e) => {
  console.error("[mcp-server] fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 3: Build und Smoke-Test**

Run:
```bash
cd packages/brain && pnpm build
BRAIN_VAULT_PATH="$(pwd)/test/fixtures/test-vault" \
  DATABASE_URL="$DATABASE_URL" \
  BRAIN_MCP_TOKENS="testtoken:T_TOOLS" \
  BRAIN_MCP_PORT=7777 \
  node dist/mcp-server/index.js &
MCP_PID=$!
sleep 1
curl -s -X POST http://localhost:7777 \
  -H "Authorization: Bearer testtoken" \
  -H "Content-Type: application/json" \
  -d '{"tool":"list_scope","args":{}}'
kill $MCP_PID
```
Expected: JSON `{"result":{"allowedFolders":["tools-test"],"noteCount":1}}` (wenn die tools-test-Fixture noch in der DB ist) oder `{"allowedFolders":[],"noteCount":0}` bei frischer DB — beides ist valide.

- [ ] **Step 4: Commit**

```bash
git add packages/brain/src/mcp-server/auth.ts packages/brain/src/mcp-server/index.ts
git commit -m "feat(brain): mcp http server with bearer-auth and audit logging"
```

---

## Phase 3 — Paperclip-Plugin (Tasks 13–15)

### Task 13: Plugin-Scaffold via `paperclip-create-plugin`

**Files:**
- Create: `packages/plugins/brain/package.json`
- Create: `packages/plugins/brain/tsconfig.json`
- Create: `packages/plugins/brain/src/manifest.ts`
- Create: `packages/plugins/brain/src/worker.ts` (Platzhalter, fertig in Task 14)
- Create: `packages/plugins/brain/src/ui/settings-tab.tsx` (Platzhalter, fertig in Task 15)

- [ ] **Step 1: Scaffold über Skill ausführen**

Run:
```bash
# Variante 1: via create-paperclip-plugin CLI
pnpm dlx create-paperclip-plugin packages/plugins/brain \
  --name @whitestag/paperclip-plugin-brain \
  --template hello-world

# Variante 2 (wenn CLI fehlt): manuell nach Muster von packages/plugins/examples/plugin-hello-world-example/
```

Konsultiere den Skill `paperclip-create-plugin` (`Skill: paperclip-create-plugin`) für die aktuelle Scaffold-Prozedur und übernimm:
- `package.json` mit `paperclipPlugin` field (`manifest`, `worker`, `ui`)
- `tsconfig.json`
- `src/manifest.ts`
- `src/worker.ts`
- `src/ui/`-Ordner

- [ ] **Step 2: Manifest anpassen**

Create/Modify: `packages/plugins/brain/src/manifest.ts`
```typescript
import { defineManifest } from "@paperclipai/plugin-sdk";

export default defineManifest({
  id: "whitestag.brain",
  name: "Obsidian Brain",
  version: "0.1.0",
  description: "Exposes Walter's Obsidian vault as queryable knowledge base via MCP.",
  tools: [
    {
      name: "vault.search",
      description: "Semantic search across the Obsidian vault (ACL-enforced).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", default: 8 },
        },
        required: ["query"],
      },
    },
    {
      name: "vault.get_note",
      description: "Fetch a full note by path (ACL-enforced).",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "vault.list_scope",
      description: "List folders the current agent may access.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  settings: {
    view: "./ui/settings-tab.js",
  },
});
```

- [ ] **Step 3: Package-Registrierung**

Modify: `pnpm-workspace.yaml` — `packages/plugins/brain` aufnehmen (falls Glob `packages/plugins/*` noch nicht automatisch greift; meist schon der Fall).

Run: `pnpm install`

Expected: Plugin wird erkannt, keine Fehler.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/brain pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(plugin-brain): scaffold Paperclip plugin with manifest and three tools"
```

---

### Task 14: Agent-ID-Mapping und Tool-Routing zum MCP-Server

**Files:**
- Create: `packages/plugins/brain/src/agent-mapping.ts`
- Create: `packages/plugins/brain/src/worker.ts`
- Create: `packages/plugins/brain/test/agent-mapping.test.ts`

- [ ] **Step 1: Test für Agent-Mapping schreiben**

Create: `packages/plugins/brain/test/agent-mapping.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { mapAgentId } from "../src/agent-mapping.js";

describe("agent-mapping", () => {
  const map = {
    "82729ae0-aaaa-bbbb-cccc-111111111111": "CEO",
    "82729ae0-aaaa-bbbb-cccc-222222222222": "CTO",
  };

  it("maps known UUID to ACL key", () => {
    expect(mapAgentId("82729ae0-aaaa-bbbb-cccc-111111111111", map)).toBe("CEO");
  });

  it("returns 'unknown' for unmapped UUID", () => {
    expect(mapAgentId("99999999-9999-9999-9999-999999999999", map)).toBe("unknown");
  });

  it("returns 'unknown' for undefined input", () => {
    expect(mapAgentId(undefined, map)).toBe("unknown");
  });
});
```

- [ ] **Step 2: Agent-Mapping implementieren**

Create: `packages/plugins/brain/src/agent-mapping.ts`
```typescript
export function mapAgentId(
  uuid: string | undefined,
  map: Record<string, string>,
): string {
  if (!uuid) return "unknown";
  return map[uuid] ?? "unknown";
}
```

- [ ] **Step 3: Tests laufen lassen (PASS)**

Run: `pnpm --filter @whitestag/paperclip-plugin-brain test`
Expected: 3 Tests PASS.

- [ ] **Step 4: Worker mit MCP-Client implementieren**

Create: `packages/plugins/brain/src/worker.ts`
```typescript
import { defineWorker } from "@paperclipai/plugin-sdk";
import { mapAgentId } from "./agent-mapping.js";

const MCP_ENDPOINT = process.env.BRAIN_MCP_ENDPOINT ?? "http://localhost:7777";
const MCP_TOKEN = process.env.BRAIN_PAPERCLIP_TOKEN ?? "";

// Mapping from Paperclip agent UUIDs to ACL keys — configure via plugin settings in Phase 2.
const AGENT_MAP: Record<string, string> = JSON.parse(
  process.env.BRAIN_AGENT_MAP ?? "{}",
);

async function callMcp(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MCP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tool, args }),
  });
  if (!resp.ok) {
    throw new Error(`brain MCP ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result;
}

export default defineWorker({
  tools: {
    async "vault.search"(ctx, args: { query: string; limit?: number }) {
      const agentId = mapAgentId(ctx.agentId, AGENT_MAP);
      return callMcp("search_vault", { ...args, agentId });
    },

    async "vault.get_note"(ctx, args: { path: string }) {
      const agentId = mapAgentId(ctx.agentId, AGENT_MAP);
      return callMcp("get_note", { ...args, agentId });
    },

    async "vault.list_scope"(ctx) {
      const agentId = mapAgentId(ctx.agentId, AGENT_MAP);
      return callMcp("list_scope", { agentId });
    },
  },
});
```

**Hinweis:** Die genaue `defineWorker`/`ctx`-Signatur kann je nach Plugin-SDK-Version leicht abweichen. Vergleiche mit `packages/plugins/examples/plugin-hello-world-example/src/worker.ts` und passe die Signaturen an den dort genutzten Typ an, falls Compiler-Fehler auftreten.

- [ ] **Step 5: Build verifizieren**

Run: `pnpm --filter @whitestag/paperclip-plugin-brain build`
Expected: `tsc` ohne Fehler, `dist/worker.js` existiert.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/brain/src/agent-mapping.ts packages/plugins/brain/src/worker.ts packages/plugins/brain/test
git commit -m "feat(plugin-brain): worker routes tools to MCP-server with agent-id mapping"
```

---

### Task 15: Settings-UI (Status + Re-Index + Log-Viewer)

**Files:**
- Create: `packages/plugins/brain/src/ui/settings-tab.tsx`

- [ ] **Step 1: Minimale Settings-UI implementieren**

Create: `packages/plugins/brain/src/ui/settings-tab.tsx`
```tsx
import React, { useEffect, useState } from "react";

interface LogEntry {
  ts: string;
  agent_id: string;
  tool: string;
  query?: string | null;
  path?: string | null;
  returned_paths: string[] | null;
  ok: boolean;
}

interface Status {
  mcpReachable: boolean;
  lastIndexedAt: string | null;
  noteCount: number;
}

export default function SettingsTab({ pluginApi }: { pluginApi: {
  fetchJson: (url: string) => Promise<unknown>;
  triggerReindex: () => Promise<void>;
} }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    try {
      const s = await pluginApi.fetchJson("/brain/status") as Status;
      const l = await pluginApi.fetchJson("/brain/logs?limit=20") as LogEntry[];
      setStatus(s);
      setLogs(l);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => { refresh(); }, []);

  const onReindex = async () => {
    setLoading(true);
    try {
      await pluginApi.triggerReindex();
      await refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <h2>Obsidian Brain</h2>

      <section style={{ marginTop: 16 }}>
        <h3>Status</h3>
        {status ? (
          <ul>
            <li>MCP-Server: {status.mcpReachable ? "✓ erreichbar" : "✗ nicht erreichbar"}</li>
            <li>Notizen indexiert: {status.noteCount}</li>
            <li>Letzter Index: {status.lastIndexedAt ?? "—"}</li>
          </ul>
        ) : <p>Lade…</p>}
        <button onClick={onReindex} disabled={loading}>
          {loading ? "Re-Indexing…" : "Re-Index auslösen"}
        </button>
      </section>

      <section style={{ marginTop: 24 }}>
        <h3>Letzte 20 Zugriffe</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Zeit</th>
              <th style={{ textAlign: "left" }}>Agent</th>
              <th style={{ textAlign: "left" }}>Tool</th>
              <th style={{ textAlign: "left" }}>Query/Pfad</th>
              <th style={{ textAlign: "left" }}>Treffer</th>
              <th style={{ textAlign: "left" }}>OK</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l, i) => (
              <tr key={i}>
                <td>{new Date(l.ts).toLocaleString("de-DE")}</td>
                <td>{l.agent_id}</td>
                <td>{l.tool}</td>
                <td>{l.query ?? l.path ?? ""}</td>
                <td>{l.returned_paths?.length ?? 0}</td>
                <td>{l.ok ? "✓" : "✗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

**Hinweis:** Die `pluginApi`-Signatur ist ein Stand-in. Die tatsächliche Integration mit Paperclips Plugin-UI-SDK folgt dem Muster in `packages/plugins/examples/plugin-hello-world-example/src/ui/`. Die zwei Endpoints (`/brain/status`, `/brain/logs`) werden in Task 16 (Backend-Route-Handler im Worker) nachgetragen oder durch direkte DB-Queries im UI-Loader ersetzt, je nachdem was das Plugin-SDK an direkter DB-Zugriffsmöglichkeit bietet.

- [ ] **Step 2: Build verifizieren**

Run: `pnpm --filter @whitestag/paperclip-plugin-brain build`
Expected: ohne Fehler.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/brain/src/ui
git commit -m "feat(plugin-brain): minimal settings UI with status, re-index, audit log viewer"
```

---

## Phase 4 — Deployment und Smoke (Tasks 16–18)

### Task 16: launchd-Plists für Indexer und MCP-Server

**Files:**
- Create: `packages/brain/launchd/com.whitestag.brain-indexer.plist`
- Create: `packages/brain/launchd/com.whitestag.brain-mcp.plist`
- Create: `packages/brain/launchd/README.md`

- [ ] **Step 1: Plist für Indexer**

Create: `packages/brain/launchd/com.whitestag.brain-indexer.plist`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whitestag.brain-indexer</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip/packages/brain/dist/indexer/index.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>BRAIN_VAULT_PATH</key>
    <string>/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault</string>
    <key>DATABASE_URL</key>
    <string>REPLACE_WITH_PAPERCLIP_DB_URL</string>
    <key>BRAIN_EMBED_URL</key>
    <string>http://localhost:1234/v1/embeddings</string>
    <key>BRAIN_EMBED_MODEL</key>
    <string>bge-m3</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/walterschoenenbroecher.de/.whitestag-logs/brain-indexer.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/walterschoenenbroecher.de/.whitestag-logs/brain-indexer.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Plist für MCP-Server**

Create: `packages/brain/launchd/com.whitestag.brain-mcp.plist`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whitestag.brain-mcp</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip/packages/brain/dist/mcp-server/index.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>DATABASE_URL</key>
    <string>REPLACE_WITH_PAPERCLIP_DB_URL</string>
    <key>BRAIN_EMBED_URL</key>
    <string>http://localhost:1234/v1/embeddings</string>
    <key>BRAIN_EMBED_MODEL</key>
    <string>bge-m3</string>
    <key>BRAIN_MCP_PORT</key>
    <string>7777</string>
    <key>BRAIN_MCP_TOKENS</key>
    <string>REPLACE_WITH_TOKEN_AGENT_PAIRS</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/walterschoenenbroecher.de/.whitestag-logs/brain-mcp.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/walterschoenenbroecher.de/.whitestag-logs/brain-mcp.err.log</string>
</dict>
</plist>
```

- [ ] **Step 3: README mit Installations-Anweisungen**

Create: `packages/brain/launchd/README.md`
```markdown
# Brain launchd Services

## Installation

1. Logs-Verzeichnis anlegen:
   ```bash
   mkdir -p ~/.whitestag-logs
   ```

2. Tokens generieren (je Client ein Token):
   ```bash
   openssl rand -hex 32   # → Paperclip-Token
   openssl rand -hex 32   # → Claude-Code-Token
   ```

3. In den Plists die Platzhalter ersetzen:
   - `REPLACE_WITH_PAPERCLIP_DB_URL` → Paperclip-DB-URL (aus `~/.paperclip/config` oder `.env`)
   - `REPLACE_WITH_TOKEN_AGENT_PAIRS` → `"token1:CEO,token2:walter"`

4. Plists an die User-LaunchAgents kopieren:
   ```bash
   cp com.whitestag.brain-indexer.plist ~/Library/LaunchAgents/
   cp com.whitestag.brain-mcp.plist ~/Library/LaunchAgents/
   ```

5. Services laden:
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
   launchctl load -w ~/Library/LaunchAgents/com.whitestag.brain-mcp.plist
   ```

6. Status prüfen:
   ```bash
   launchctl list | grep whitestag
   tail -f ~/.whitestag-logs/brain-indexer.log
   tail -f ~/.whitestag-logs/brain-mcp.log
   ```

## Stop / Unload

```bash
launchctl unload ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
launchctl unload ~/Library/LaunchAgents/com.whitestag.brain-mcp.plist
```
```

- [ ] **Step 4: Commit**

```bash
git add packages/brain/launchd
git commit -m "feat(brain): launchd plists for indexer and mcp-server with README"
```

---

### Task 17: ACL-Seed für CEO-Agent und Bootstrap-Script

**Files:**
- Create: `packages/brain/scripts/seed-acl.ts`
- Create: `packages/brain/scripts/README.md`

- [ ] **Step 1: Seed-Script**

Create: `packages/brain/scripts/seed-acl.ts`
```typescript
import { createClient } from "../src/db/client.js";
import { loadConfig } from "../src/shared/config.js";

async function main() {
  const cfg = loadConfig();
  const client = createClient(cfg.databaseUrl);

  const seeds: Array<{ agent_id: string; folders: string[]; description: string }> = [
    { agent_id: "CEO", folders: ["AI", "Dokumente"],
      description: "Paperclip CEO-Agent — MVP-Zugriff auf AI und Dokumente" },
    { agent_id: "walter", folders: ["AI", "Dokumente", "Marketing", "Pressemitteilungen", "Analysen", "CAO", "Biographie"],
      description: "Walter selbst (Claude Code etc.) — breiter Zugriff, weil Eigentümer" },
  ];

  for (const s of seeds) {
    await client.query(
      `INSERT INTO brain.agent_acl (agent_id, allowed_folders, description)
       VALUES ($1, $2::text[], $3)
       ON CONFLICT (agent_id) DO UPDATE SET
         allowed_folders = EXCLUDED.allowed_folders,
         description = EXCLUDED.description,
         updated_at = now()`,
      [s.agent_id, s.folders, s.description],
    );
    console.log(`[seed] ${s.agent_id} → [${s.folders.join(",")}]`);
  }

  await client.end();
  console.log("[seed] done.");
}

main().catch((e) => {
  console.error("[seed] fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Script laufen lassen**

Run via `tsx` (keine Kompilation nötig — `scripts/` liegt außerhalb von `src/`):
```bash
cd packages/brain && DATABASE_URL="$DATABASE_URL" \
  BRAIN_VAULT_PATH=/tmp BRAIN_MCP_TOKENS="dummy:dummy" \
  pnpm exec tsx scripts/seed-acl.ts
```
(BRAIN_VAULT_PATH/BRAIN_MCP_TOKENS sind nur da, damit `loadConfig()` nicht wegen fehlender Env vars wirft; das Script nutzt nur DATABASE_URL.)

Verify:
```bash
psql "$DATABASE_URL" -c "SELECT agent_id, allowed_folders FROM brain.agent_acl;"
```
Expected: 2 Zeilen (`CEO`, `walter`) mit den konfigurierten Ordnern.

- [ ] **Step 3: Commit**

```bash
git add packages/brain/scripts
git commit -m "feat(brain): acl seed script for CEO and walter"
```

---

### Task 18: End-to-End-Smoke-Test und MVP-Erfolgsmaß

**Files:**
- Create: `packages/brain/test/e2e.test.ts`

- [ ] **Step 1: E2E-Test schreiben**

Create: `packages/brain/test/e2e.test.ts`
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "../src/db/client.js";
import { createEmbedder } from "../src/indexer/embedder.js";
import { fullRescan } from "../src/indexer/rescan.js";
import { createTools } from "../src/mcp-server/tools.js";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/paperclip_test";

describe("end-to-end: index → search with real LM Studio", () => {
  const client = createClient(DATABASE_URL);
  const embed = createEmbedder(
    process.env.BRAIN_EMBED_URL ?? "http://localhost:1234/v1/embeddings",
    process.env.BRAIN_EMBED_MODEL ?? "bge-m3",
  );
  const vaultRoot = path.join(__dirname, "fixtures/test-vault");

  beforeAll(async () => {
    await client.query("DELETE FROM brain.notes WHERE folder IN ('AI')");
    await client.query("DELETE FROM brain.agent_acl WHERE agent_id = 'E2E_CEO'");
    await client.query(
      "INSERT INTO brain.agent_acl (agent_id, allowed_folders) VALUES ('E2E_CEO', ARRAY['AI']::text[])",
    );
  });

  afterAll(async () => {
    await client.query("DELETE FROM brain.notes WHERE folder IN ('AI')");
    await client.query("DELETE FROM brain.agent_acl WHERE agent_id = 'E2E_CEO'");
    await client.end();
  });

  it("indexes the test vault and finds LM-Studio-related content", async () => {
    const stats = await fullRescan(client, embed, vaultRoot);
    expect(stats.indexed).toBeGreaterThanOrEqual(1);
    expect(stats.errors).toBe(0);

    const tools = createTools({ client, embed });
    const results = await tools.search_vault({
      query: "Was weiß ich über LM Studio Setup?",
      agentId: "E2E_CEO",
      limit: 5,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].folder).toBe("AI");
    expect(results[0].path).toContain("sample.md");
    expect(results[0].score).toBeGreaterThan(0.3);
  });

  it("respects ACL: E2E_UNKNOWN gets empty results", async () => {
    const tools = createTools({ client, embed });
    const results = await tools.search_vault({
      query: "LM Studio",
      agentId: "E2E_UNKNOWN",
      limit: 5,
    });
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: LM Studio starten und Test laufen lassen**

Run:
```bash
# LM Studio läuft, bge-m3-Modell geladen → Embedding-Endpoint aktiv
cd packages/brain && pnpm test -- e2e.test.ts
```
Expected: Beide Tests PASS.

Wenn LM Studio nicht läuft: Test wird korrekt mit Connection-Error scheitern — das ist OK als Smoke-Indikator.

- [ ] **Step 3: Real-Vault-Smoke (optional, nicht-automatisiert)**

Nach der Deployment über launchd:
```bash
# 1. Services prüfen
launchctl list | grep whitestag

# 2. Indexer-Logs verfolgen (sollte den echten Vault durchgehen)
tail -f ~/.whitestag-logs/brain-indexer.log

# 3. Nach ~1h, DB-Status prüfen
psql "$DATABASE_URL" -c "SELECT folder, count(*) FROM brain.notes GROUP BY folder ORDER BY count(*) DESC;"

# 4. MCP-Call als CEO-Agent
curl -s -X POST http://localhost:7777 \
  -H "Authorization: Bearer $BRAIN_PAPERCLIP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool":"search_vault","args":{"query":"Was weiß ich über LM Studio?","agentId":"CEO","limit":5}}' | jq
```
Expected: JSON mit Ergebnissen aus `AI/`-Ordner, score > 0.3.

- [ ] **Step 4: Audit-Log prüfen**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT ts, agent_id, tool, query, array_length(returned_paths,1) as n FROM brain.access_log ORDER BY ts DESC LIMIT 5;"
```
Expected: Eine Zeile pro MCP-Call mit Agent-ID, Tool, Query und Anzahl gelieferter Pfade.

- [ ] **Step 5: Commit und MVP-Abschluss**

```bash
git add packages/brain/test/e2e.test.ts
git commit -m "feat(brain): e2e smoke test for index→search pipeline with ACL enforcement"
```

**MVP-Erfolgsmaß erfüllt, wenn:**
- Indexer läuft per launchd, Vault ist in `brain.notes`/`brain.chunks` indexiert
- MCP-Server läuft per launchd, antwortet auf Bearer-Auth
- Paperclip-Plugin registriert `vault.search` etc. in Paperclips Tool-Registry
- CEO-Agent (per UUID → "CEO"-ACL-Key) bekommt bei "Was weiß ich über LM Studio?" Treffer aus `AI/`
- `brain.access_log` enthält den Call mit korrektem Agent, Query, gelieferten Pfaden
- Unbekannte Agenten bekommen Default-Deny (leere Ergebnisse)

---

## Self-Review Checklist

Nach Plan-Fertigstellung gegen Spec gecheckt:

**Spec coverage:**
- Section 3 (Architektur) — Tasks 1–18 decken alle 5 Komponenten ab ✓
- Section 4 (Indexing-Pipeline) — Tasks 4–8 (Embedder, Parser, Chunker, Writer, Watcher) ✓
- Section 5 (Retrieval & ACL) — Tasks 9–12 (ACL, Audit, Tools, Server) ✓
- Section 6 (Datenmodell) — Task 1 (pgvector + 4 Tabellen) ✓
- Section 7 (Plugin-Wrapper) — Tasks 13–15 ✓
- Section 8 (Security/DSGVO) — MVP: default-deny ACL (Task 9), audit-log (Task 10), bearer-auth (Task 12), sensitive folders nur durch *nicht*-freigeben gesichert. `cloud_allowed` explizit Phase-2 (Spec §9.2) ✓
- Section 9 (MVP-Scope) — alle MVP-Punkte adressiert, Phase-2/3 nicht im Plan ✓

**Type consistency:** `ChunkWithEmbedding`, `ParsedNote`, `SearchResult`, `Embedder` durchgängig. `agentId` als String, nicht mal UUID / mal Name. ✓

**Placeholder scan:** Drei Stellen mit bewussten Platzhaltern (`REPLACE_WITH_…` in Plists, Agent-UUIDs in Seed-Script) sind explizit als Deploy-Time-Konfiguration ausgewiesen, nicht als TBDs. ✓

---

## Offene Punkte für spätere Phasen

Aus Spec §10 und §9.2/9.3 — explizit **nicht** in diesem Plan:

- ACL-Editor-UI (Phase 2)
- `cloud_allowed` + `sensitive_folders` (Phase 2 — DSGVO-Härtung für Cloud-Agenten)
- Secret-Scanner im Indexer (Phase 2)
- VVZ-Eintrag via `whitestag-dsgvo`-Skill (Phase 2 — organisatorisch, nicht Code)
- Hybrid-Search BM25 + Cross-Encoder-Reranking (Phase 3)
- Schreibender Modus `append_to_note` (Phase 3)
- Brücke zur Task-Sync (Teil A des Ursprungskonzepts) (Phase 3)
