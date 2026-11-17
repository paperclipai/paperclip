import { randomUUID } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "../../packages/db/src/index.js";
import { DurablePrpControlPlane } from "../../server/src/vendor/paperclip-runner/index.js";
import { registerNativeRunnerCheckpoint } from "../../server/src/services/native-runtime/native-runner-checkpoint.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../server/src/__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../server/src/__tests__/helpers/isolated-test-home.js";
import { readControllerRecoverySnapshot } from "./controller-recovery-observer.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";

afterEach(() => vi.unstubAllEnvs());
(recoveryPostgresSupport.supported ? it : it.skip)("reads real UUID runner ownership and text event identity in one read-only snapshot", async () => {
  const database = await startRecoveryPostgres("controller-observer-");
  const db = createDb(database.connectionString);
  const home = createIsolatedTestHome();
  vi.stubEnv("PAPERCLIP_HOME", home.home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "observer-fixture");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", undefined);
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", undefined);
  const binding = { companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID() };
  const agentId = randomUUID(), runnerInstanceId = randomUUID(), normalizedSessionId = randomUUID();
  const authority = new DurablePrpControlPlane({ stateDirectory: path.join(home.home, "authority"),
    identity: { runnerInstanceId, normalizedSessionId, runId: binding.runId,
      environmentLeaseId: randomUUID(), turnId: randomUUID(), itemId: randomUUID() },
    expectedRunnerVersion: "observer-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
  try {
    await db.insert(companies).values({ id: binding.companyId, name: "Qualification observer" });
    await db.insert(agents).values({ id: agentId, companyId: binding.companyId, name: "Observer fixture", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: binding.issueId, companyId: binding.companyId, title: "Observe original execution" });
    await db.insert(heartbeatRuns).values({ id: binding.runId, companyId: binding.companyId, agentId,
      invocationSource: "manual", status: "running", runtimeMode: "native", nativeIssueId: binding.issueId,
      runnerInstanceId, nativeSessionId: normalizedSessionId });
    await db.insert(nativeRunFinalizations).values({ ...binding, phase: "observed", controllerBootId: "observer-controller",
      controllerGeneration: 1, leaseOwner: "observer-owner", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await registerNativeRunnerCheckpoint({ db, binding, authority, bootId: "observer-controller" });
    await db.insert(heartbeatRunEvents).values([runnerInstanceId, randomUUID()].map((sourceInstanceId, index) => ({
      companyId: binding.companyId, runId: binding.runId, agentId, seq: index + 1,
      eventType: "fixture", sourceSeq: index === 0 ? 7 : 99, sourceInstanceId,
    })));
    const checkpointBefore = await db.select().from(nativeRunnerCheckpoints);
    expect(await readControllerRecoverySnapshot(db, binding)).toMatchObject({
      runId: binding.runId, runnerInstanceId, nativeSessionId: normalizedSessionId,
      bootId: "observer-controller", generation: 1, sourceSeq: 7, authenticatedConnectionCount: 0,
    });
    expect(await db.select().from(nativeRunnerCheckpoints)).toEqual(checkpointBefore);
    // Exercise the actual launcher boundary in a separate process. Neither an
    // inline shell key nor a shell key file may replace this fixture's key.
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    const childScript = path.join(home.home, "observe.mts");
    const wrongKeyFile = path.join(home.home, "ambient-master.key");
    await writeFile(wrongKeyFile, "b".repeat(64), { mode: 0o600 });
    await writeFile(childScript, `
      import { createDb } from ${JSON.stringify(pathToFileURL(path.join(repositoryRoot, "packages/db/src/index.ts")).href)};
      import { readControllerRecoverySnapshot } from ${JSON.stringify(pathToFileURL(path.join(repositoryRoot, "tests/runner-e2e/controller-recovery-observer.ts")).href)};
      const db = createDb(process.env.OBSERVER_TEST_DATABASE_URL);
      try { console.log(JSON.stringify(await readControllerRecoverySnapshot(db, ${JSON.stringify(binding)}))); }
      finally { await db.$client.end(); }
    `, { mode: 0o600 });
    for (const override of [{ PAPERCLIP_SECRETS_MASTER_KEY: "a".repeat(64) },
      { PAPERCLIP_SECRETS_MASTER_KEY_FILE: wrongKeyFile }]) {
      const { stdout } = await promisify(execFile)(process.execPath,
        runnerE2ETypeScriptProcessArgs(repositoryRoot, childScript), {
          env: buildRunnerE2EProcessEnvironment({ ...process.env, ...override,
            OBSERVER_TEST_DATABASE_URL: database.connectionString }, []), timeout: 20_000,
        });
      expect(JSON.parse(stdout)).toMatchObject({ runId: binding.runId, sourceSeq: 7,
        runnerInstanceId, authenticatedConnectionCount: 0 });
    }
    expect(await db.select().from(nativeRunnerCheckpoints)).toEqual(checkpointBefore);
    await expect(readControllerRecoverySnapshot(db, { ...binding, companyId: randomUUID() }))
      .rejects.toThrow("no admitted native owner");
  } finally {
    await authority.stop();
    await database.cleanup();
    home.cleanup();
  }
}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
