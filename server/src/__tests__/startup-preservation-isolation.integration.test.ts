import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { agentFileRoots, agents, agentTaskSessions, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startMaintenanceServer, withMaintenanceProvider } from "./helpers/maintenance/server-harness.js";
import { createMaintenanceS3Boundary } from "./helpers/maintenance/s3-boundary.js";
import { managedTenantActor, provisionManagedSleepCompany } from "./helpers/maintenance/managed-profile.js";
import { DurablePrpControlPlane, captureLegacyDurablePrpCheckpoint, parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { nativeControllerMigrationDescriptor } from "../services/native-runtime/native-session-executor.js";
import { nativeToolContractFingerprintForTarget, findNativeSessionResumeRun } from "../services/native-runtime/native-session-resume.js";
import { insertMigratedNativeRunnerCheckpoint } from "../services/native-runtime/native-runner-checkpoint.js";
import { readLocalNativeControllerObligation } from "../services/native-runtime/native-controller-migration.js";
import { archiveSettledFailedNativeController } from "../services/native-runtime/native-controller-archive-source.js";
import { createStorageService } from "../storage/service.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { CLOUD_CONTROL_AUDIENCE, CLOUD_CONTROL_JWS_TYPE, CLOUD_RUNTIME_IDENTITY_ISSUER } from "../services/cloud-runtime-identity.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["missing", "unavailable"] as const)("keeps authenticated admission alive across restart while a failed controller archive is %s", async fault => {
  const temporary = await startEmbeddedPostgresTestDatabase("startup-preservation-isolation-");
  const db = createDb(temporary.connectionString, { maxConnections: 2 });
  const pair = generateKeyPairSync("ed25519"), jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "preservation-fixture", alg: "EdDSA", use: "sig" };
  const secrets = { PAPERCLIP_AGENT_JWT_SECRET: randomBytes(32).toString("hex"), PAPERCLIP_DECISION_SIGNING_SECRET: randomBytes(32).toString("hex"),
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomBytes(32).toString("hex"), BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString("hex") };
  for (const [key, value] of Object.entries(secrets)) vi.stubEnv(key, value);
  vi.stubEnv("PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS", "1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "maintenance-fixture"); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "maintenance-fixture");
  let rejectArchive: false | "put" | "read" = false;
  const s3 = createMaintenanceS3Boundary({ reject: method => rejectArchive === "put" ? method === "PUT"
    : rejectArchive === "read" && (method === "GET" || method === "HEAD") });
  let first: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined, successor: typeof first;
  const directories: string[] = [];
  try {
    await withMaintenanceProvider(s3.server, async origin => {
      const options = { ephemeral: true, runtimeSecrets: secrets, controlJwks: JSON.stringify({ keys: [jwk] }),
        cloud: { jwks: JSON.stringify({ keys: [jwk] }), s3Origin: origin, standby: false }, tenantActor: managedTenantActor,
        configuration: { managedInstance: true, deploymentMode: "authenticated" as const, storageProvider: "s3" as const } };
      first = await startMaintenanceServer(temporary.connectionString, options); directories.push(first.directory);
      const company = await provisionManagedSleepCompany(first, db);
      const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId: company.id, name: "Retained failed preparation", role: "engineer",
        status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
      await db.insert(agentFileRoots).values({ companyId: company.id, agentId, generation: randomUUID(), entries: [] });
      await db.insert(issues).values({ id: issueId, companyId: company.id, title: "Retain original failed work", status: "blocked", assigneeAgentId: agentId });
      const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
        binding: { companyId: company.id, agentId, issueId, runId, executionWorkspaceId: randomUUID() },
        task: { identifier: "PRESERVE-1", title: "Retain original failed work", description: null, prompt: "Retain.", workMode: "standard" },
        workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        completionContract: { id: randomUUID(), sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
          contract: { revision: "1", objective: "Retain", criteria: [{ id: "retained", requirement: "Retain." }] } }, credentialBindings: [], interactionResponses: [] });
      vi.stubEnv("PAPERCLIP_HOME", first.directory); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "maintenance-test");
      vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(first.directory, "durable-sessions"));
      const fingerprint = nativeToolContractFingerprintForTarget("remote", "codex"), paths = nativeControllerMigrationDescriptor(execution, fingerprint);
      expect(paths.root.startsWith(join(first.directory, "durable-sessions"))).toBe(true);
      const identity = { runId, runnerInstanceId: runnerId, normalizedSessionId: sessionId, environmentLeaseId: execution.binding.executionWorkspaceId,
        turnId: randomUUID(), itemId: randomUUID() };
      const core = new DurablePrpControlPlane({ stateDirectory: join(paths.root, "control-plane"), identity,
        expectedRunnerVersion: "retained-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      core.queueCommand("session.snapshot", {}); await core.stop();
      const file = join(paths.root, "control-plane", "control-plane-state.json"), bytes = await readFile(file, "utf8");
      const profile = { nativeExecutionInput: execution, nativeToolContractFingerprint: fingerprint,
        sessionCheckpoint: { backendKind: "mock", sessionId, identity: { companyId: company.id, agentId, issueId, runId, sessionId } } };
      await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId, issueId, nativeIssueId: issueId,
        nativeSessionId: sessionId, runnerInstanceId: runnerId, runtimeMode: "native", status: "failed", finishedAt: new Date(),
        invocationSource: "assignment", triggerDetail: "system", runnerProfileJson: profile, errorCode: "original_preparation_failure" });
      await db.insert(nativeRunFinalizations).values({ runId, companyId: company.id, issueId, phase: "terminal_failure", failureCode: "original_preparation_failure" });
      const [selection] = await db.insert(agentTaskSessions).values({ companyId: company.id, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId }).returning();
      const scope = { companyId: company.id, issueId, runId };
      await db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, scope, captureLegacyDurablePrpCheckpoint(bytes,
        { runId, runnerInstanceId: runnerId, normalizedSessionId: sessionId }, { version: "retained-fixture", digest: `sha256:${"a".repeat(64)}` })));
      const storage = createStorageService(createS3StorageProvider({ bucket: "maintenance-test", region: "us-east-1", endpoint: origin, forcePathStyle: true }));
      const archive = async () => {
        const source = await findNativeSessionResumeRun(db, { companyId: company.id, agentId, issueId, normalizedSessionId: sessionId, beforeCreatedAt: selection.createdAt, includeProgressBarrier: true });
        return archiveSettledFailedNativeController(db, { selected: { ...selection, companyId: company.id, agentId, issueId, sessionId, lastRunId: runId },
          source: source!, storage, signal: AbortSignal.timeout(15_000) });
      };
      if (fault === "unavailable") await archive();
      rejectArchive = fault === "missing" ? "put" : "read";
      await expect(archive()).rejects.toThrow();
      expect(s3.snapshot().requests.some(request => request.status === 503)).toBe(true);
      expect(await readLocalNativeControllerObligation(db, storage)).toEqual({ ...scope,
        code: "native_controllers_require_migration", reason: fault === "missing" ? "local_controller" : "archive_unavailable" });
      await first.stop();
      successor = await startMaintenanceServer(temporary.connectionString, { ...options, homeDirectory: first.directory }); directories.push(successor.directory);
      expect(await successor.api("GET", `/issues/${issueId}`)).toMatchObject({ id: issueId, status: "blocked" });
      expect(await successor.api("GET", "/liveness")).toMatchObject({ status: "ok" });
      await expect(successor.api("GET", "/ready")).rejects.toThrow("503");
      expect((await successor.idleLocalWork()).observations).toContainEqual({ label: "local.registered_probes", state: "present" });
      const admitted = await successor.api<{ id: string }>("POST", `/companies/${company.id}/issues`,
        { title: "Independent durable admission", status: "todo" });
      expect((await db.select().from(issues).where(eq(issues.id, admitted.id)))[0]).toMatchObject({ companyId: company.id, title: "Independent durable admission" });
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url"), iat = Math.floor(Date.now() / 1000);
      const assertion = `${encode({ alg: "EdDSA", typ: CLOUD_CONTROL_JWS_TYPE, kid: jwk.kid })}.${encode({ v: 1,
        iss: CLOUD_RUNTIME_IDENTITY_ISSUER, aud: CLOUD_CONTROL_AUDIENCE, sub: "maintenance-stack", action: "ephemeral-enrollment:prepare",
        requestId: randomUUID(), iat, exp: iat + 60 })}`;
      await expect(successor.api("POST", "/instance/ephemeral-enrollment/prepare", { attemptId: randomUUID() },
        { "x-paperclip-cloud-control": `${assertion}.${sign(null, Buffer.from(assertion), pair.privateKey).toString("base64url")}` })).rejects.toThrow("409");
      expect(await readFile(file, "utf8")).toBe(bytes);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toMatchObject({ status: "failed", errorCode: "original_preparation_failure", runnerProfileJson: profile });
      rejectArchive = false; await archive();
      expect(await readLocalNativeControllerObligation(db, storage)).toBeNull();
      await vi.waitFor(async () => expect(await successor!.api("GET", "/ready")).toMatchObject({ status: "ready" }), { timeout: 10_000 });
      expect((await successor.idleLocalWork()).observations).toContainEqual({ label: "local.registered_probes", state: "none" });
      expect(await readFile(file, "utf8")).toBe(bytes);
    });
  } finally {
    await successor?.stop(); await first?.stop(); await db.$client.end(); await temporary.cleanup();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
