import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentCredentials,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companySkills,
  companies,
  costEvents,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  providerCredentials,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { credentialService, resolveAllCredentialEnv } from "../services/credentials.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: "You have reached your usage limit. Try again at 8:15 AM.",
    errorCode: "codex_transient_upstream",
    errorFamily: "transient_upstream",
    retryNotBefore: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    provider: "openai",
    model: "gpt-5-codex",
    billingType: "subscription" as const,
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat credential failover tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForRetryRun(
  db: ReturnType<typeof createDb>,
  sourceRunId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const retryRun = await db
      .select({
        status: heartbeatRuns.status,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, sourceRunId))
      .then((rows) => rows[0] ?? null);
    if (retryRun) return retryRun;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function waitForCredentialStatesWithCooldown(
  db: ReturnType<typeof createDb>,
  credentialIds: string[],
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await db
      .select({
        id: providerCredentials.id,
        cooldownUntil: providerCredentials.cooldownUntil,
        cooldownReason: providerCredentials.cooldownReason,
        consecutiveFailureCount: providerCredentials.consecutiveFailureCount,
      })
      .from(providerCredentials)
      .where(inArray(providerCredentials.id, credentialIds));
    if (states.some((credential) => credential.cooldownUntil !== null)) return states;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db
    .select({
      id: providerCredentials.id,
      cooldownUntil: providerCredentials.cooldownUntil,
      cooldownReason: providerCredentials.cooldownReason,
      consecutiveFailureCount: providerCredentials.consecutiveFailureCount,
    })
    .from(providerCredentials)
    .where(inArray(providerCredentials.id, credentialIds));
}

async function waitForHeartbeatSideEffectsToSettle(db: ReturnType<typeof createDb>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let stablePolls = 0;
  let previousSignature = "";
  while (Date.now() < deadline) {
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns);
    const events = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents);
    const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
    const signature = `${runs
      .map((run) => `${run.id}:${run.status}:${run.updatedAt?.getTime() ?? 0}`)
      .sort()
      .join("|")};events:${events.length}`;
    if (!hasActiveRun && signature === previousSignature) {
      stablePolls += 1;
      if (stablePolls >= 3) return;
    } else {
      stablePolls = 0;
      previousSignature = signature;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("heartbeat credential failover", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;
  const originalCredentialKey = process.env.PAPERCLIP_CREDENTIAL_KEY;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    process.env.PAPERCLIP_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-creds-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-credential-failover-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await waitForHeartbeatSideEffectsToSettle(db);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agentCredentials);
    await db.delete(providerCredentials);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    if (originalCredentialKey === undefined) delete process.env.PAPERCLIP_CREDENTIAL_KEY;
    else process.env.PAPERCLIP_CREDENTIAL_KEY = originalCredentialKey;
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
  });

  it("cools down the active Codex OAuth credential and schedules immediate same-type failover", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const svc = credentialService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const first = await svc.create(companyId, {
      name: "codex-oauth-1",
      type: "codex_oauth",
      credential: { accessToken: "codex-oauth-access-token-1" },
    });
    const second = await svc.create(companyId, {
      name: "codex-oauth-2",
      type: "codex_oauth",
      credential: { accessToken: "codex-oauth-access-token-2" },
    });
    const setResult = await svc.setForAgent(agentId, [first.id, second.id]);
    expect(setResult.ok).toBe(true);

    await db
      .update(providerCredentials)
      .set({ lastUsedAt: new Date("2026-04-20T10:00:00.000Z") })
      .where(eq(providerCredentials.id, first.id));
    await db
      .update(providerCredentials)
      .set({ lastUsedAt: new Date("2026-04-20T11:00:00.000Z") })
      .where(eq(providerCredentials.id, second.id));

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).toBeTruthy();
    await heartbeat.resumeQueuedRuns();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);

    expect(finished).toMatchObject({
      status: "failed",
      errorCode: "codex_transient_upstream",
    });

    const credentialStates = await waitForCredentialStatesWithCooldown(db, [first.id, second.id]);
    const cooledCredentials = credentialStates.filter((credential) => credential.cooldownUntil !== null);
    expect(cooledCredentials).toHaveLength(1);
    const cooledCredential = cooledCredentials[0];
    const alternateCredentialId = cooledCredential.id === first.id ? second.id : first.id;
    expect(cooledCredential).toMatchObject({
      cooldownReason: "codex_transient_upstream",
      consecutiveFailureCount: 1,
    });
    expect(cooledCredential.cooldownUntil).toBeInstanceOf(Date);

    const retryRun = await waitForRetryRun(db, queued!.id);

    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: queued!.id,
      scheduledRetryReason: "credential_failover",
    });
    expect(retryRun.contextSnapshot).toMatchObject({
      wakeReason: "credential_failover_retry",
      retryReason: "credential_failover",
    });

    const resolvedAfterFailover = await resolveAllCredentialEnv(db, agentId);
    expect(resolvedAfterFailover.chosen).toEqual([{ credentialId: alternateCredentialId, type: "codex_oauth" }]);
    expect(JSON.parse(await fs.readFile(`${resolvedAfterFailover.env.CODEX_HOME}/auth.json`, "utf8"))).toMatchObject({
      tokens: {
        access_token:
          alternateCredentialId === first.id
            ? "codex-oauth-access-token-1"
            : "codex-oauth-access-token-2",
      },
    });

    const joinRows = await db
      .select()
      .from(agentCredentials)
      .where(eq(agentCredentials.agentId, agentId));
    expect(joinRows.map((row) => row.credentialId).sort()).toEqual([first.id, second.id].sort());
  });
});
