/**
 * QSL Review persistence service.
 *
 * Syncs findings from the QSL bridge into the database and tracks
 * review state (new, acknowledged, accepted_risk, suppressed, escalated)
 * and decisions (approved/denied) with full history.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { qslFindings } from "@paperclipai/db";
import { createHash } from "node:crypto";

export type ReviewState =
  | "new"
  | "recurring"
  | "pending_review"
  | "approved"
  | "denied"
  | "accepted_risk"
  | "suppressed"
  | "escalated";

export type ReviewDecision = "approved" | "denied" | null;

/** States that belong in the active review queue. */
export const ACTIVE_REVIEW_STATES: ReadonlySet<string> = new Set([
  "new",
  "recurring",
  "pending_review",
]);

/** All valid review states. */
export const ALL_REVIEW_STATES: readonly string[] = [
  "new",
  "recurring",
  "pending_review",
  "approved",
  "denied",
  "accepted_risk",
  "suppressed",
  "escalated",
];

export interface QslBridgeIssue {
  id?: string;
  title: string;
  severity?: string;
  priority?: string;
  risk_score?: number;
  rule_id?: string;
  threat_category?: string;
  status?: string;
  [key: string]: unknown;
}

export interface QslFinding {
  id: string;
  companyId: string;
  fingerprint: string;
  ruleId: string | null;
  title: string;
  severity: string | null;
  threatCategory: string | null;
  reviewState: string;
  reviewDecision: string | null;
  reviewerId: string | null;
  reviewedAt: Date | null;
  firstSeen: Date;
  lastSeen: Date;
  occurrenceCount: number;
  latestRiskScore: number | null;
  latestPayload: Record<string, unknown> | null;
  reviewHistory: Array<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Compute a stable fingerprint for deduplication.
 * Uses title + threat_category + severity to identify the same finding across scans.
 */
function computeFingerprint(issue: QslBridgeIssue): string {
  const parts = [
    issue.title ?? "",
    issue.threat_category ?? "",
    issue.severity ?? "",
  ];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40);
}

function deriveRuleId(issue: QslBridgeIssue): string | null {
  if (issue.rule_id) return issue.rule_id;
  if (issue.threat_category) {
    return issue.threat_category.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  }
  if (issue.title) {
    return issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 64);
  }
  return null;
}

