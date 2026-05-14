import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createBrainDb, type BrainDbHandle } from "../src/db/client.js";
import { setAcl } from "../src/db/queries.js";
import { createTools } from "../src/mcp-server/tools.js";
import type { Embedder } from "../src/indexer/embedder.js";

const DATABASE_URL = process.env.BRAIN_DATABASE_URL;
if (!DATABASE_URL) throw new Error("BRAIN_DATABASE_URL must be set");

const fakeEmbed: Embedder = {
  async embedBatch(inputs: string[]): Promise<number[][]> {
    return inputs.map(() => Array(1024).fill(0).map((_, i) => (i === 0 ? 0.9 : 0)));
  },
};

let handle: BrainDbHandle;

const seedVec = "[" + Array(1024).fill(0).map((_, i) => (i === 0 ? 0.9 : 0)).join(",") + "]";

describe("mcp tools", () => {
  beforeAll(async () => {
    handle = createBrainDb(DATABASE_URL);
    await handle.sql`DELETE FROM brain.notes WHERE folder IN ('tools-test','tools-forbidden','tools-excluded')`;
    await handle.sql`DELETE FROM brain.agent_acl WHERE agent_id IN ('T_TOOLS','T_UNKNOWN')`;
    await setAcl(handle.db, "T_TOOLS", ["tools-test", "tools-excluded"], "test agent");

    const allowed = await handle.sql<Array<{ id: string }>>`
      INSERT INTO brain.notes (path, folder, title, frontmatter, mtime, size_bytes, checksum)
      VALUES ('tools-test/a.md', 'tools-test', 'Allowed', '{}'::jsonb, now(), 1, 'x')
      RETURNING id
    `;
    const forbidden = await handle.sql<Array<{ id: string }>>`
      INSERT INTO brain.notes (path, folder, title, frontmatter, mtime, size_bytes, checksum)
      VALUES ('tools-forbidden/b.md', 'tools-forbidden', 'Forbidden', '{}'::jsonb, now(), 1, 'y')
      RETURNING id
    `;
    const excluded = await handle.sql<Array<{ id: string }>>`
      INSERT INTO brain.notes (path, folder, title, frontmatter, mtime, size_bytes, checksum)
      VALUES ('tools-excluded/c.md', 'tools-excluded', 'Excluded', '{"agent_exclude":["T_TOOLS"]}'::jsonb, now(), 1, 'z')
      RETURNING id
    `;
    await handle.sql.unsafe(
      `INSERT INTO brain.chunks (note_id, chunk_index, heading_path, content, token_count, embedding, embedded_at)
       VALUES
         ($1, 0, ARRAY['Allowed'],   'allowed body',   5, $4::vector, now()),
         ($2, 0, ARRAY['Forbidden'], 'forbidden body', 5, $4::vector, now()),
         ($3, 0, ARRAY['Excluded'],  'excluded body',  5, $4::vector, now())`,
      [allowed[0]!.id, forbidden[0]!.id, excluded[0]!.id, seedVec],
    );
  });

  afterAll(async () => {
    await handle.sql`DELETE FROM brain.notes WHERE folder IN ('tools-test','tools-forbidden','tools-excluded')`;
    await handle.sql`DELETE FROM brain.agent_acl WHERE agent_id IN ('T_TOOLS','T_UNKNOWN')`;
    await handle.close();
  });

  it("search_vault returns only allowed folder results (no forbidden, no agent_exclude)", async () => {
    const tools = createTools({ handle, embed: fakeEmbed });
    const results = await tools.search_vault({ query: "body", agentId: "T_TOOLS", limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0]!.folder).toBe("tools-test");
    expect(results[0]!.path).toBe("tools-test/a.md");
  });

  it("search_vault returns empty for unknown agent (default-deny)", async () => {
    const tools = createTools({ handle, embed: fakeEmbed });
    const results = await tools.search_vault({ query: "body", agentId: "T_UNKNOWN", limit: 10 });
    expect(results).toEqual([]);
  });

  it("get_note returns content when allowed", async () => {
    const tools = createTools({ handle, embed: fakeEmbed });
    const note = await tools.get_note({ path: "tools-test/a.md", agentId: "T_TOOLS" });
    expect(note?.title).toBe("Allowed");
    expect(note?.body).toContain("allowed body");
  });

  it("get_note returns null when folder forbidden", async () => {
    const tools = createTools({ handle, embed: fakeEmbed });
    const note = await tools.get_note({ path: "tools-forbidden/b.md", agentId: "T_TOOLS" });
    expect(note).toBeNull();
  });

  it("get_note returns null when frontmatter excludes agent", async () => {
    const tools = createTools({ handle, embed: fakeEmbed });
    const note = await tools.get_note({ path: "tools-excluded/c.md", agentId: "T_TOOLS" });
    expect(note).toBeNull();
  });

  it("list_scope returns allowed folders and note count", async () => {
    const tools = createTools({ handle, embed: fakeEmbed });
    const scope = await tools.list_scope({ agentId: "T_TOOLS" });
    expect(scope.allowedFolders).toEqual(["tools-test", "tools-excluded"]);
    expect(scope.noteCount).toBeGreaterThanOrEqual(2);
  });

  it("list_scope returns empty for unknown agent", async () => {
    const tools = createTools({ handle, embed: fakeEmbed });
    const scope = await tools.list_scope({ agentId: "T_UNKNOWN" });
    expect(scope).toEqual({ allowedFolders: [], noteCount: 0 });
  });
});
