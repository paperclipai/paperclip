import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { NATIVE_WRITER_ROOT_BUSY_REASON_CODE } from "../services/execution-resource-admission.ts";
import {
  WORKSPACE_BUSY_ERROR_CODE,
  WORKSPACE_BUSY_RETRY_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres writer-root read/write tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ROOT_KEY = `writer-root-v1:${"b".repeat(64)}`;
const OTHER_ROOT_KEY = `writer-root-v1:${"d".repeat(64)}`;
const CONFIG_IDENTITY = `writer-config-v1:${"c".repeat(64)}`;

describeEmbeddedPostgres("canonical writer-root read/write admission", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtureDir!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-writer-root-read-write-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-writer-root-"));
  }, 20_000);

  afterEach(async () => {
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
  });

  afterAll(async () => {
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function cleanupFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(issueComments);
        await db.delete(issueRelations);
        await db.delete(issues);
        await db.delete(executionWorkspaces);
        await db.delete(projectWorkspaces);
        await db.delete(projects);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(budgetPolicies);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function writeScript(name: string, source: string) {
    const scriptPath = path.join(fixtureDir, name);
    await fs.writeFile(scriptPath, source, "utf8");
    return scriptPath;
  }

  /** A resolver stub: the operator's contract is one JSON receipt on stdout. */
  async function writeResolver(
    name: string,
    receipt: { access: string; writerRootKey: string | null; configIdentity?: string },
  ) {
    return await writeScript(name, `
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  kind: "paperclip_execution_writer_resource",
  access: ${JSON.stringify(receipt.access)},
  writerRootKey: ${JSON.stringify(receipt.writerRootKey)},
  configIdentity: ${JSON.stringify(receipt.configIdentity ?? CONFIG_IDENTITY)},
}) + "\\n");
process.exit(0);
`);
  }

  async function seedAgentAndIssue(input: {
    companyId: string;
    adapterConfig: Record<string, unknown>;
    agentName: string;
  }) {
    const agentId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId: input.companyId,
      name: `Project ${projectId.slice(0, 6)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.agentName,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: input.adapterConfig,
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId,
      title: `${input.agentName} issue`,
      description: "Fixture issue for canonical writer-root admission.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "responsible-user",
      identifier: `T-${issueId.slice(0, 6)}`,
    });
    return { agentId, issueId, projectId };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  /** A live holder exactly as the gate persists one: its own run context. */
  async function seedLiveHolder(input: {
    companyId: string;
    writerRootKey: string | null;
    access: string | null;
    configIdentity?: string;
    silentSince?: Date;
  }) {
    const holderAgentId = randomUUID();
    const holderRunId = randomUUID();
    const holderIssueId = randomUUID();
    const now = new Date();
    await db.insert(agents).values({
      id: holderAgentId,
      companyId: input.companyId,
      name: `Holder ${holderAgentId.slice(0, 6)}`,
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: holderIssueId,
      companyId: input.companyId,
      title: "Holder issue",
      description: "Live holder issue.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: holderAgentId,
      createdByUserId: "responsible-user",
      identifier: `T-${holderIssueId.slice(0, 6)}`,
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId: input.companyId,
      agentId: holderAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: input.silentSince ?? now,
      lastOutputAt: input.silentSince ?? now,
      contextSnapshot: {
        issueId: holderIssueId,
        executionWriterResource: {
          ...(input.access === null ? {} : { access: input.access }),
          ...(input.writerRootKey === null ? {} : { writerRootKey: input.writerRootKey }),
          configIdentity: input.configIdentity ?? CONFIG_IDENTITY,
        },
      },
      updatedAt: now,
    });
    return { holderRunId, holderAgentId, holderIssueId };
  }

  /** An agent whose resolver reports one access mode for the shared root. */
  async function seedWorker(input: {
    companyId: string;
    name: string;
    access: string;
    resolverName: string;
  }) {
    const resolver = await writeResolver(input.resolverName, {
      access: input.access,
      writerRootKey: ROOT_KEY,
    });
    const worker = await writeScript(`${input.resolverName}-work.mjs`, "process.exit(0);\n");
    return await seedAgentAndIssue({
      companyId: input.companyId,
      agentName: input.name,
      adapterConfig: {
        command: process.execPath,
        args: [worker],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: resolver, template: resolver },
      },
    });
  }

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  async function invokeRun(agentId: string, issueId: string) {
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();
    return await waitForRunToLeaveActiveStates(run!.id);
  }

  /**
   * A process-adapter body that signals it started and then blocks until the
   * release file appears, so a live run can be held across an admission.
   */
  function barrierScript(input: { startFile: string; releaseFile: string }) {
    return `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(input.startFile)}, '');
const deadline = Date.now() + 30_000;
while (!existsSync(${JSON.stringify(input.releaseFile)})) {
  if (Date.now() > deadline) throw new Error('barrier timeout');
  await new Promise((resolve) => setTimeout(resolve, 25));
}
process.exit(0);
`;
  }

  async function waitForFile(filePath: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const present = await fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false);
      if (present) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  /** No live run remains for the issue: nothing is holding its canonical root. */
  async function waitForIssueQuiet(companyId: string, issueId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const live = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
          ),
        )
        .limit(1);
      if (live.length === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  /**
   * Admit the deferred writer by its own bounded retry ladder: each attempt
   * waits for the reader's lane to be quiet first, because a succeeded run
   * without an issue comment legitimately queues one more reader run — which is
   * another live reader on the same root, not a failure of the writer.
   */
  async function admitWriterOnceReaderLaneIsQuiet(input: {
    companyId: string;
    readerIssueId: string;
    writerIssueId: string;
  }) {
    let settled: Awaited<ReturnType<typeof waitForRunToLeaveActiveStates>> = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForIssueQuiet(input.companyId, input.readerIssueId);
      const pending = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, input.companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.writerIssueId}`,
            inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!pending) break;
      if (pending.status === "scheduled_retry") {
        const due = new Date(
          (pending.scheduledRetryAt ?? new Date()).getTime() + 1_000,
        );
        await heartbeat.promoteDueScheduledRetries(due);
      }
      await heartbeat.resumeQueuedRuns();
      settled = await waitForRunToLeaveActiveStates(pending.id);
      if (settled?.status === "succeeded") break;
    }
    return settled;
  }

  it("defers a writer while a live reader holds the root and admits it once the reader finishes", async () => {
    const companyId = await seedCompany();
    const startFile = path.join(fixtureDir, "reader-started");
    const releaseFile = path.join(fixtureDir, "reader-release");
    const readerResolver = await writeResolver("live-reader.mjs", { access: "read_only", writerRootKey: ROOT_KEY });
    const writerResolver = await writeResolver("live-writer.mjs", { access: "exclusive", writerRootKey: ROOT_KEY });
    const readerScript = await writeScript("live-reader-work.mjs", barrierScript({ startFile, releaseFile }));
    const writerScript = await writeScript("live-writer-work.mjs", "process.exit(0);\n");
    const reader = await seedAgentAndIssue({
      companyId,
      agentName: "LiveReader",
      adapterConfig: {
        command: process.execPath,
        args: [readerScript],
        cwd: fixtureDir,
        timeoutSec: 60,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: readerResolver, template: readerResolver },
      },
    });
    const writer = await seedAgentAndIssue({
      companyId,
      agentName: "LiveWriter",
      adapterConfig: {
        command: process.execPath,
        args: [writerScript],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: writerResolver, template: writerResolver },
      },
    });

    const readerRun = await heartbeat.invoke(
      reader.agentId,
      "assignment",
      { issueId: reader.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(readerRun).not.toBeNull();
    try {
      // The reader is now genuinely executing: its canonical-root reservation is
      // live, established by the production gate rather than by a seeded row.
      await expect(waitForFile(startFile)).resolves.toBe(true);

      const deferredWriter = await invokeRun(writer.agentId, writer.issueId);
      expect(deferredWriter?.status).toBe("cancelled");
      expect(deferredWriter?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
      expect(
        (deferredWriter?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
      ).toMatchObject({
        source: "native_canonical_writer_root",
        reasonCode: NATIVE_WRITER_ROOT_BUSY_REASON_CODE,
        holderRunId: readerRun!.id,
      });
      // The holder was not disturbed by the deferral.
      expect((await heartbeat.getRun(readerRun!.id))?.status).toBe("running");
      // The deferral rides the standard bounded workspace-busy ladder.
      const pendingRetry = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${writer.issueId}`,
            inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      expect(pendingRetry?.scheduledRetryReason).toBe(WORKSPACE_BUSY_RETRY_REASON);

      // Release the reader: the root frees, and the deferred writer is admitted.
      await fs.writeFile(releaseFile, "");
      expect((await waitForRunToLeaveActiveStates(readerRun!.id))?.status).toBe("succeeded");

      const admitted = await admitWriterOnceReaderLaneIsQuiet({
        companyId,
        readerIssueId: reader.issueId,
        writerIssueId: writer.issueId,
      });
      expect(
        admitted?.status,
        JSON.stringify({
          errorCode: admitted?.errorCode ?? null,
          error: admitted?.error ?? null,
          workspaceBusy: (admitted?.resultJson as Record<string, unknown> | null)?.workspaceBusy ?? null,
          readerRunId: readerRun!.id,
          readerIssueId: reader.issueId,
        }),
      ).toBe("succeeded");
    } finally {
      // A failure above must not leave the barrier reader holding the root and
      // the suite's cleanup waiting on it.
      await fs.writeFile(releaseFile, "").catch(() => undefined);
    }
  }, 60_000);

  it("lets two readers of one canonical root coexist", async () => {
    const companyId = await seedCompany();
    await seedLiveHolder({ companyId, access: "read_only", writerRootKey: ROOT_KEY });
    const resolver = await writeResolver("reader2.mjs", { access: "read_only", writerRootKey: ROOT_KEY });
    const worker = await writeScript("reader2-work.mjs", "process.exit(0);\n");
    const { agentId, issueId } = await seedAgentAndIssue({
      companyId,
      agentName: "Reader2",
      adapterConfig: {
        command: process.execPath,
        args: [worker],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: resolver, template: resolver },
      },
    });

    const finished = await invokeRun(agentId, issueId);
    expect(finished?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(finished?.status).toBe("succeeded");
  });

  it("defers a writer against a recorded read-only reservation on the same root", async () => {
    const companyId = await seedCompany();
    const holder = await seedLiveHolder({ companyId, access: "read_only", writerRootKey: ROOT_KEY });
    const resolver = await writeResolver("writer-after-reader.mjs", { access: "exclusive", writerRootKey: ROOT_KEY });
    const worker = await writeScript("writer-after-reader-work.mjs", "process.exit(0);\n");
    const { agentId, issueId } = await seedAgentAndIssue({
      companyId,
      agentName: "Writer",
      adapterConfig: {
        command: process.execPath,
        args: [worker],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: resolver, template: resolver },
      },
    });

    const finished = await invokeRun(agentId, issueId);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(
      (finished?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({
      source: "native_canonical_writer_root",
      reasonCode: NATIVE_WRITER_ROOT_BUSY_REASON_CODE,
      holderRunId: holder.holderRunId,
    });
  });

  it("defers a reader against a recorded writer reservation on the same root", async () => {
    const companyId = await seedCompany();
    const holder = await seedLiveHolder({ companyId, access: "exclusive", writerRootKey: ROOT_KEY });
    const resolver = await writeResolver("reader-after-writer.mjs", { access: "read_only", writerRootKey: ROOT_KEY });
    const worker = await writeScript("reader-after-writer-work.mjs", "process.exit(0);\n");
    const { agentId, issueId } = await seedAgentAndIssue({
      companyId,
      agentName: "Reader3",
      adapterConfig: {
        command: process.execPath,
        args: [worker],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: resolver, template: resolver },
      },
    });

    const finished = await invokeRun(agentId, issueId);
    expect(finished?.status).toBe("cancelled");
    expect(
      (finished?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({
      reasonCode: NATIVE_WRITER_ROOT_BUSY_REASON_CODE,
      holderRunId: holder.holderRunId,
    });
  });

  it("keeps roots independent", async () => {
    const companyId = await seedCompany();
    await seedLiveHolder({ companyId, access: "exclusive", writerRootKey: OTHER_ROOT_KEY });
    const resolver = await writeResolver("other-root-writer.mjs", { access: "exclusive", writerRootKey: ROOT_KEY });
    const worker = await writeScript("other-root-work.mjs", "process.exit(0);\n");
    const { agentId, issueId } = await seedAgentAndIssue({
      companyId,
      agentName: "IndependentWriter",
      adapterConfig: {
        command: process.execPath,
        args: [worker],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: resolver, template: resolver },
      },
    });

    const finished = await invokeRun(agentId, issueId);
    expect(finished?.status).toBe("succeeded");
  });

  it("serializes a canonical root across companies sharing the physical host", async () => {
    const holderCompanyId = await seedCompany();
    const holder = await seedLiveHolder({ companyId: holderCompanyId, access: "exclusive", writerRootKey: ROOT_KEY });
    const companyId = await seedCompany();
    const resolver = await writeResolver("cross-company-writer.mjs", { access: "exclusive", writerRootKey: ROOT_KEY });
    const worker = await writeScript("cross-company-work.mjs", "process.exit(0);\n");
    const { agentId, issueId } = await seedAgentAndIssue({
      companyId,
      agentName: "CrossCompanyWriter",
      adapterConfig: {
        command: process.execPath,
        args: [worker],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: resolver, template: resolver },
      },
    });

    const finished = await invokeRun(agentId, issueId);
    expect(finished?.status).toBe("cancelled");
    expect(
      (finished?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({ holderRunId: holder.holderRunId });
  });

  it("conservatively defers against a running holder whose receipt has no canonical root", async () => {
    const companyId = await seedCompany();
    const holder = await seedLiveHolder({ companyId, access: "exclusive", writerRootKey: null });
    const writerResolver = await writeResolver("legacy-holder-writer.mjs", { access: "exclusive", writerRootKey: ROOT_KEY });
    const readerResolver = await writeResolver("legacy-holder-reader.mjs", { access: "read_only", writerRootKey: ROOT_KEY });
    const worker = await writeScript("legacy-holder-work.mjs", "process.exit(0);\n");
    const writer = await seedAgentAndIssue({
      companyId,
      agentName: "WriterVsLegacy",
      adapterConfig: {
        command: process.execPath,
        args: [worker],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: writerResolver, template: writerResolver },
      },
    });
    const reader = await seedAgentAndIssue({
      companyId,
      agentName: "ReaderVsLegacy",
      adapterConfig: {
        command: process.execPath,
        args: [worker],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: { command: process.execPath, entry: readerResolver, template: readerResolver },
      },
    });

    // An unidentified live holder may be touching this root, so neither a writer
    // nor a reader may overlap it.
    const writerRun = await invokeRun(writer.agentId, writer.issueId);
    expect(writerRun?.status).toBe("cancelled");
    expect(
      (writerRun?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({ holderRunId: holder.holderRunId });
    const readerRun = await invokeRun(reader.agentId, reader.issueId);
    expect(readerRun?.status).toBe("cancelled");
    expect(
      (readerRun?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({ holderRunId: holder.holderRunId });
  });

  it("holds the root for a quiet but still-running writer, in both directions", async () => {
    const companyId = await seedCompany();
    // No output for a day: the reservation is released by run lifecycle, not age.
    const holder = await seedLiveHolder({
      companyId,
      access: "exclusive",
      writerRootKey: ROOT_KEY,
      silentSince: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const writer = await seedWorker({ companyId, name: "WriterVsQuiet", access: "exclusive", resolverName: "writer-vs-quiet" });
    const reader = await seedWorker({ companyId, name: "ReaderVsQuiet", access: "read_only", resolverName: "reader-vs-quiet" });

    const writerRun = await invokeRun(writer.agentId, writer.issueId);
    expect(writerRun?.status).toBe("cancelled");
    expect(
      (writerRun?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({ holderRunId: holder.holderRunId });
    const readerRun = await invokeRun(reader.agentId, reader.issueId);
    expect(readerRun?.status).toBe("cancelled");
    expect(
      (readerRun?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({ holderRunId: holder.holderRunId });
    // The holder itself is untouched by either deferral.
    const holderRun = await heartbeat.getRun(holder.holderRunId);
    expect(holderRun?.status).toBe("running");
  });

  it("treats a same-root holder with unreadable access as a writer", async () => {
    const companyId = await seedCompany();
    // Same canonical root, but the persisted access cannot be read: an unknown
    // holder must never be overlapped by a reader either.
    await seedLiveHolder({ companyId, access: null, writerRootKey: ROOT_KEY });
    const reader = await seedWorker({ companyId, name: "ReaderVsUnknown", access: "read_only", resolverName: "reader-vs-unknown" });
    const writer = await seedWorker({ companyId, name: "WriterVsUnknown", access: "exclusive", resolverName: "writer-vs-unknown" });

    const readerRun = await invokeRun(reader.agentId, reader.issueId);
    expect(readerRun?.status).toBe("cancelled");
    expect(
      (readerRun?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({ reasonCode: NATIVE_WRITER_ROOT_BUSY_REASON_CODE });
    const writerRun = await invokeRun(writer.agentId, writer.issueId);
    expect(writerRun?.status).toBe("cancelled");
  });
});
