import { withdrawInteractionInTransaction } from "./issue-thread-interactions.js";
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
