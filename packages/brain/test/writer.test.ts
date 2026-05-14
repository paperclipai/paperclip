import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createBrainDb, type BrainDbHandle } from "../src/db/client.js";
import { upsertNote } from "../src/db/queries.js";
import { writeChunks, countChunksForNote } from "../src/indexer/writer.js";

const DATABASE_URL = process.env.BRAIN_DATABASE_URL;
if (!DATABASE_URL) throw new Error("BRAIN_DATABASE_URL must be set");

let handle: BrainDbHandle;
let noteId: string;

describe("writer", () => {
  beforeAll(async () => {
    handle = createBrainDb(DATABASE_URL);
    await handle.sql`DELETE FROM brain.notes WHERE path LIKE 'test-writer/%'`;
    noteId = await upsertNote(handle.db, {
      path: "test-writer/x.md",
      folder: "test-writer",
      title: "X",
      frontmatter: {},
      mtime: new Date(),
      sizeBytes: 1,
      checksum: "c",
    });
  });

  afterAll(async () => {
    await handle.sql`DELETE FROM brain.notes WHERE path LIKE 'test-writer/%'`;
    await handle.close();
  });

  it("writeChunks inserts chunks with embeddings", async () => {
    await writeChunks(handle.sql, noteId, [
      {
        chunkIndex: 0,
        headingPath: ["A"],
        content: "chunk zero",
        tokenCount: 10,
        embedding: Array(1024).fill(0.5),
      },
      {
        chunkIndex: 1,
        headingPath: ["A"],
        content: "chunk one",
        tokenCount: 12,
        embedding: Array(1024).fill(0.7),
      },
    ]);
    expect(await countChunksForNote(handle.sql, noteId)).toBe(2);
  });

  it("writeChunks replaces existing chunks for note (transactional)", async () => {
    await writeChunks(handle.sql, noteId, [
      {
        chunkIndex: 0,
        headingPath: ["A"],
        content: "replaced",
        tokenCount: 5,
        embedding: Array(1024).fill(0.1),
      },
    ]);
    expect(await countChunksForNote(handle.sql, noteId)).toBe(1);
  });

  it("writeChunks with empty array deletes all chunks for note", async () => {
    await writeChunks(handle.sql, noteId, []);
    expect(await countChunksForNote(handle.sql, noteId)).toBe(0);
  });
});
