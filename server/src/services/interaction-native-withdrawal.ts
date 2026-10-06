import type { Db } from "@paperclipai/db";
import { withdrawIssueThreadInteractionSchema } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { withdrawInteractionInTransaction } from "./issue-thread-interactions.js";

/** Dark actual-root-owned composition. Never wrap an existing tx under older
 * locks. Receipt is exposed only after outer commit; provider cancellation,
 * touch and telemetry remain caller-owned. This does not authenticate actors.
 */
export async function withdrawInteractionWithNativeCancellation(
  rootDb: Db,
  issue: Parameters<typeof withdrawInteractionInTransaction>[1],
  interactionId: string,
  input: Parameters<typeof withdrawInteractionInTransaction>[3],
  actor: Parameters<typeof withdrawInteractionInTransaction>[4],
) {
  const capturedIssue = { id: issue.id, companyId: issue.companyId };
  const capturedInput = { reason: input.reason };
  const capturedActor = { agentId: actor.agentId, runId: actor.runId, userId: actor.userId, systemId: actor.systemId };
  if (!capturedIssue.companyId) throw unprocessable("Native withdrawal requires companyId");
  withdrawIssueThreadInteractionSchema.parse(capturedInput);
  const publications: ActivityPublication[] = [];
  const receipt = await rootDb.transaction(tx => withdrawInteractionWithNativeCancellationInTransaction(
    tx, capturedIssue, interactionId, capturedInput, capturedActor,
    { postCommitPublications: publications },
  ));
  for (const publication of publications) publishActivity(publication);
  return receipt;
}
import { requestNativeQuestionRunCancellationInTransaction } from "./native-runtime/native-question-bridge.js";

/** Dark supplied composition, never a production activation or provider stop.
 * Caller must enter from root before any locks, own/discard both the transaction
 * and publication queue on rejection, then act on nativeRunId only after commit.
 * Ordering: company fence -> issue -> actor guard -> card -> linked tools -> run.
 * Do not install this inside an existing afterResolve callback under old locks.
 */
export async function withdrawInteractionWithNativeCancellationInTransaction(
  ...args: Parameters<typeof withdrawInteractionInTransaction>
) {
  // Start canonical withdrawal synchronously: its invocation snapshot and queue
  // preflight precede the first await. Marker identity comes from its locked row,
  // never caller payload or a stale eligibility ID obtained in another tx.
  const tx = args[0];
  const interaction = await withdrawInteractionInTransaction(...args);
  const nativeRunId = interaction.kind === "ask_user_questions"
    ? await requestNativeQuestionRunCancellationInTransaction(tx, interaction, {
      kind: "interaction_withdrawn", interactionId: interaction.id,
    })
    : null;
  return { interaction, nativeRunId };
}
