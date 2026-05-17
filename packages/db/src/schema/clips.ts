import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const clipCreatorProfiles = pgTable(
  "clip_creator_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    avatarUrl: text("avatar_url"),
    websiteUrl: text("website_url"),
    verificationState: text("verification_state").notNull().default("unverified"),
    reputationSummary: jsonb("reputation_summary").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("clip_creator_profiles_company_idx").on(table.companyId),
    handleUq: uniqueIndex("clip_creator_profiles_handle_uq").on(table.handle),
  }),
);

export const clips = pgTable(
  "clips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id),
    creatorProfileId: uuid("creator_profile_id").notNull().references(() => clipCreatorProfiles.id),
    slug: text("slug").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    description: text("description"),
    visibility: text("visibility").notNull().default("unlisted"),
    status: text("status").notNull().default("pending_review"),
    moderationState: text("moderation_state").notNull().default("normal"),
    currentRevisionId: uuid("current_revision_id"),
    latestApprovedRevisionId: uuid("latest_approved_revision_id"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    useCases: jsonb("use_cases").$type<string[]>().notNull().default([]),
    requiredProviders: jsonb("required_providers").$type<string[]>().notNull().default([]),
    compatibility: jsonb("compatibility").$type<Record<string, unknown>>().notNull().default({}),
    sourceKind: text("source_kind"),
    sourceObjectType: text("source_object_type"),
    sourceObjectId: text("source_object_id"),
    importCount: integer("import_count").notNull().default(0),
    successfulFirstRunCount: integer("successful_first_run_count").notNull().default(0),
    voteScore: integer("vote_score").notNull().default(0),
    upvoteCount: integer("upvote_count").notNull().default(0),
    downvoteCount: integer("downvote_count").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    showcaseCount: integer("showcase_count").notNull().default(0),
    reportCount: integer("report_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    delistedAt: timestamp("delisted_at", { withTimezone: true }),
  },
  (table) => ({
    slugUq: uniqueIndex("clips_slug_uq").on(table.slug),
    sourceCompanyIdx: index("clips_source_company_idx").on(table.sourceCompanyId),
    creatorIdx: index("clips_creator_idx").on(table.creatorProfileId),
    publicBrowseIdx: index("clips_public_browse_idx").on(table.visibility, table.status, table.moderationState, table.updatedAt),
    typeIdx: index("clips_type_idx").on(table.type),
  }),
);

export const clipRevisions = pgTable(
  "clip_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionNumber: integer("revision_number").notNull(),
    manifestVersion: text("manifest_version").notNull().default("paperclip.clip/v1"),
    manifestChecksum: text("manifest_checksum").notNull(),
    artifactChecksum: text("artifact_checksum").notNull(),
    manifestPayload: jsonb("manifest_payload").$type<Record<string, unknown>>().notNull(),
    artifactRef: jsonb("artifact_ref").$type<Record<string, unknown> | null>(),
    dependencyGraph: jsonb("dependency_graph").$type<Record<string, unknown>>().notNull().default({}),
    permissions: jsonb("permissions").$type<Record<string, unknown>[]>().notNull().default([]),
    secretsSchema: jsonb("secrets_schema").$type<Record<string, unknown>[]>().notNull().default([]),
    budgetEstimate: jsonb("budget_estimate").$type<Record<string, unknown> | null>(),
    redactionReport: jsonb("redaction_report").$type<Record<string, unknown>>().notNull().default({}),
    dangerousCapabilities: jsonb("dangerous_capabilities").$type<string[]>().notNull().default([]),
    securityReviewState: text("security_review_state").notNull().default("unreviewed"),
    verificationState: text("verification_state").notNull().default("not_run"),
    compatibility: jsonb("compatibility").$type<Record<string, unknown>>().notNull().default({}),
    changeSummary: text("change_summary"),
    breakingChanges: text("breaking_changes"),
    migrationNotes: text("migration_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clipRevisionUq: uniqueIndex("clip_revisions_clip_revision_uq").on(table.clipId, table.revisionNumber),
    clipCreatedIdx: index("clip_revisions_clip_created_idx").on(table.clipId, table.createdAt),
    manifestChecksumIdx: index("clip_revisions_manifest_checksum_idx").on(table.manifestChecksum),
  }),
);

export const clipDependencies = pgTable(
  "clip_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionId: uuid("revision_id").notNull().references(() => clipRevisions.id),
    type: text("type").notNull(),
    key: text("key").notNull(),
    displayName: text("display_name"),
    required: text("required").notNull().default("required"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    revisionIdx: index("clip_dependencies_revision_idx").on(table.revisionId),
    typeKeyIdx: index("clip_dependencies_type_key_idx").on(table.type, table.key),
    revisionTypeKeyUq: uniqueIndex("clip_dependencies_revision_type_key_uq").on(table.revisionId, table.type, table.key),
  }),
);

