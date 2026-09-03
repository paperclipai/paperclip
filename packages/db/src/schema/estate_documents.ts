import { pgEnum, pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estates } from "./estates.js";

export const documentTypeEnum = pgEnum("estate_document_type", [
  "will",
  "trust",
  "deed",
  "poa",
  "healthcare_directive",
  "insurance",
  "other",
]);

export const documentAccessPolicyEnum = pgEnum("estate_document_access_policy", [
  "owner_only",
  "advisor_readable",
  "beneficiary_event_triggered",
]);

export const documentAccessTypeEnum = pgEnum("estate_document_access_type", [
  "view",
  "download",
  "share_link",
]);

export const estateDocuments = pgTable(
  "estate_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    estateId: uuid("estate_id")
      .notNull()
      .references(() => estates.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    uploaderUserId: text("uploader_user_id").notNull(),
    documentType: documentTypeEnum("document_type").notNull().default("other"),
    title: text("title").notNull(),
    s3Key: text("s3_key").notNull(),
    s3Bucket: text("s3_bucket").notNull(),
    kmsKeyId: text("kms_key_id"),
    contentHash: text("content_hash"),
    sizeBytes: integer("size_bytes"),
    accessPolicy: documentAccessPolicyEnum("access_policy").notNull().default("owner_only"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    estateIdx: index("estate_documents_estate_idx").on(table.estateId),
    companyIdx: index("estate_documents_company_idx").on(table.companyId),
  }),
);

export const estateDocumentAccessLog = pgTable(
  "estate_document_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => estateDocuments.id, { onDelete: "cascade" }),
    accessorUserId: text("accessor_user_id").notNull(),
    accessType: documentAccessTypeEnum("access_type").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index("estate_document_access_log_document_idx").on(table.documentId),
  }),
);
