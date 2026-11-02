export type DecisionTrainingSourceKind = "interaction" | "approval" | "execution_decision";

export const DECISION_TRAINING_RETENTION_POLICY = "scrub_deleted_comments_v1" as const;
export type DecisionTrainingRetentionPolicy = typeof DECISION_TRAINING_RETENTION_POLICY;

export interface DecisionTrainingNotesHistoryEntry {
  author: string;
  at: string;
  body: string;
}

export interface DecisionTrainingSnapshotV1 {
  version: 1;
  retention?: {
    policy: DecisionTrainingRetentionPolicy;
    commentDeletion: "redact";
    issueDeletion: "cascade";
  };
  capturedAt: string;
  cutoff: {
    at: string;
    lastCommentId: string | null;
    commentCount: number;
  };
  issue: Record<string, unknown>;
  comments: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  decision: {
    kind: DecisionTrainingSourceKind;
    payload: Record<string, unknown>;
    actor: Record<string, unknown> | null;
    outcome: string | null;
  };
  code: {
    repoUrl: string | null;
    ref: string | null;
    commitSha: string | null;
    resolution: "exact" | "nearest_run" | "workspace" | "none";
  };
}

/**
 * Read-only preview of the state a new training example would freeze, returned
 * by `POST /companies/:id/decision-training/preview`. Mirrors the capture that
 * `create` performs, minus persistence, so the drawer can show the exact cutoff
 * and captured counts before the user commits.
 */
export interface DecisionTrainingPreview {
  cutoffAt: string;
  decisionOutcome: string | null;
  snapshot: DecisionTrainingSnapshotV1;
}

export interface DecisionTrainingExample {
  id: string;
  companyId: string;
  sourceKind: DecisionTrainingSourceKind;
  sourceId: string;
  issueId: string;
  cutoffAt: string;
  notes: string;
  notesHistory: DecisionTrainingNotesHistoryEntry[];
  decisionOutcome: string | null;
  retentionPolicy: DecisionTrainingRetentionPolicy;
  snapshot: DecisionTrainingSnapshotV1;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}
