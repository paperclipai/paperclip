import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createBrainDb, type BrainDbHandle } from "../src/db/client.js";
import {
  upsertNote,
  getNoteByPath,
  deleteNote,
  getAclForAgent,
  setAcl,
  countNotes,
} from "../src/db/queries.js";

const DATABASE_URL = process.env.BRAIN_DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("BRAIN_DATABASE_URL must be set for tests (e.g. paperclip_brain on localhost)");
}

let handle: BrainDbHandle;

describe("brain.db queries", () => {
  beforeAll(async () => {
    handle = createBrainDb(DATABASE_URL);
    await handle.sql`DELETE FROM brain.notes WHERE path LIKE 'test/%'`;
    await handle.sql`DELETE FROM brain.agent_acl WHERE agent_id IN ('TEST_AGENT', 'TEST_UNKNOWN_AGENT')`;
  });

  afterAll(async () => {
    await handle.sql`DELETE FROM brain.notes WHERE path LIKE 'test/%'`;
    await handle.sql`DELETE FROM brain.agent_acl WHERE agent_id IN ('TEST_AGENT', 'TEST_UNKNOWN_AGENT')`;
    await handle.close();
  });

  it("upsertNote creates a new note", async () => {
    const noteId = await upsertNote(handle.db, {
      path: "test/alpha.md",
      folder: "test",
      title: "Alpha",
      frontmatter: { tags: ["a"] },
      mtime: new Date("2026-01-01T00:00:00Z"),
      sizeBytes: 42,
      checksum: "abc123",
    });
    expect(noteId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("getNoteByPath returns existing note", async () => {
    const note = await getNoteByPath(handle.db, "test/alpha.md");
    expect(note).not.toBeNull();
    expect(note?.title).toBe("Alpha");
    expect(note?.folder).toBe("test");
    expect(note?.frontmatter).toEqual({ tags: ["a"] });
    expect(note?.checksum).toBe("abc123");
  });

  it("upsertNote updates existing note with same path", async () => {
    const noteId1 = await upsertNote(handle.db, {
      path: "test/beta.md",
      folder: "test",
      title: "Beta v1",
      frontmatter: {},
      mtime: new Date("2026-01-01T00:00:00Z"),
      sizeBytes: 10,
      checksum: "x",
    });
    const noteId2 = await upsertNote(handle.db, {
      path: "test/beta.md",
      folder: "test",
      title: "Beta v2",
      frontmatter: { changed: true },
      mtime: new Date("2026-02-01T00:00:00Z"),
      sizeBytes: 20,
      checksum: "y",
    });
    expect(noteId1).toBe(noteId2);
    const note = await getNoteByPath(handle.db, "test/beta.md");
    expect(note?.title).toBe("Beta v2");
    expect(note?.frontmatter).toEqual({ changed: true });
  });

  it("deleteNote removes note", async () => {
    await deleteNote(handle.db, "test/alpha.md");
    const note = await getNoteByPath(handle.db, "test/alpha.md");
    expect(note).toBeNull();
  });

  it("getAclForAgent returns empty array for unknown agent (default-deny)", async () => {
    const folders = await getAclForAgent(handle.db, "TEST_UNKNOWN_AGENT");
    expect(folders).toEqual([]);
  });

  it("setAcl + getAclForAgent returns configured folders", async () => {
    await setAcl(handle.db, "TEST_AGENT", ["AI", "Dokumente"], "test agent");
    const folders = await getAclForAgent(handle.db, "TEST_AGENT");
    expect(folders).toEqual(["AI", "Dokumente"]);
  });

  it("countNotes returns at least the seeded test notes", async () => {
    const count = await countNotes(handle.db);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
