import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createBrainDb, type BrainDbHandle } from "../src/db/client.js";
import { logAccess } from "../src/mcp-server/audit.js";

const DATABASE_URL = process.env.BRAIN_DATABASE_URL;
if (!DATABASE_URL) throw new Error("BRAIN_DATABASE_URL must be set");

let handle: BrainDbHandle;

describe("audit", () => {
  beforeAll(async () => {
    handle = createBrainDb(DATABASE_URL);
    await handle.sql`DELETE FROM brain.access_log WHERE agent_id = 'T_AUDIT'`;
  });

  afterAll(async () => {
    await handle.sql`DELETE FROM brain.access_log WHERE agent_id = 'T_AUDIT'`;
    await handle.close();
  });

  it("logAccess writes a row with all fields", async () => {
    await logAccess(handle.db, {
      agentId: "T_AUDIT",
      tool: "search_vault",
      query: "test query",
      returnedPaths: ["AI/a.md", "AI/b.md"],
      latencyMs: 42,
      ok: true,
    });
    const rows = await handle.sql<
      Array<{ tool: string; query: string; returned_paths: string[]; latency_ms: number; ok: boolean }>
    >`
      SELECT tool, query, returned_paths, latency_ms, ok
      FROM brain.access_log WHERE agent_id = 'T_AUDIT' ORDER BY ts DESC LIMIT 1
    `;
    expect(rows[0]?.tool).toBe("search_vault");
    expect(rows[0]?.query).toBe("test query");
    expect(rows[0]?.returned_paths).toEqual(["AI/a.md", "AI/b.md"]);
    expect(rows[0]?.latency_ms).toBe(42);
    expect(rows[0]?.ok).toBe(true);
  });

  it("logAccess writes failure row", async () => {
    await logAccess(handle.db, {
      agentId: "T_AUDIT",
      tool: "get_note",
      path: "nope.md",
      returnedPaths: [],
      latencyMs: 1,
      ok: false,
    });
    const rows = await handle.sql<Array<{ ok: boolean }>>`
      SELECT ok FROM brain.access_log WHERE agent_id = 'T_AUDIT' AND tool = 'get_note'
    `;
    expect(rows[0]?.ok).toBe(false);
  });
});
