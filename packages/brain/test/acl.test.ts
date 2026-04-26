import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createBrainDb, type BrainDbHandle } from "../src/db/client.js";
import { setAcl } from "../src/db/queries.js";
import {
  getAgentScope,
  isFolderAllowed,
  isAgentExcludedByFrontmatter,
} from "../src/mcp-server/acl.js";

const DATABASE_URL = process.env.BRAIN_DATABASE_URL;
if (!DATABASE_URL) throw new Error("BRAIN_DATABASE_URL must be set");

let handle: BrainDbHandle;

describe("acl", () => {
  beforeAll(async () => {
    handle = createBrainDb(DATABASE_URL);
    await handle.sql`DELETE FROM brain.agent_acl WHERE agent_id IN ('T_CEO','T_UNKNOWN')`;
    await setAcl(handle.db, "T_CEO", ["AI", "Dokumente"], "test ceo");
  });

  afterAll(async () => {
    await handle.sql`DELETE FROM brain.agent_acl WHERE agent_id IN ('T_CEO','T_UNKNOWN')`;
    await handle.close();
  });

  it("getAgentScope returns folders for known agent", async () => {
    const scope = await getAgentScope(handle.db, "T_CEO");
    expect(scope.allowedFolders).toEqual(["AI", "Dokumente"]);
  });

  it("getAgentScope returns empty for unknown agent (default-deny)", async () => {
    const scope = await getAgentScope(handle.db, "T_UNKNOWN");
    expect(scope.allowedFolders).toEqual([]);
  });

  it("isFolderAllowed reflects scope", () => {
    const scope = { agentId: "T_CEO", allowedFolders: ["AI", "Dokumente"] };
    expect(isFolderAllowed(scope, "AI")).toBe(true);
    expect(isFolderAllowed(scope, "Kontakte")).toBe(false);
  });

  it("isAgentExcludedByFrontmatter detects exclude entries", () => {
    expect(isAgentExcludedByFrontmatter("CTO", { agent_exclude: ["CTO"] })).toBe(true);
    expect(isAgentExcludedByFrontmatter("CEO", { agent_exclude: ["CTO"] })).toBe(false);
    expect(isAgentExcludedByFrontmatter("CEO", {})).toBe(false);
    expect(isAgentExcludedByFrontmatter("CEO", null)).toBe(false);
  });
});
