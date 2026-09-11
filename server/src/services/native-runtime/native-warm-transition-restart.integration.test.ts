import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { describe, expect, it, vi } from "vitest";
import { nativeSha256 } from "./canonical.js";
import {
  nativeToolContractFingerprintForTarget,
  rebindNativeSessionCheckpoint,
} from "./native-session-resume.js";
import {
  claimNativeRestartRecoveries,
  currentNativeControllerIdentity,
  type NativeRestartRecoveryClaim,
} from "./native-restart-recovery.js";

// These are captured from the actual private runner in the package's fresh
// controller/runner loss-window test, not hand-authored protocol receipts.
// Generate with PAPERCLIP_ATTACH_TRANSITION_FIXTURE_DIRECTORY, then explicitly
// supply that directory and a fresh migrated PAPERCLIP_TEST_DATABASE_URL here.
// The post-admission backend is mocked: this qualifies classifier→server route
// admission, not a second provider execution or end-to-end restart.
const fixtureDirectory =
  process.env.PAPERCLIP_WARM_TRANSITION_FIXTURE_DIRECTORY;
const managedFixtureDirectory =
  process.env.PAPERCLIP_WARM_TRANSITION_MANAGED_FIXTURE_DIRECTORY;
const databaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const generated =
  fixtureDirectory && databaseUrl ? describe.sequential : describe.skip;

type Identity = {
  runnerInstanceId: string;
  environmentLeaseId: string;
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
};
type Fixture = {
  schema: string;
  oldIdentity: Identity;
  newIdentity: Identity;
  runner: {
    pid: number;
    processGroupId: number;
    startedAt: string;
    processAbsent: boolean;
    groupAbsent: boolean;
  };
  providers: Array<{
    pid: number;
    processGroupId: number;
    startedAt: string;
    processAbsent: boolean;
    groupAbsent: boolean;
  }>;
  artifact: { path: string; version: string; digest: string };
  thread: { id: string; sessionId: string };
  firstEvidence: Record<string, unknown>;
};
type TransportOptions = {
  prpIdentity: Identity;
  warmTransitionRegistrationMode?: string;
  authorizeWarmTransitionRecovery?: (
    stage: "before_bootstrap" | "before_spawn" | "before_authentication",
  ) => Promise<void>;
  onWarmTransitionRecoveryCompleted?: (input: { transitionId: string }) => void;
  controlPlaneRegistration: (
    authority: unknown,
    identity: Identity,
  ) => Promise<unknown>;
};
const seam = vi.hoisted(() => ({
  backend: vi.fn(
    (_input: unknown, _options: { codexTransportFactory: () => unknown }) => ({
      kind: "test",
    }),
  ),
  transport: vi.fn((_options: TransportOptions) => ({ transport: {} })),
  register: vi.fn(
    (_input: { companyId: string; runId: string; authority: unknown }) => ({
      connection: {
        mode: "connect",
        connectUrl: "ws://127.0.0.1/test-owned-route",
      },
      release() {},
    }),
  ),
}));
vi.mock("../../vendor/paperclip-runner/index.js", async (original) => ({
  ...(await original<
    typeof import("../../vendor/paperclip-runner/index.js")
  >()),
  createNativeSessionBackend: seam.backend,
  createRunnerdCodexTransport: seam.transport,
}));
vi.mock("../../realtime/runner-prp-ws.js", () => ({
  registerRunnerPrpAuthority: seam.register,
}));
vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    definitions() {
      return Promise.resolve([]);
    }
  },
}));
vi.mock("./current-wake-comments.js", () => ({
  resolveCurrentWakeCommentsBinding: async () => null,
  assertCurrentWakeCommentsRead: async () => undefined,
}));
import { createRunnerdBackend } from "./native-session-executor.js";
import { readRunnerdArtifactBinding } from "../../vendor/paperclip-runner/index.js";

