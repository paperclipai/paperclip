export interface DurableRecoveryIdentity {
  runnerInstanceId: string;
  environmentLeaseId: string;
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
}

/** Private, immutable handoff evidence; never a provider/work authorization. */
export interface DurableWarmRunTransition {
  schema: "paperclip.runner.warm-transition.v1";
  transitionId: string;
  oldIdentity: DurableRecoveryIdentity;
  newIdentity: DurableRecoveryIdentity;
  commandId: string;
  controllerSeq: number;
  commandFingerprint: string;
  resultDigest: string;
  oldAckedSourceSeq: number;
  connection: Record<string, unknown>;
  runnerVersion: string;
  runnerDigest: string;
  leaseId: string;
  leaseExpiresAtUnixMs: number;
  leaseRevocationEpoch: number;
}

export interface DurableRecoveryCoreCommand {
  schema: "paperclip.prp.command.v1" | "paperclip.prp.command.v2";
  commandId: string;
  controllerSeq: number;
  type: string;
  issuedAt: string;
  payload: Record<string, unknown>;
  /**
   * `indeterminate` is the runner's crash-recovery verdict: the command was
   * journaled but its effect was never confirmed, so the runner will not
   * execute it a second time. It is terminal, like the other non-pending
   * statuses.
   */
  status: "pending" | "completed" | "failed" | "rejected" | "indeterminate";
  result: Record<string, unknown> | null;
}

export interface DurableRecoveryCommittedEvent {
  sourceSeq: number;
  sourceEventId: string;
  eventType: string;
  priority: 0 | 1 | 2;
  envelope: Record<string, unknown>;
  deliveryCount: number;
  logicalEffectCount: number;
}
