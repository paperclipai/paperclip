import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { agentFileRoots, agents, agentTaskSessions, completionContracts, createDb, heartbeatRunEvents,
  heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startMaintenanceServer, withMaintenanceProvider } from "./helpers/maintenance/server-harness.js";
import { createMaintenanceS3Boundary } from "./helpers/maintenance/s3-boundary.js";
import { managedTenantActor, provisionManagedSleepCompany } from "./helpers/maintenance/managed-profile.js";
import { DurablePrpControlPlane, parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { nativeControllerMigrationDescriptor } from "../services/native-runtime/native-session-executor.js";
import { nativeToolContractFingerprintForTarget } from "../services/native-runtime/native-session-resume.js";
import { nativeRunnerCheckpointWriter } from "../services/native-runtime/native-runner-checkpoint.js";
import { PROCESS_START_REQUESTED } from "../services/native-local-process-stop.js";

afterEach(() => vi.unstubAllEnvs());

it("keeps authenticated admission alive when one accepted-result lease cannot settle after restart", async () => {
  const temporary = await startEmbeddedPostgresTestDatabase("startup-accepted-result-isolation-");
  const db = createDb(temporary.connectionString, { maxConnections: 2 });
  const pair = generateKeyPairSync("ed25519"), jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "accepted-result-fixture", alg: "EdDSA", use: "sig" };
  const secrets = { PAPERCLIP_AGENT_JWT_SECRET: randomBytes(32).toString("hex"), PAPERCLIP_DECISION_SIGNING_SECRET: randomBytes(32).toString("hex"),
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomBytes(32).toString("hex"), BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString("hex") };
  for (const [key, value] of Object.entries(secrets)) vi.stubEnv(key, value);
  vi.stubEnv("PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS", "1");
  const s3 = createMaintenanceS3Boundary();
  let first: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined, successor: typeof first;
  let core: DurablePrpControlPlane | undefined;
  const directories: string[] = [];
  const faultName = `accepted_fault_${randomUUID().replaceAll("-", "")}`;
  const fault = sql.raw(faultName), attempts = sql.raw(`${faultName}_attempts`);
  try {
    await withMaintenanceProvider(s3.server, async origin => {
      const options = { ephemeral: true, runtimeSecrets: secrets, controlJwks: JSON.stringify({ keys: [jwk] }),
        cloud: { jwks: JSON.stringify({ keys: [jwk] }), s3Origin: origin, standby: false }, tenantActor: managedTenantActor,
        configuration: { managedInstance: true, deploymentMode: "authenticated" as const, storageProvider: "s3" as const } };
      first = await startMaintenanceServer(temporary.connectionString, options); directories.push(first.directory);
      const company = await provisionManagedSleepCompany(first, db);
      const { identity: controller } = await first.nativeControllerIdentity();
      expect(controller.pid).toBe(first.pid);
      const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
      const contractId = randomUUID(), resultId = randomUUID(), leaseOwner = `execution:${randomUUID()}`;
      await db.insert(agents).values({ id: agentId, companyId: company.id, name: "Accepted retained work", role: "engineer",
        status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
      await db.insert(agentFileRoots).values({ companyId: company.id, agentId, generation: randomUUID(), entries: [] });
      await db.insert(issues).values({ id: issueId, companyId: company.id, title: "Save the accepted result", status: "in_progress", assigneeAgentId: agentId });
      const contract = { revision: "1", objective: "Retain", criteria: [{ id: "retained", requirement: "Retain accepted work." }] };
      await db.insert(completionContracts).values({ id: contractId, companyId: company.id, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture", risk: "standard", completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: contract, canonicalSha256: "a".repeat(64),
        createdByActorType: "system", createdByActorId: "accepted-result-fixture" });
      const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
        binding: { companyId: company.id, agentId, issueId, runId, executionWorkspaceId: randomUUID() },
        task: { identifier: "ACCEPT-1", title: "Save accepted work", description: null, prompt: "Retain.", workMode: "standard" },
        workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        completionContract: { id: contractId, sha256: "a".repeat(64), schemaVersion: "paperclip.completion-contract.v1", contract },
        credentialBindings: [], interactionResponses: [] });
      vi.stubEnv("PAPERCLIP_HOME", first.directory); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "maintenance-test");
      vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(first.directory, "durable-sessions"));
      const fingerprint = nativeToolContractFingerprintForTarget("remote", "codex"), paths = nativeControllerMigrationDescriptor(execution, fingerprint);
      const profile = { nativeExecutionInput: execution, nativeToolContractFingerprint: fingerprint,
        sessionCheckpoint: { backendKind: "mock", sessionId, identity: { companyId: company.id, agentId, issueId, runId, sessionId } } };
      await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId, issueId, nativeIssueId: issueId,
        nativeSessionId: sessionId, runnerInstanceId: runnerId, runtimeMode: "native", nativePhase: "observed", status: "running",
        startedAt: new Date(), invocationSource: "assignment", triggerDetail: "system", runnerProfileJson: profile, completionContractId: contractId });
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId: company.id, issueId, phase: "observed", attempt: 1,
        leaseOwner, leaseExpiresAt: new Date(Date.now() + 3_600_000), controllerBootId: controller.bootId, controllerPid: controller.pid,
        controllerHostHash: controller.hostHash, controllerProcessStartedAt: new Date(controller.processStartedAt), controllerGeneration: 1 });
      await db.insert(agentTaskSessions).values({ companyId: company.id, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId });
      core = new DurablePrpControlPlane({ stateDirectory: join(paths.root, "control-plane"),
        identity: { runId, runnerInstanceId: runnerId, normalizedSessionId: sessionId, environmentLeaseId: execution.binding.executionWorkspaceId,
          turnId: randomUUID(), itemId: randomUUID() }, expectedRunnerVersion: "accepted-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, { companyId: company.id, issueId, runId, authorityRunId: runId,
        bootId: controller.bootId, generation: 1, leaseOwner }));
      core.issueBootstrapTicket(); await core.flushCheckpoint(); await core.stop(); core = undefined;
      const file = join(paths.root, "control-plane", "control-plane-state.json"), bytes = await readFile(file, "utf8");
      const [accepted] = await db.insert(nativeRunResults).values({ id: resultId, companyId: company.id, issueId, runId, completionContractId: contractId,
        serverFingerprint: resultId, schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "succeeded" } }, canonicalSha256: "b".repeat(64) }).returning();
      await db.update(nativeRunFinalizations).set({ resultId, phase: "result_accepted" }).where(eq(nativeRunFinalizations.runId, runId));
      await db.execute(sql`create sequence ${attempts}`);
      await db.execute(sql`create function ${fault}() returns trigger language plpgsql as ${sql.raw(`$$ begin
        if old.run_id='${runId}' and old.result_id='${resultId}' and new.lease_expires_at < old.lease_expires_at then
          perform nextval('${faultName}_attempts'); raise exception 'injected accepted-result persistence failure';
        end if; return new; end $$`)}`);
      await db.execute(sql`create trigger ${fault} before update on native_run_finalizations for each row execute function ${fault}()`);
      const [before] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      if (!accepted || !before) throw new Error("Accepted-result fixture was not durably created");
      await first.crash();
      successor = await startMaintenanceServer(temporary.connectionString, { ...options, homeDirectory: first.directory }); directories.push(successor.directory);
      const [attempted] = await db.execute<{ is_called: boolean }>(sql`select is_called from ${attempts}`);
      expect(attempted?.is_called).toBe(true);
      const faultAt = successor.output.indexOf("injected accepted-result persistence failure");
      const startupCompleteAt = successor.output.indexOf("Server startup recovery complete");
      expect(faultAt).toBeGreaterThanOrEqual(0);
      expect(startupCompleteAt).toBeGreaterThan(faultAt);
      expect(await successor.api("GET", `/issues/${issueId}`)).toMatchObject({ id: issueId, status: "in_progress" });
      expect(await successor.api("GET", "/liveness")).toMatchObject({ status: "ok" });
      await expect(successor.api("GET", "/ready")).rejects.toThrow("503");
      const admitted = await successor.api<{ id: string }>("POST", `/companies/${company.id}/issues`, { title: "Durable admission during result recovery", status: "todo" });
      expect((await db.select().from(issues).where(eq(issues.id, admitted.id)))[0]).toMatchObject({ companyId: company.id, title: "Durable admission during result recovery" });
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toEqual([accepted]);
      const [after] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(after).toMatchObject({ resultId, phase: "result_accepted", attempt: before.attempt, leaseOwner: before.leaseOwner,
        controllerBootId: before.controllerBootId, controllerGeneration: before.controllerGeneration, leaseExpiresAt: before.leaseExpiresAt });
      expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, issueId))).toEqual([{ id: runId }]);
      expect(await db.select({ type: heartbeatRunEvents.eventType }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)))
        .not.toContainEqual({ type: PROCESS_START_REQUESTED });
      expect(await readFile(file, "utf8")).toBe(bytes);
      await db.execute(sql`drop trigger ${fault} on native_run_finalizations`);
    });
  } finally {
    await core?.stop(); await successor?.stop(); await first?.stop(); await db.$client.end(); await temporary.cleanup();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
