import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { nativeRunFinalizations } from "@paperclipai/db";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { nativeRunnerCheckpointRemoteBootstrapProof, registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { captureClaimTimeRemoteBootstrapProof, claimTimeRemoteBootstrapProofHolds } from "./native-session-executor.js";

describeEmbeddedPostgres("claim-time remote bootstrap proof", () => {
  const environment = nativeRestartFixture();

  it.each([
    { label: "turn-sent", oldCommands: ["run.prepare", "session.open", "turn.start"], holds: false },
    { label: "bootstrap-only", oldCommands: ["run.prepare", "session.open"], holds: true },
  ])("keeps the interrupted controller's proof after the new controller registers: $label", async ({ label, oldCommands, holds }) => {
    const { db, runId, issueId, native } = await environment.seedRun(`CLAIM-PROOF-${label}`);
    const { companyId, successor, runtimeRoot } = environment.current;
    const binding = { companyId, issueId, runId };
    const identity = { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId, runId,
      normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId };
    const controller = (directory: string) => new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, directory), identity,
      expectedRunnerVersion: "fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const own = async (generation: number) => db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerGeneration: generation, leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, runId));
    const execution = { binding, session: { normalizedSessionId: native.normalizedSessionId } } as never;
    const claim = { kind: "bootstrap_incomplete" as const, runId, leaseOwner: "recovered", controllerGeneration: 2,
      providerAttempt: 1, restartKind: "hard" as const, recoveryRequestId: null };
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } as never;
    const interrupted = controller(`${runId}-interrupted`);
    const replacement = controller(`${runId}-replacement`);
    try {
      await own(1);
      for (const type of oldCommands) interrupted.queueCommand(type, {});
      interrupted.store.state.connectionCount = 1;
      await registerNativeRunnerCheckpoint({ db, authority: interrupted, bootId: successor.bootId, binding });
      await interrupted.stop();

      await own(2);
      await captureClaimTimeRemoteBootstrapProof({ db, execution, restartRecovery: claim, runnerExecutionTarget: target });
      expect(claimTimeRemoteBootstrapProofHolds(runId, native.runnerInstanceId)).toBe(holds);

      replacement.queueCommand("run.prepare", {});
      replacement.queueCommand("session.open", { reuse: "same_session" });
      await registerNativeRunnerCheckpoint({ db, authority: replacement, bootId: successor.bootId, binding });

      expect(await nativeRunnerCheckpointRemoteBootstrapProof(db, binding,
        { runnerInstanceId: native.runnerInstanceId, normalizedSessionId: native.normalizedSessionId })).toBe("bootstrap_incomplete");
      expect(claimTimeRemoteBootstrapProofHolds(runId, native.runnerInstanceId)).toBe(holds);
      expect(claimTimeRemoteBootstrapProofHolds(runId, "another-runner")).toBe(false);
    } finally {
      await interrupted.stop();
      await replacement.stop();
    }
  });
});
