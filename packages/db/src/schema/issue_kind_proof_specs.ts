import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  index,
  timestamp,
} from "drizzle-orm/pg-core";

export const issueKindProofSpecs = pgTable(
  "issue_kind_proof_specs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueKind: text("issue_kind").notNull().unique(),
    requiresCiProof: boolean("requires_ci_proof").notNull().default(true),
    requiresLiveUrlProof: boolean("requires_live_url_proof").notNull().default(false),
    requiresReviewApproval: boolean("requires_review_approval").notNull().default(false),
    requiresDocProof: boolean("requires_doc_proof").notNull().default(false),
    proofTypeConfig: jsonb("proof_type_config").$type<{
      ci?: { minConclusion?: string };
      liveUrl?: { minStatus?: number; bodyMustMatch?: string };
      review?: { minApprovals?: number };
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueKindIdx: index("issue_kind_proof_specs_kind_idx").on(table.issueKind),
  }),
);