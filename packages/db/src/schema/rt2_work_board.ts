import { index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const rt2WorkBoardCustomFields = pgTable(
  "rt2_work_board_custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    fieldType: text("field_type").notNull().default("text"),
    position: integer("position").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPositionIdx: index("rt2_work_board_custom_fields_company_position_idx").on(table.companyId, table.position),
  }),
);

export const rt2WorkBoardCustomFieldOptions = pgTable(
  "rt2_work_board_custom_field_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id").notNull().references(() => rt2WorkBoardCustomFields.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    fieldPositionIdx: index("rt2_work_board_custom_field_options_field_position_idx").on(table.companyId, table.fieldId, table.position),
  }),
);

export const rt2WorkBoardCardCustomFieldValues = pgTable(
  "rt2_work_board_card_custom_field_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id").notNull().references(() => rt2WorkBoardCustomFields.id, { onDelete: "cascade" }),
    textValue: text("text_value"),
    numberValue: real("number_value"),
    dateValue: timestamp("date_value", { withTimezone: true }),
    optionId: uuid("option_id").references(() => rt2WorkBoardCustomFieldOptions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueFieldIdx: uniqueIndex("rt2_work_board_card_cfv_issue_field_uq").on(table.companyId, table.issueId, table.fieldId),
  }),
);

export const rt2WorkBoardCards = pgTable(
  "rt2_work_board_cards",
  {
    issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    dueDate: timestamp("due_date", { withTimezone: true }),
    qualityStatus: text("quality_status").notNull().default("none"),
    priceGold: integer("price_gold"),
    detailNotes: text("detail_notes"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDueDateIdx: index("rt2_work_board_cards_company_due_idx").on(table.companyId, table.dueDate),
    companyQualityIdx: index("rt2_work_board_cards_company_quality_idx").on(table.companyId, table.qualityStatus),
  }),
);

export const rt2WorkBoardChecklistItems = pgTable(
  "rt2_work_board_checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    checked: integer("checked").notNull().default(0),
    position: integer("position").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePositionIdx: index("rt2_work_board_checklist_issue_position_idx").on(table.companyId, table.issueId, table.position),
  }),
);

export const rt2WorkBoardAttachments = pgTable(
  "rt2_work_board_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    url: text("url").notNull(),
    contentType: text("content_type"),
    previewKind: text("preview_kind").notNull().default("link"),
    position: integer("position").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePositionIdx: index("rt2_work_board_attachment_issue_position_idx").on(table.companyId, table.issueId, table.position),
  }),
);

export const rt2CaptureSources = pgTable(
  "rt2_capture_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    label: text("label").notNull(),
    installationState: text("installation_state").notNull().default("not_installed"),
    signingStatus: text("signing_status").notNull().default("unsigned"),
    signingSecretHash: text("signing_secret_hash"),
    lastInboundEventAt: timestamp("last_inbound_event_at", { withTimezone: true }),
    lastInboundEventId: text("last_inbound_event_id"),
    lastErrorCode: text("last_error_code"),
    blockedReason: text("blocked_reason"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceUq: uniqueIndex("rt2_capture_sources_company_source_uq").on(table.companyId, table.source),
    companyStateIdx: index("rt2_capture_sources_company_state_idx").on(table.companyId, table.installationState),
  }),
);

export const rt2CaptureDrafts = pgTable(
  "rt2_capture_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    channel: text("channel"),
    externalUserId: text("external_user_id"),
    rawText: text("raw_text").notNull(),
    normalizedHash: text("normalized_hash").notNull(),
    parsedDraft: jsonb("parsed_draft").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("review_required"),
    promotionTarget: text("promotion_target"),
    promotedIssueId: uuid("promoted_issue_id").references(() => issues.id, { onDelete: "set null" }),
    promotedWorkProductId: uuid("promoted_work_product_id"),
    duplicateOfDraftId: uuid("duplicate_of_draft_id"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    permissionStatus: text("permission_status").notNull().default("allowed"),
    sourceInstallationId: uuid("source_installation_id").references(() => rt2CaptureSources.id, { onDelete: "set null" }),
    sourceSigningStatus: text("source_signing_status").notNull().default("unsigned"),
    sourceEvidence: jsonb("source_evidence").$type<Record<string, unknown>>(),
    semanticContext: jsonb("semantic_context").$type<Array<Record<string, unknown>>>().notNull().default([]),
    duplicateWarning: text("duplicate_warning"),
    auditTrail: jsonb("audit_trail").$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdByUserId: text("created_by_user_id"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceStatusIdx: index("rt2_capture_drafts_company_source_status_idx").on(table.companyId, table.source, table.status),
    companyCreatedIdx: index("rt2_capture_drafts_company_created_idx").on(table.companyId, table.createdAt),
    sourceInstallationIdx: index("rt2_capture_drafts_source_installation_idx").on(table.companyId, table.sourceInstallationId),
    duplicateLookupUq: uniqueIndex("rt2_capture_drafts_duplicate_lookup_uq").on(
      table.companyId,
      table.source,
      table.channel,
      table.externalUserId,
      table.normalizedHash,
    ),
  }),
);

export const rt2CaptureDraftRevisions = pgTable(
  "rt2_capture_draft_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id").notNull().references(() => rt2CaptureDrafts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    changeSummary: text("change_summary"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    draftRevisionUq: uniqueIndex("rt2_capture_draft_revisions_draft_revision_uq").on(table.draftId, table.revisionNumber),
    companyDraftIdx: index("rt2_capture_draft_revisions_company_draft_idx").on(table.companyId, table.draftId),
  }),
);
