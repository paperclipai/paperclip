import type { DocumentAnnotationCommentReactionName } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { documentAnnotationComments } from "./document_annotation_comments.js";

export const documentAnnotationCommentReactions = pgTable(
  "document_annotation_comment_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    commentId: uuid("comment_id").notNull().references(() => documentAnnotationComments.id, { onDelete: "cascade" }),
    reaction: text("reaction").$type<DocumentAnnotationCommentReactionName>().notNull(),
    actorType: text("actor_type").$type<"agent" | "user">().notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => ({
    companyCommentIdx: index("document_annotation_comment_reactions_company_comment_idx").on(
      table.companyId,
      table.commentId,
    ),
    commentReactionActorUniqueIdx: uniqueIndex("document_annotation_comment_reactions_comment_reaction_actor_idx").on(
      table.commentId,
      table.reaction,
      table.actorType,
      table.actorId,
    ),
    reactionChk: check(
      "document_annotation_comment_reactions_reaction_chk",
      sql`${table.reaction} in ('done', 'check', 'thumbs_up', 'question')`,
    ),
    actorTypeChk: check(
      "document_annotation_comment_reactions_actor_type_chk",
      sql`${table.actorType} in ('agent', 'user')`,
    ),
  }),
);
