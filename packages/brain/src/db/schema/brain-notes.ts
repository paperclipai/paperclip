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
  (table) => ({
    folderIdx: index("brain_notes_folder_idx").on(table.folder),
    frontmatterIdx: index("brain_notes_frontmatter_idx").using("gin", table.frontmatter),
  }),
);
