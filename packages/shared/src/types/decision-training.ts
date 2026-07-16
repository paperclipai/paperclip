export type DecisionTrainingSourceKind = "interaction" | "approval" | "execution_decision";

export interface DecisionTrainingNotesHistoryEntry {
  author: string;
  at: string;
  body: string;
}

export interface DecisionTrainingSnapshotV1 {
  version: 1;
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
    resolution: "exact" | "nearest_run" | "none";
  };
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
  snapshot: DecisionTrainingSnapshotV1;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}
