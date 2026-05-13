import { z } from "zod";
import {
  ISSUE_RUNS_EXECUTORS,
  ISSUE_RUNS_RECOVERY_TRIGGERS,
  ISSUE_RUNS_STATUSES,
} from "../constants.js";

/**
 * issue_runs lock-contract validators — Jarvis-OS Phase-4 (Marco-Decision 4D-1, 4D-4=A, 4D-8).
 *
 * Spec-Namen werden auf existing Spalten gemappt:
 *   lock_id    → runId          (uuid)
 *   locked_by  → lockedBy       (text, principal-id)
 *   locked_at  → leasedAt       (timestamp)
 *   expires_at → leaseExpiresAt (timestamp)
 *
 * Per 4D-8 nutzt Hermes die API/Internal-Routes (siehe 4a-3 server/src/routes/issue-runs.ts),
 * nicht Direct-DB-Writes.
 */

const uuidSchema = z.string().uuid();
const positiveTtlSchema = z.number().int().positive().max(86400);

export const acquireIssueRunSchema = z.object({
  companyId: uuidSchema,
  issueId: uuidSchema,
  executor: z.enum(ISSUE_RUNS_EXECUTORS),
  lockedBy: z.string().min(1).max(255),
  ttlSeconds: positiveTtlSchema.optional(),
  promptSnapshotPath: z.string().min(1).max(2048).optional().nullable(),
});
export type AcquireIssueRunInput = z.infer<typeof acquireIssueRunSchema>;

export const heartbeatIssueRunSchema = z.object({
  runId: uuidSchema,
  lockedBy: z.string().min(1).max(255),
  extendBySeconds: positiveTtlSchema.optional(),
});
export type HeartbeatIssueRunInput = z.infer<typeof heartbeatIssueRunSchema>;

export const releaseIssueRunSchema = z.object({
  runId: uuidSchema,
  lockedBy: z.string().min(1).max(255),
  status: z.enum(["completed", "failed"]),
  exitCode: z.number().int().min(-128).max(255).optional().nullable(),
  resultSummary: z.string().max(8192).optional().nullable(),
});
export type ReleaseIssueRunInput = z.infer<typeof releaseIssueRunSchema>;

export const recoverStaleIssueRunsSchema = z.object({
  trigger: z.enum(ISSUE_RUNS_RECOVERY_TRIGGERS).default("manual"),
  limit: z.number().int().min(1).max(1000).default(100),
  dryRun: z.boolean().default(false),
});
export type RecoverStaleIssueRunsInput = z.infer<typeof recoverStaleIssueRunsSchema>;

export const issueRunRecordSchema = z.object({
  runId: uuidSchema,
  companyId: uuidSchema,
  issueId: uuidSchema,
  executor: z.enum(ISSUE_RUNS_EXECUTORS),
  lockedBy: z.string(),
  leasedAt: z.coerce.date(),
  leaseExpiresAt: z.coerce.date(),
  heartbeatAt: z.coerce.date(),
  status: z.enum(ISSUE_RUNS_STATUSES),
  promptSnapshotPath: z.string().nullable(),
  exitCode: z.number().nullable(),
  resultSummary: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type IssueRunRecord = z.infer<typeof issueRunRecordSchema>;

export const recoveredIssueRunSchema = z.object({
  runId: uuidSchema,
  issueId: uuidSchema,
  previousOwner: z.string(),
  recoveredAt: z.coerce.date(),
  trigger: z.enum(ISSUE_RUNS_RECOVERY_TRIGGERS),
});
export type RecoveredIssueRun = z.infer<typeof recoveredIssueRunSchema>;
