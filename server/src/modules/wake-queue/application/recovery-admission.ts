import type { ExecutionBlocker } from "@paperclipai/shared";
import type { createWakeRecoveryDeferral } from "./recovery-deferral.js";

type ContinuationWait = { reason: string; message: string };
type AdmissionBlocker = Pick<ExecutionBlocker, "recoveryActionId" | "cause" | "nextAction" | "runId">;

type WakeRecoveryReadInput = {
  commentId: string | null;
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
};
type ExplicitContinuationIntent = { commentId: string | null; queuedCommentInterruptId?: string };

export type WakeRecoveryAdmissionStore<ExplicitInput, ExplicitResult> = {
  readBlocker(input: WakeRecoveryReadInput): Promise<{
    blocker: AdmissionBlocker | null;
    verifiedReset: boolean;
  }>;
  admitExplicit(input: ExplicitInput, dryRun: boolean, onBlocked: (reason: string, message: string) => void):
    Promise<ExplicitResult | null>;
};

export function createWakeRecoveryAdmission<ExplicitInput extends ExplicitContinuationIntent, ExplicitResult, Busy, Fresh, Publication>(
  store: WakeRecoveryAdmissionStore<ExplicitInput, ExplicitResult>,
  admitBusy: Busy,
  admitFresh: Fresh,
  defer: ReturnType<typeof createWakeRecoveryDeferral<Publication>>,
) {
  return async function prepareRecovery(
    input: ExplicitInput & WakeRecoveryReadInput & {
      reconciliation?: { sourceRunId: string; actionId: string };
    },
  ) {
    const { blocker, verifiedReset } = await store.readBlocker(input);
    const ownsReconstruction = Boolean(input.reconciliation && blocker &&
      blocker.runId === input.reconciliation.sourceRunId && blocker.recoveryActionId === input.reconciliation.actionId);

    return {
      blocker,
      ownsReconstruction,
      conversationResetCommentId: verifiedReset ? input.commentId : null,
      defer,
      async checkBusyAdmission() {
        let wait: ContinuationWait | undefined;
        const onBlocked = (reason: string, message: string) => { wait = { reason, message }; };
        const blocked = () => Boolean(blocker || (wait && !verifiedReset));
        if ((blocker || input.queuedCommentInterruptId) && !ownsReconstruction &&
          !(await store.admitExplicit(input, true, onBlocked)) && blocked()) {
          return { kind: "blocked" as const, wait };
        }
        return {
          kind: "allowed" as const,
          admitBusy,
          wait,
          async checkFreshAdmission() {
            const explicitContinuation = await store.admitExplicit(input, false, onBlocked);
            if (!explicitContinuation && blocked() && !ownsReconstruction) return { kind: "blocked" as const, wait };
            return { kind: "allowed" as const, explicitContinuation, admitFresh, wait };
          },
        };
      },
    };
  };
}