function executionFor(
  fixture: Fixture,
  companyId: string,
  agentId: string,
  issueId: string,
  current: boolean,
): NativeExecutionInputV1 {
  const identity = current ? fixture.newIdentity : fixture.oldIdentity;
  const transient =
    fixture.oldIdentity.environmentLeaseId === fixture.oldIdentity.runId;
  return {
    schema: "paperclip.native-execution-input.v1",
    provider: { kind: "codex", model: null },
    binding: {
      companyId,
      agentId,
      issueId,
      runId: identity.runId,
      executionWorkspaceId: transient
        ? identity.runId
        : fixture.oldIdentity.environmentLeaseId,
    },
    task: {
      identifier: "WARM-1",
      title: "Retain exact handoff",
      description: null,
      prompt: "Retain exact handoff",
      workMode: "standard",
    },
    workspace: {
      cwd: tmpdir(),
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId: identity.normalizedSessionId,
      driverKind: "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    },
    completionContract: {
      id: randomUUID(),
      sha256: "fixture",
      schemaVersion: "paperclip.completion-contract.v1",
      contract: {
        revision: "1",
        objective: "Retain exact handoff",
        criteria: [{ id: "objective", requirement: "Retain it" }],
      },
    },
    interactionResponses: [],
    credentialBindings: [],
  };
}

async function bytesIn(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("generated fixture must not contain symlinks");
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory())
        await walk(join(path, entry.name), `${relative}/`);
      else
        files[relative] = createHash("sha256")
          .update(await readFile(join(path, entry.name)))
          .digest("hex");
    }
  }
  await walk(root, "");
  return files;
}

const cases = [
  ["before-result-routed", "valid"],
  ["after-result-routed", "valid"],
  ["after-activation-routed", "valid"],
  ["before-confirmation-routed", "valid"],
  ["after-confirmation-routed", "valid"],
  ["before-result-routed", "no_claim"],
  ["before-result-routed", "wrong_scope"],
  ["before-result-routed", "wrong_actor"],
  ["before-result-routed", "wrong_runner"],
  ["before-result-routed", "expired_controller"],
  ["before-result-routed", "wrong_generation"],
  ["before-result-routed", "wrong_checkpoint"],
  ["before-result-routed", "missing_process"],
  ["before-result-routed", "live_provider"],
  ["before-result-routed", "expired_participant"],
  ["before-result-routed", "revoked_participant"],
  ["before-result-routed", "changed_receipt"],
  ["before-result-routed", "changed_before_registration"],
  ["before-result-routed", "claim_changed_before_registration"],
  ["before-result-routed", "bootstrap_claim"],
  ["before-result-routed", "surviving_claim"],
  ["before-result-routed", "claim_changed_before_spawn"],
  ["before-result-routed", "claim_changed_before_authentication"],
  ["before-result-routed", "missing_origin"],
  ["before-result-routed", "nonterminal_origin"],
  ["before-result-routed", "unsettled_archive"],
  ["before-result-routed", "uncommitted_cleanup"],
  ["before-result-routed", "wrong_artifact"],
  ["before-result-routed", "claim_expires_while_locked"],
  ["before-result-routed", "unsettled_archive_before_spawn"],
  ["before-result-routed", "uncommitted_cleanup_before_spawn"],
  ["before-result-routed", "claim_changed_before_bootstrap"],
  ["before-result-routed", "completion_proven"],
  ["before-result-routed", "completion_wrong_id"],
  ["before-result-routed", "completion_missing_id"],
  ...(managedFixtureDirectory
    ? [["managed-before-result-routed", "valid"] as const]
    : []),
] as const;

