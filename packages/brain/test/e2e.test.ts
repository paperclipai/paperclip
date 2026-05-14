import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrainDb, type BrainDbHandle } from "../src/db/client.js";
import { setAcl } from "../src/db/queries.js";
import { createEmbedder } from "../src/indexer/embedder.js";
import { fullRescan } from "../src/indexer/rescan.js";
import { createTools } from "../src/mcp-server/tools.js";

const DATABASE_URL = process.env.BRAIN_DATABASE_URL;
if (!DATABASE_URL) throw new Error("BRAIN_DATABASE_URL must be set for e2e tests");

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = path.join(here, "fixtures/test-vault");

let handle: BrainDbHandle;
const embed = createEmbedder({
  baseUrl: process.env.BRAIN_LM_STUDIO_URL ?? "http://localhost:1234",
  model: process.env.BRAIN_EMBEDDING_MODEL ?? "text-embedding-bge-m3",
});

describe("end-to-end: index test vault → search via MCP tools (live LM Studio)", () => {
  beforeAll(async () => {
    handle = createBrainDb(DATABASE_URL);
    await handle.sql`DELETE FROM brain.notes WHERE folder = 'AI'`;
    await handle.sql`DELETE FROM brain.agent_acl WHERE agent_id IN ('E2E_CEO','E2E_UNKNOWN')`;
    await setAcl(handle.db, "E2E_CEO", ["AI"], "e2e test");
  });

  afterAll(async () => {
    await handle.sql`DELETE FROM brain.notes WHERE folder = 'AI'`;
    await handle.sql`DELETE FROM brain.agent_acl WHERE agent_id IN ('E2E_CEO','E2E_UNKNOWN')`;
    await handle.close();
  });

  it("indexes the test vault and finds LM-Studio-related content", async () => {
    const stats = await fullRescan(handle, embed, vaultRoot);
    expect(stats.errors).toBe(0);
    expect(stats.indexed).toBeGreaterThanOrEqual(1);

    const tools = createTools({ handle, embed });
    const results = await tools.search_vault({
      query: "Was weiß ich über LM Studio Setup?",
      agentId: "E2E_CEO",
      limit: 5,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.folder).toBe("AI");
    expect(results[0]!.path).toContain("sample.md");
    expect(results[0]!.score).toBeGreaterThan(0.3);
  }, 30_000);

  it("respects ACL: unknown agent gets empty results", async () => {
    const tools = createTools({ handle, embed });
    const results = await tools.search_vault({
      query: "LM Studio",
      agentId: "E2E_UNKNOWN",
      limit: 5,
    });
    expect(results).toEqual([]);
  });

  it("get_note returns content for allowed folder", async () => {
    const tools = createTools({ handle, embed });
    const note = await tools.get_note({ path: "AI/sample.md", agentId: "E2E_CEO" });
    expect(note).not.toBeNull();
    expect(note?.title).toBe("LM Studio Setup");
    expect(note?.body).toContain("LM Studio");
  });

  it("list_scope reflects seeded ACL", async () => {
    const tools = createTools({ handle, embed });
    const scope = await tools.list_scope({ agentId: "E2E_CEO" });
    expect(scope.allowedFolders).toEqual(["AI"]);
    expect(scope.noteCount).toBeGreaterThanOrEqual(1);
  });
});
