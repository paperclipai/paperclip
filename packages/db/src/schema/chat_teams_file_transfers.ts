import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import {
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
  chatPublications,
} from "./chat_channels.js";
import { issues } from "./issues.js";

// Private operational state. Neither ciphertext nor its decrypted capability
// belongs in the public publication/action projection.
export const chatTeamsFileTransfers = pgTable(
  "chat_teams_file_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    publicationId: uuid("publication_id").notNull(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "restrict" }),
    // Immutable evidence, not foreign keys: deleting a source must remain
    // possible without erasing unknown provider effects or blocking user deletion.
    commentId: uuid("comment_id").notNull(),
    attachmentId: uuid("attachment_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    authorizedUserId: text("authorized_user_id"),
    runtimeGeneration: integer("runtime_generation").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    conversationGeneration: integer("conversation_generation").notNull(),
    sourceDigest: text("source_digest").notNull(),
    authorityDigest: text("authority_digest").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    botAppId: uuid("bot_app_id").notNull(),
    aadObjectId: uuid("aad_object_id").notNull(),
    providerConversationId: text("provider_conversation_id").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    filename: text("filename").notNull(),
    tokenSha256: text("token_sha256").notNull(),
    phase: text("phase").notNull().default("consent_pending"),
    version: integer("version").notNull().default(1),
    attemptId: uuid("attempt_id"),
    attemptExpiresAt: timestamp("attempt_expires_at", { withTimezone: true }),
    consentMessageId: text("consent_message_id"),
    fileInfoMessageId: text("file_info_message_id"),
    responseActivityId: text("response_activity_id"),
    responseDigest: text("response_digest"),
    privateState: jsonb("private_state")
      .$type<Record<string, unknown>>()
      .notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_teams_file_transfers_publication_uq").on(
      t.companyId,
      t.publicationId,
    ),
    uniqueIndex("chat_teams_file_transfers_token_uq").on(
      t.endpointId,
      t.tokenSha256,
    ),
    index("chat_teams_file_transfers_work_idx").on(
      t.phase,
      t.attemptExpiresAt,
      t.expiresAt,
    ),
    foreignKey({
      columns: [t.companyId, t.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.companyId, t.publicationId],
      foreignColumns: [chatPublications.companyId, chatPublications.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.companyId, t.conversationId],
      foreignColumns: [chatConversations.companyId, chatConversations.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.companyId, t.principalId],
      foreignColumns: [
        chatExternalPrincipals.companyId,
        chatExternalPrincipals.id,
      ],
    }),
    check(
      "chat_teams_file_transfers_phase_check",
      sql`${t.phase} in ('consent_pending','consent_sending','consent_unknown','awaiting_consent','upload_pending','uploading','upload_unknown','file_info_pending','file_info_sending','file_info_unknown','delivered','declined','expired','cancelled','conflict')`,
    ),
    check(
      "chat_teams_file_transfers_bounds_check",
      sql`${t.version} > 0 and ${t.runtimeGeneration} >= 0 and ${t.conversationGeneration} > 0 and ${t.byteSize} > 0 and ${t.byteSize} < 62914560`,
    ),
    check(
      "chat_teams_file_transfers_hash_check",
      sql`${t.sourceDigest} ~ '^[a-f0-9]{64}$' and ${t.authorityDigest} ~ '^[a-f0-9]{64}$' and ${t.sha256} ~ '^[a-f0-9]{64}$' and ${t.tokenSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "chat_teams_file_transfers_attempt_check",
      sql`(${t.attemptId} is null) = (${t.attemptExpiresAt} is null)`,
    ),
  ],
);
