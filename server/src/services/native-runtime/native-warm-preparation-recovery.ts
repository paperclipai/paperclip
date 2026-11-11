import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import { DurablePrpControlPlane, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { currentNativeControllerIdentity, type NativeRestartRecoveryClaim } from "./native-restart-recovery.js";
import { nativePreparationClaimNeverLaunched, readNativePreparationHandoffReadiness } from "./native-preparation-handoff.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointRegistration } from "./native-runner-checkpoint.js";
import { readNativeWarmPreparation } from "./native-warm-preparation.js";

export async function restoreNativeWarmPreparationClaim(input: {
  db: Db; execution: NativeExecutionInput; root: string; restartRecovery?: NativeRestartRecoveryClaim;
}) {
  const claim = input.restartRecovery;
  if (claim?.kind !== "bootstrap_incomplete" || input.execution.session.lifecyclePolicy.mode !== "warm"
    || !await nativePreparationClaimNeverLaunched(input.db, { ...input.execution.binding, ...claim })) return false;
  const controller = await currentNativeControllerIdentity();
  const proof = await readNativePreparationHandoffReadiness(input.db, {
    ...input.execution.binding, controllerBootId: controller.bootId });
  if (!proof || !("warmSource" in proof) || !proof.warmSource) return false;
  const source = await readNativeWarmPreparation(input.db, { ...input.execution.binding,
    runnerInstanceId: proof.runnerInstanceId, nativeSessionId: proof.nativeSessionId });
  if (!source) throw new Error("native_runner_warm_preparation_source_unproven");
  const checkpoint = await loadNativeRunnerCheckpoint(input.db, { ...input.execution.binding, runId: source.runId });
  if (!checkpoint) throw new Error("native_runner_warm_preparation_checkpoint_unavailable");
  checkpoint.restoreSessionDirectory(input.root);
  const core = new DurablePrpControlPlane({ stateDirectory: join(input.root, "control-plane"), identity: source.identity,
    authorityRunId: input.execution.binding.runId,
    expectedRunnerVersion: checkpoint.runnerVersion, expectedRunnerDigest: checkpoint.runnerDigest });
  try {
    core.enablePreparationHandoff();
    await core.prepareRunAttachment({ ...source.identity, runId: input.execution.binding.runId,
      turnId: `turn-${input.execution.binding.runId}`, itemId: `item-${input.execution.binding.runId}` });
    await nativeRunnerCheckpointRegistration({ db: input.db, binding: input.execution.binding, bootId: controller.bootId })(core);
  } finally { await core.stop(); }
  return { version: checkpoint.runnerVersion, digest: checkpoint.runnerDigest };
}