export function qslReviewService(db: Db) {
  return {
    /**
     * Sync bridge issues into the database. New findings are inserted;
     * recurring findings get their occurrence count bumped and last_seen updated.
     * Reviewed findings keep their review state.
     */
    async syncFindings(companyId: string, bridgeIssues: QslBridgeIssue[]): Promise<void> {
      const now = new Date();

      for (const issue of bridgeIssues) {
        const fingerprint = computeFingerprint(issue);
        const ruleId = deriveRuleId(issue);

        const existing = await db
          .select()
          .from(qslFindings)
          .where(
            and(
              eq(qslFindings.companyId, companyId),
              eq(qslFindings.fingerprint, fingerprint),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existing) {
          // Only bump occurrence count if last_seen is more than 5 minutes ago
          // (prevents inflation from page refreshes hitting the same scan data)
          const msSinceLastSeen = now.getTime() - existing.lastSeen.getTime();
          const isNewOccurrence = msSinceLastSeen > 5 * 60 * 1000;

          const updateFields: Record<string, unknown> = {
            lastSeen: now,
            latestRiskScore: issue.risk_score ?? existing.latestRiskScore,
            latestPayload: issue as Record<string, unknown>,
            updatedAt: now,
          };

          if (isNewOccurrence) {
            updateFields.occurrenceCount = sql`${qslFindings.occurrenceCount} + 1`;

            // If it was "new" and is seen again in a new scan, mark as "recurring"
            if (existing.reviewState === "new") {
              updateFields.reviewState = "recurring";
            }
          }

          // Update rule_id if we now have a better one
          if (ruleId && !existing.ruleId) {
            updateFields.ruleId = ruleId;
          }

          await db
            .update(qslFindings)
            .set(updateFields)
            .where(eq(qslFindings.id, existing.id));
        } else {
          // Insert new finding
          await db.insert(qslFindings).values({
            companyId,
            fingerprint,
            ruleId,
            title: issue.title,
            severity: issue.severity ?? null,
            threatCategory: issue.threat_category ?? null,
            reviewState: "new",
            reviewDecision: null,
            reviewerId: null,
            reviewedAt: null,
            firstSeen: now,
            lastSeen: now,
            occurrenceCount: 1,
            latestRiskScore: issue.risk_score ?? null,
            latestPayload: issue as Record<string, unknown>,
            reviewHistory: [],
          });
        }
      }
    },

    /**
     * Fetch a single finding by id (used for company-boundary checks before mutation).
     */
    async getFinding(findingId: string): Promise<QslFinding | null> {
      const row = await db
        .select()
        .from(qslFindings)
        .where(eq(qslFindings.id, findingId))
        .then((rows) => rows[0] ?? null);

      if (!row) return null;
      return {
        ...row,
        latestPayload: (row.latestPayload ?? null) as Record<string, unknown> | null,
        reviewHistory: (row.reviewHistory ?? []) as Array<Record<string, unknown>>,
      };
    },

    /**
     * List all findings for a company, optionally filtered by review state.
     */
    async listFindings(
      companyId: string,
      filter?: { reviewState?: string },
    ): Promise<QslFinding[]> {
      const conditions = [eq(qslFindings.companyId, companyId)];
      if (filter?.reviewState === "active") {
        // Active queue: new + recurring + pending_review
        conditions.push(
          sql`${qslFindings.reviewState} IN ('new', 'recurring', 'pending_review')`,
        );
      } else if (filter?.reviewState) {
        conditions.push(eq(qslFindings.reviewState, filter.reviewState));
      }

      const rows = await db
        .select()
        .from(qslFindings)
        .where(and(...conditions))
        .orderBy(desc(qslFindings.lastSeen));

      return rows.map((r) => ({
        ...r,
        latestPayload: (r.latestPayload ?? null) as Record<string, unknown> | null,
        reviewHistory: (r.reviewHistory ?? []) as Array<Record<string, unknown>>,
      }));
    },

    /**
     * Record a review decision on a finding.
     */
    async reviewFinding(
      findingId: string,
      decision: "approved" | "denied",
      reviewerId: string,
      notes?: string,
    ): Promise<QslFinding> {
      const existing = await db
        .select()
        .from(qslFindings)
        .where(eq(qslFindings.id, findingId))
        .then((rows) => rows[0] ?? null);

      if (!existing) throw new Error("Finding not found");

      const now = new Date();
      const historyEntry = {
        action: decision,
        reviewer_id: reviewerId,
        notes: notes ?? null,
        timestamp: now.toISOString(),
        previous_state: existing.reviewState,
        previous_decision: existing.reviewDecision,
      };

      const currentHistory = (existing.reviewHistory ?? []) as Array<Record<string, unknown>>;

      const newState: string = decision === "approved" ? "approved" : "denied";

      const [updated] = await db
        .update(qslFindings)
        .set({
          reviewState: newState,
          reviewDecision: decision,
          reviewerId,
          reviewedAt: now,
          reviewHistory: [...currentHistory, historyEntry],
          updatedAt: now,
        })
        .where(eq(qslFindings.id, findingId))
        .returning();

      return {
        ...updated,
        latestPayload: (updated.latestPayload ?? null) as Record<string, unknown> | null,
        reviewHistory: (updated.reviewHistory ?? []) as Array<Record<string, unknown>>,
      };
    },

    /**
     * Set a specific review state on a finding (e.g. accepted_risk, escalated).
     */
    async setReviewState(
      findingId: string,
      state: ReviewState,
      reviewerId: string,
      notes?: string,
    ): Promise<QslFinding> {
      const existing = await db
        .select()
        .from(qslFindings)
        .where(eq(qslFindings.id, findingId))
        .then((rows) => rows[0] ?? null);

      if (!existing) throw new Error("Finding not found");

      const now = new Date();
      const historyEntry = {
        action: `state_change:${state}`,
        reviewer_id: reviewerId,
        notes: notes ?? null,
        timestamp: now.toISOString(),
        previous_state: existing.reviewState,
      };

      const currentHistory = (existing.reviewHistory ?? []) as Array<Record<string, unknown>>;

      const [updated] = await db
        .update(qslFindings)
        .set({
          reviewState: state,
          reviewerId,
          reviewedAt: now,
          reviewHistory: [...currentHistory, historyEntry],
          updatedAt: now,
        })
        .where(eq(qslFindings.id, findingId))
        .returning();

      return {
        ...updated,
        latestPayload: (updated.latestPayload ?? null) as Record<string, unknown> | null,
        reviewHistory: (updated.reviewHistory ?? []) as Array<Record<string, unknown>>,
      };
    },
  };
}