generated(
  "generated warm transition → real restart classifier → guarded server admission",
  () => {
    it.each(cases)("%s / %s", async (fixtureName, fault) => {
      const fixtureRoot =
        fixtureName === "managed-before-result-routed"
          ? join(managedFixtureDirectory!, "before-result-routed")
          : join(fixtureDirectory!, fixtureName);
      const fixture = JSON.parse(
        await readFile(
          join(fixtureRoot, "transition-fixture-metadata.json"),
          "utf8",
        ),
      ) as Fixture;
      expect(fixture.schema).toBe("paperclip.test.warm-transition-fixture.v1");
      // A later rebuild at the same path must fail here, never rewrite the receipt.
      expect(readRunnerdArtifactBinding(fixture.artifact.path)).toEqual({
        version: fixture.artifact.version,
        digest: fixture.artifact.digest,
      });
      expect(fixture.runner.processAbsent && fixture.runner.groupAbsent).toBe(
        true,
      );
      expect(
        fixture.providers.every(
          (owner) => owner.processAbsent && owner.groupAbsent,
        ),
      ).toBe(true);
      const directory = await mkdtemp(join(tmpdir(), "native-warm-admission-"));
      const oldEnvironment = {
        state: process.env.PAPERCLIP_RUNNER_STATE_DIR,
        binary: process.env.PAPERCLIP_RUNNER_BINARY,
      };
      const db = createDb(databaseUrl!);
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      let companyCreated = false;
      let primaryError: unknown;
      let releaseLock: (() => void) | undefined;
      let lockHolder: Promise<void> | undefined;
      try {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = directory;
        process.env.PAPERCLIP_RUNNER_BINARY = fixture.artifact.path;
        const priorExecution = executionFor(
          fixture,
          companyId,
          agentId,
          issueId,
          false,
        );
        const currentExecution = executionFor(
          fixture,
          companyId,
          agentId,
          issueId,
          true,
        );
        const transient =
          fixture.oldIdentity.environmentLeaseId === fixture.oldIdentity.runId;
        const stateKey = nativeSha256({
          schema: "paperclip.native-session-scope.v2",
          companyId,
          agentId,
          workspace: transient
            ? { kind: "transient", ...currentExecution.workspace }
            : {
                kind: "managed",
                executionWorkspaceId:
                  currentExecution.binding.executionWorkspaceId,
              },
          provider: {
            driverKind: "codex_app_server",
            identity: { kind: "codex" },
          },
          normalizedSessionId: fixture.newIdentity.normalizedSessionId,
        });
        const root = join(directory, stateKey);
        await cp(fixtureRoot, root, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        const runnerPath = join(root, "runner", "runner-state.json");
        const corePath = join(
          root,
          "control-plane",
          "control-plane-state.json",
        );
        await db.insert(companies).values({
          id: companyId,
          name: "Generated warm admission",
          issuePrefix: "WARM",
          requireBoardApprovalForNewAgents: false,
        });
        companyCreated = true;
        await db.insert(agents).values({
          id: agentId,
          companyId,
          name: "Fixture owner",
          role: "engineer",
          status: "active",
          adapterType: "paperclip_runner",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        });
        await db.insert(issues).values({
          id: issueId,
          companyId,
          identifier: "WARM-1",
          title: "Generated handoff",
          status: "in_progress",
          priority: "medium",
          workMode: "standard",
          assigneeAgentId: agentId,
        });
        // Only the standard heartbeat-owned identity/process wrapper is added;
        // provider thread/account and process facts came from the real producer.
        const oldProfile = {
          nativeExecutionInput: priorExecution,
          nativeToolContractFingerprint:
            nativeToolContractFingerprintForTarget("local"),
          sessionCheckpoint: {
            backendKind: "harness",
            driverKind: "codex_app_server",
            sessionId: fixture.thread.id,
            providerSessionId: fixture.thread.sessionId,
            identity: {
              companyId,
              agentId,
              issueId,
              runId: fixture.oldIdentity.runId,
              sessionId: fixture.oldIdentity.normalizedSessionId,
            },
            process: fixture.firstEvidence,
          },
        };
        const previous = {
          id: fixture.oldIdentity.runId,
          companyId,
          agentId,
          nativeSessionId: fixture.oldIdentity.normalizedSessionId,
          runnerProfileJson: oldProfile,
        };
        const rebound = rebindNativeSessionCheckpoint({
          previousRun: previous,
          currentExecution,
        });
        expect(rebound).not.toBeNull();
        expect(rebound?.sessionId).toBe(fixture.thread.id);
        expect(rebound?.providerSessionId).toBe(fixture.thread.sessionId);
        const currentProfile = {
          nativeExecutionInput: currentExecution,
          nativeToolContractFingerprint:
            nativeToolContractFingerprintForTarget("local"),
          sessionCheckpoint: rebound,
        };
        const common = {
          companyId,
          agentId,
          runtimeMode: "native",
          nativeIssueId: issueId,
          runnerInstanceId: fixture.oldIdentity.runnerInstanceId,
          nativeSessionId: fixture.oldIdentity.normalizedSessionId,
          processPid: fixture.runner.pid,
          processGroupId: fixture.runner.processGroupId,
          processStartedAt: new Date(fixture.runner.startedAt),
        };
        await db.insert(heartbeatRuns).values([
          {
            ...common,
            id: fixture.oldIdentity.runId,
            status: "succeeded",
            finishedAt: new Date(),
            runnerProfileJson: oldProfile,
          },
          {
            ...common,
            id: fixture.newIdentity.runId,
            status: "running",
            runnerProfileJson: currentProfile,
          },
        ]);
        await db
          .update(issues)
          .set({ executionRunId: fixture.newIdentity.runId })
          .where(eq(issues.id, issueId));
        await db.insert(nativeRunFinalizations).values({
          runId: fixture.newIdentity.runId,
          companyId,
          issueId,
          phase: "observed",
        });
        if (fault === "live_provider") {
          const checkpoint = structuredClone(currentProfile);
          const liveOwner = await currentNativeControllerIdentity();
          Object.assign(
            (
              checkpoint.sessionCheckpoint as unknown as {
                process: Record<string, unknown>;
              }
            ).process,
            {
              providerPid: process.pid,
              codexPid: process.pid,
              providerProcessStartedAt:
                liveOwner.processStartedAt.toISOString(),
              codexProcessStartedAt: liveOwner.processStartedAt.toISOString(),
            },
          );
          await db
            .update(heartbeatRuns)
            .set({ runnerProfileJson: checkpoint })
            .where(eq(heartbeatRuns.id, fixture.newIdentity.runId));
        }
        const dispositions = await claimNativeRestartRecoveries({
          db,
          runIds: [fixture.newIdentity.runId],
          restartKind: "hard",
        });
        let claim = dispositions[0] as NativeRestartRecoveryClaim;
        if (fault === "live_provider") expect(claim.kind).toBe("blocked");
        else expect(claim.kind).toBe("resume_dead_runner");
        if (fault === "wrong_scope" || fault === "wrong_actor") {
          const changed = structuredClone(oldProfile);
          if (fault === "wrong_scope")
            changed.nativeExecutionInput.workspace.cwd = "/foreign-workspace";
          else changed.nativeExecutionInput.binding.agentId = randomUUID();
          await db
            .update(heartbeatRuns)
            .set({ runnerProfileJson: changed })
            .where(eq(heartbeatRuns.id, fixture.oldIdentity.runId));
        }
        if (fault === "wrong_runner")
          await db
            .update(heartbeatRuns)
            .set({ runnerInstanceId: randomUUID() })
            .where(eq(heartbeatRuns.id, fixture.newIdentity.runId));
        if (fault === "missing_origin")
          await db
            .delete(heartbeatRuns)
            .where(eq(heartbeatRuns.id, fixture.oldIdentity.runId));
        if (fault === "nonterminal_origin")
          await db
            .update(heartbeatRuns)
            .set({ status: "running", finishedAt: null })
            .where(eq(heartbeatRuns.id, fixture.oldIdentity.runId));
        if (fault === "unsettled_archive")
          await db.insert(nativeRunFinalizations).values({
            runId: fixture.oldIdentity.runId,
            companyId,
            issueId,
            phase: "committed",
            recoveryHistory: [
              {
                kind: "native_cleanup_source_archive",
                phase: "prepared",
                version: 1,
                requestId: `native-cleanup:${randomUUID()}`,
                sourceFingerprint: "a".repeat(64),
                stateKey,
              },
            ],
          });
        if (fault === "uncommitted_cleanup")
          await writeFile(
            join(root, "cleanup-activation.json"),
            JSON.stringify({
              schema: "paperclip.native_cleanup_activation.v1",
              companyId,
              issueId,
              runId: fixture.oldIdentity.runId,
              requestId: `native-cleanup:${randomUUID()}`,
            }),
          );
        if (fault === "expired_controller")
          await db
            .update(nativeRunFinalizations)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(nativeRunFinalizations.runId, fixture.newIdentity.runId));
        if (fault === "wrong_generation")
          claim = {
            ...claim,
            controllerGeneration: claim.controllerGeneration + 1,
          };
        if (fault === "wrong_checkpoint" || fault === "missing_process") {
          const profile = structuredClone(currentProfile);
          if (fault === "wrong_checkpoint")
            profile.sessionCheckpoint!.identity.runId =
              fixture.oldIdentity.runId;
          else
            delete (
              profile.sessionCheckpoint as unknown as Record<string, unknown>
            ).process;
          await db
            .update(heartbeatRuns)
            .set({ runnerProfileJson: profile })
            .where(eq(heartbeatRuns.id, fixture.newIdentity.runId));
        }
        if (fault === "expired_participant") {
          const runner = JSON.parse(await readFile(runnerPath, "utf8"));
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(
            runner.warmTransition.receipt.leaseExpiresAtUnixMs + 1,
          );
          await db
            .update(nativeRunFinalizations)
            .set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
            .where(eq(nativeRunFinalizations.runId, fixture.newIdentity.runId));
        }
        if (fault === "revoked_participant") {
          const core = JSON.parse(await readFile(corePath, "utf8"));
          for (const lease of Object.values(core.leases) as Array<
            Record<string, unknown>
          >) {
            lease.revokedAt = new Date().toISOString();
          }
          await writeFile(corePath, JSON.stringify(core));
        }
        if (fault === "changed_receipt") {
          const runner = JSON.parse(await readFile(runnerPath, "utf8"));
          runner.warmTransition.receipt.resultDigest = "0".repeat(64);
          await writeFile(runnerPath, JSON.stringify(runner));
        }
        if (fault === "wrong_artifact") {
          const alternative = join(root, "different-selected-runner");
          await writeFile(
            alternative,
            Buffer.concat([
              await readFile(fixture.artifact.path),
              Buffer.from("different-artifact"),
            ]),
          );
          await chmod(alternative, 0o700);
          process.env.PAPERCLIP_RUNNER_BINARY = alternative;
        }
        if (fault === "bootstrap_claim")
          claim = { ...claim, kind: "bootstrap_incomplete" };
        if (fault === "surviving_claim")
          claim = {
            ...claim,
            kind: "reattach_existing_runner",
            process: {
              pid: fixture.runner.pid,
              processGroupId: fixture.runner.processGroupId,
              startedAt: fixture.runner.startedAt,
            },
          };
        let before = await bytesIn(root);
        seam.backend.mockClear();
        seam.transport.mockClear();
        seam.register.mockClear();
        const registerFault =
          fault === "changed_before_registration" ||
          fault === "claim_changed_before_registration";
        const lateFault =
          fault === "claim_changed_before_spawn" ||
          fault === "claim_changed_before_authentication" ||
          fault === "claim_changed_before_bootstrap" ||
          fault === "unsettled_archive_before_spawn" ||
          fault === "uncommitted_cleanup_before_spawn";
        const completionCase =
          fault === "completion_proven" ||
          fault === "completion_wrong_id" ||
          fault === "completion_missing_id";
        const admitted =
          fault === "valid" || registerFault || lateFault || completionCase;
        if (fault === "claim_expires_while_locked") {
          await db
            .update(nativeRunFinalizations)
            .set({ leaseExpiresAt: new Date(Date.now() + 500) })
            .where(eq(nativeRunFinalizations.runId, fixture.newIdentity.runId));
          let acquired!: () => void;
          const locked = new Promise<void>((resolveLock) => {
            acquired = resolveLock;
          });
          const release = new Promise<void>((resolveRelease) => {
            releaseLock = resolveRelease;
          });
          lockHolder = db.transaction(async (tx) => {
            await tx
              .select()
              .from(nativeRunFinalizations)
              .where(
                eq(nativeRunFinalizations.runId, fixture.newIdentity.runId),
              )
              .for("update");
            acquired();
            await release;
          });
          await locked;
        }
        const construction = createRunnerdBackend({
          db,
          execution: currentExecution,
          runnerInstanceId: fixture.newIdentity.runnerInstanceId,
          restartRecovery:
            fault === "no_claim" || fault === "live_provider"
              ? undefined
              : claim,
        });
        void construction.catch(() => undefined);
        if (lockHolder) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 650));
          releaseLock!();
          await lockHolder;
        }
        if (!admitted) {
          await expect(construction).rejects.toThrow(
            fault === "unsettled_archive" || fault === "uncommitted_cleanup"
              ? /native_session_cleanup_quarantined/
              : "native_runner_warm_transition_recovery_unproven",
          );
          expect(seam.backend).not.toHaveBeenCalled();
          expect(seam.transport).not.toHaveBeenCalled();
        } else {
          await construction;
          expect(seam.backend).toHaveBeenCalledOnce();
          seam.backend.mock.calls[0]![1].codexTransportFactory();
          const options = seam.transport.mock.calls[0]![0];
          expect(options.prpIdentity).toEqual(fixture.newIdentity);
          expect(options.warmTransitionRegistrationMode).toBe("routed_connect");
          if (fault === "changed_before_registration") {
            await writeFile(
              runnerPath,
              `${await readFile(runnerPath, "utf8")}\n`,
            );
            before = await bytesIn(root);
          }
          if (fault === "claim_changed_before_registration")
            await db
              .update(nativeRunFinalizations)
              .set({ leaseOwner: "different-owner" })
              .where(
                eq(nativeRunFinalizations.runId, fixture.newIdentity.runId),
              );
          const registration = options.controlPlaneRegistration(
            {},
            fixture.oldIdentity,
          );
          if (registerFault)
            await expect(registration).rejects.toThrow(
              "native_runner_warm_transition_recovery_unproven",
            );
          else {
            await registration;
            await options.controlPlaneRegistration({}, fixture.newIdentity);
            expect(
              seam.register.mock.calls.map(([input]) => ({
                companyId: input.companyId,
                runId: input.runId,
              })),
            ).toEqual([
              { companyId, runId: fixture.oldIdentity.runId },
              { companyId, runId: fixture.newIdentity.runId },
            ]);
            if (fault !== "claim_changed_before_bootstrap")
              await options.authorizeWarmTransitionRecovery!(
                "before_bootstrap",
              );
            if (lateFault) {
              const cleanupFault =
                fault === "unsettled_archive_before_spawn" ||
                fault === "uncommitted_cleanup_before_spawn";
              if (fault === "unsettled_archive_before_spawn")
                await db.insert(nativeRunFinalizations).values({
                  runId: fixture.oldIdentity.runId,
                  companyId,
                  issueId,
                  phase: "committed",
                  recoveryHistory: [
                    {
                      kind: "native_cleanup_source_archive",
                      phase: "prepared",
                      version: 1,
                      requestId: `native-cleanup:${randomUUID()}`,
                      sourceFingerprint: "a".repeat(64),
                      stateKey,
                    },
                  ],
                });
              else if (fault === "uncommitted_cleanup_before_spawn") {
                await writeFile(
                  join(root, "cleanup-activation.json"),
                  JSON.stringify({
                    schema: "paperclip.native_cleanup_activation.v1",
                    companyId,
                    issueId,
                    runId: fixture.oldIdentity.runId,
                    requestId: `native-cleanup:${randomUUID()}`,
                  }),
                );
                before = await bytesIn(root);
              } else
                await db
                  .update(nativeRunFinalizations)
                  .set({ leaseOwner: "revoked-during-materialization" })
                  .where(
                    eq(nativeRunFinalizations.runId, fixture.newIdentity.runId),
                  );
              await expect(
                options.authorizeWarmTransitionRecovery!(
                  fault === "claim_changed_before_bootstrap"
                    ? "before_bootstrap"
                    : fault === "claim_changed_before_authentication"
                      ? "before_authentication"
                      : "before_spawn",
                ),
              ).rejects.toThrow(
                cleanupFault
                  ? /native_session_cleanup_quarantined/
                  : "native_runner_warm_transition_recovery_unproven",
              );
            } else {
              await options.authorizeWarmTransitionRecovery!("before_spawn");
              await options.authorizeWarmTransitionRecovery!(
                "before_authentication",
              );
            }
            if (completionCase) {
              const runner = JSON.parse(await readFile(runnerPath, "utf8"));
              const transitionId = runner.warmTransition.receipt.transitionId;
              if (fault === "completion_proven") {
                options.onWarmTransitionRecoveryCompleted!({ transitionId });
              } else {
                expect(() =>
                  options.onWarmTransitionRecoveryCompleted!(
                    fault === "completion_wrong_id"
                      ? { transitionId: randomUUID() }
                      : ({} as { transitionId: string }),
                  ),
                ).toThrow("native_runner_warm_transition_recovery_unproven");
              }
              await db
                .update(nativeRunFinalizations)
                .set({ leaseOwner: "old-recovery-claim-ended" })
                .where(
                  eq(nativeRunFinalizations.runId, fixture.newIdentity.runId),
                );
              const subsequent = options.controlPlaneRegistration(
                {},
                { ...fixture.newIdentity, runId: randomUUID() },
              );
              if (fault === "completion_proven") {
                await subsequent;
                expect(seam.register).toHaveBeenCalledTimes(3);
              } else {
                await expect(subsequent).rejects.toThrow(
                  "native_runner_warm_transition_recovery_unproven",
                );
                expect(seam.register).toHaveBeenCalledTimes(2);
              }
            }
          }
        }
        expect(await bytesIn(root)).toEqual(before);
        if (fault !== "valid" && !lateFault && !completionCase)
          expect(seam.register).not.toHaveBeenCalled();
        expect((await readdir(directory)).sort()).toEqual([stateKey]);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        vi.useRealTimers();
        releaseLock?.();
        await lockHolder;
        try {
          if (companyCreated) {
            await db
              .update(issues)
              .set({ executionRunId: null })
              .where(
                and(eq(issues.id, issueId), eq(issues.companyId, companyId)),
              );
            await db
              .delete(nativeRunFinalizations)
              .where(eq(nativeRunFinalizations.companyId, companyId));
            await db
              .delete(heartbeatRuns)
              .where(eq(heartbeatRuns.companyId, companyId));
            await db.delete(issues).where(eq(issues.companyId, companyId));
            await db.delete(agents).where(eq(agents.companyId, companyId));
            await db.delete(companies).where(eq(companies.id, companyId));
          }
        } catch (cleanupError) {
          throw primaryError
            ? new AggregateError(
                [primaryError, cleanupError],
                "Fixture assertion and cleanup failed",
              )
            : cleanupError;
        } finally {
          await db.$client.end({ timeout: 1 });
          if (oldEnvironment.state === undefined)
            delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
          else process.env.PAPERCLIP_RUNNER_STATE_DIR = oldEnvironment.state;
          if (oldEnvironment.binary === undefined)
            delete process.env.PAPERCLIP_RUNNER_BINARY;
          else process.env.PAPERCLIP_RUNNER_BINARY = oldEnvironment.binary;
          await rm(directory, { recursive: true, force: true });
        }
      }
    });
  },
);
