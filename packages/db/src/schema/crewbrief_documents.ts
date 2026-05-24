import { pgTable, text, timestamp, uuid, integer, jsonb } from "drizzle-orm/pg-core";

export const crewbriefDocuments = pgTable("crewbrief_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: text("trip_id").notNull(),
  dutyDayId: text("duty_day_id"),
  aircraftTail: text("aircraft_tail"),
  documentType: text("document_type").notNull().default("crew_itinerary"),
  originalFilename: text("original_filename").notNull(),
  storageObjectKey: text("storage_object_key").notNull(),
  contentType: text("content_type").notNull().default("application/pdf"),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  parserStatus: text("parser_status").notNull().default("pending"),
  extractionStatus: jsonb("extraction_status"),
  errorDetails: text("error_details"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  parsedAt: timestamp("parsed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
