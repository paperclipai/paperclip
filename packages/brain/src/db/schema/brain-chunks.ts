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
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string) {
    return value.slice(1, -1).split(",").map(Number);
  },
});

export const brainChunks = brainSchema.table(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => brainNotes.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    headingPath: text("heading_path").array(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
  },
  (table) => ({
    noteIdx: index("brain_chunks_note_idx").on(table.noteId),
    embeddingIdx: index("brain_chunks_embedding_idx").using(
      "hnsw",
      sql`${table.embedding} vector_cosine_ops`,
    ),
    noteChunkUnique: unique("brain_chunks_note_chunk_unique").on(table.noteId, table.chunkIndex),
  }),
);
