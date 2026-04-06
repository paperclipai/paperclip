import { pgTable, uuid, text, bigint, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { deliverables } from "./deliverables.js";

export const deliverableContents = pgTable(
  "deliverable_contents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"),
    filePath: text("file_path"),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    metadata: jsonb("metadata"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliverableIdx: index("idx_deliverable_contents_deliverable").on(table.deliverableId),
  }),
);