export const clipComments = pgTable(
  "clip_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionId: uuid("revision_id").references(() => clipRevisions.id),
    creatorProfileId: uuid("creator_profile_id").references(() => clipCreatorProfiles.id),
    authorUserId: text("author_user_id"),
    authorAgentId: uuid("author_agent_id"),
    scope: text("scope").notNull().default("clip"),
    category: text("category").notNull().default("question"),
    moderationState: text("moderation_state").notNull().default("normal"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clipCreatedIdx: index("clip_comments_clip_created_idx").on(table.clipId, table.createdAt),
    revisionIdx: index("clip_comments_revision_idx").on(table.revisionId),
  }),
);

export const clipVotes = pgTable(
  "clip_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionId: uuid("revision_id").notNull().references(() => clipRevisions.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    vote: text("vote").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    revisionIdx: index("clip_votes_revision_idx").on(table.revisionId),
    actorUq: uniqueIndex("clip_votes_revision_actor_uq").on(table.revisionId, table.actorType, table.actorId),
  }),
);

export const clipShowcasePosts = pgTable(
  "clip_showcase_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionId: uuid("revision_id").notNull().references(() => clipRevisions.id),
    creatorProfileId: uuid("creator_profile_id").references(() => clipCreatorProfiles.id),
    authorUserId: text("author_user_id"),
    authorAgentId: uuid("author_agent_id"),
    type: text("type").notNull().default("community_example"),
    title: text("title").notNull(),
    body: text("body"),
    mediaRefs: jsonb("media_refs").$type<Record<string, unknown>[]>().notNull().default([]),
    validationState: text("validation_state").notNull().default("not_run"),
    moderationState: text("moderation_state").notNull().default("normal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clipCreatedIdx: index("clip_showcase_posts_clip_created_idx").on(table.clipId, table.createdAt),
    revisionIdx: index("clip_showcase_posts_revision_idx").on(table.revisionId),
  }),
);

export const clipFlags = pgTable(
  "clip_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionId: uuid("revision_id").references(() => clipRevisions.id),
    reporterType: text("reporter_type").notNull().default("anonymous"),
    reporterId: text("reporter_id"),
    reason: text("reason").notNull(),
    details: text("details"),
    status: text("status").notNull().default("open"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clipStatusIdx: index("clip_flags_clip_status_idx").on(table.clipId, table.status),
    revisionIdx: index("clip_flags_revision_idx").on(table.revisionId),
  }),
);

export const clipModerationEvents = pgTable(
  "clip_moderation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionId: uuid("revision_id").references(() => clipRevisions.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    reason: text("reason").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clipCreatedIdx: index("clip_moderation_events_clip_created_idx").on(table.clipId, table.createdAt),
  }),
);

export const clipRankingSnapshots = pgTable(
  "clip_ranking_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    scope: text("scope").notNull().default("global"),
    score: integer("score").notNull().default(0),
    factors: jsonb("factors").$type<Record<string, unknown>>().notNull().default({}),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeScoreIdx: index("clip_ranking_snapshots_scope_score_idx").on(table.scope, table.score),
    clipScopeUq: uniqueIndex("clip_ranking_snapshots_clip_scope_uq").on(table.clipId, table.scope),
  }),
);

export const clipImports = pgTable(
  "clip_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    destinationCompanyId: uuid("destination_company_id").notNull().references(() => companies.id),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionId: uuid("revision_id").notNull().references(() => clipRevisions.id),
    revisionNumber: integer("revision_number").notNull(),
    manifestChecksum: text("manifest_checksum").notNull(),
    artifactChecksum: text("artifact_checksum").notNull(),
    sourceUrl: text("source_url"),
    revisionUrl: text("revision_url"),
    status: text("status").notNull().default("previewed"),
    importedByUserId: text("imported_by_user_id"),
    importedByAgentId: uuid("imported_by_agent_id"),
    collisionStrategy: text("collision_strategy"),
    selectedOptions: jsonb("selected_options").$type<Record<string, unknown>>().notNull().default({}),
    firstRunValidationState: text("first_run_validation_state").notNull().default("not_run"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    destinationIdx: index("clip_imports_destination_idx").on(table.destinationCompanyId, table.createdAt),
    revisionIdx: index("clip_imports_revision_idx").on(table.revisionId),
  }),
);

export const clipImportedObjects = pgTable(
  "clip_imported_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipImportId: uuid("clip_import_id").notNull().references(() => clipImports.id),
    destinationObjectType: text("destination_object_type").notNull(),
    destinationObjectId: text("destination_object_id").notNull(),
    packagePath: text("package_path"),
    action: text("action").notNull(),
    localFingerprint: text("local_fingerprint"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    importIdx: index("clip_imported_objects_import_idx").on(table.clipImportId),
    destinationIdx: index("clip_imported_objects_destination_idx").on(table.destinationObjectType, table.destinationObjectId),
  }),
);

export const clipPublicMetricEvents = pgTable(
  "clip_public_metric_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id").notNull().references(() => clips.id),
    revisionId: uuid("revision_id").references(() => clipRevisions.id),
    eventType: text("event_type").notNull(),
    actorHash: text("actor_hash"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clipEventIdx: index("clip_public_metric_events_clip_event_idx").on(table.clipId, table.eventType, table.createdAt),
  }),
);
