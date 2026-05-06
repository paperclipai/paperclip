import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  assets,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueAttachments,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { parseIssueArtifactWorkProductMetadata } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Generated deliverables.",
    provider: "openclaw",
    model: "gateway-test",
    artifacts: [
      {
        title: "Final packet",
        originalFilename: "final-packet.md",
        sourcePath: "deliverables/final-packet.md",
        contentType: "text/markdown",
        body: Buffer.from("# Final packet\n"),
        byteSize: Buffer.byteLength("# Final packet\n"),
        isPrimary: true,
        summary: "Merged final packet.",
      },
    ],
  })),
);

const mockStorage = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(async (input: { companyId: string; originalFilename: string | null; contentType: string; body: Buffer }) => ({
    provider: "local_disk",
    objectKey: `${input.companyId}/issues/deliverables/${input.originalFilename ?? "file"}`,
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: `sha-${input.originalFilename ?? "file"}`,
    originalFilename: input.originalFilename,
  })),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(async () => undefined),
}));

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

vi.mock("../storage/index.js", () => ({
  getStorageService: () => mockStorage,
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat artifact tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat issue-backed artifact persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-openclaw-artifacts-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("persists artifacts as attachments and artifact work products for issue-backed runs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Artifacts Co",
      status: "active",
      issuePrefix: `ART${companyId.slice(0, 3)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Gateway Agent",
      role: "writer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: { url: "wss://gateway.example/ws" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Prepare campaign packet",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "PAP-1",
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    expect(run?.id).toBeTruthy();

    const completed = await waitForCondition(async () => {
      const [persisted, productCount] = await Promise.all([
        db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run!.id))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.issueId, issueId))
          .then((rows) => rows.length),
      ]);
      return persisted?.status === "succeeded" && productCount === 1;
    });
    expect(completed).toBe(true);

    const attachments = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, issueId));
    expect(attachments).toHaveLength(1);
    expect(mockStorage.putFile).toHaveBeenCalledTimes(1);

    const products = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(products).toHaveLength(1);
    expect(products[0]?.type).toBe("artifact");
    expect(products[0]?.provider).toBe("paperclip");
    expect(products[0]?.createdByRunId).toBe(run?.id ?? null);
    expect(products[0]?.externalId).toBe("openclaw_gateway:deliverables/final-packet.md");

    const metadata = parseIssueArtifactWorkProductMetadata({
      type: products[0]!.type as "artifact",
      metadata: (products[0]!.metadata as Record<string, unknown>) ?? null,
    });
    expect(metadata).toMatchObject({
      attachmentId: attachments[0]!.id,
      contentPath: `/api/attachments/${attachments[0]!.id}/content`,
      sourcePath: "deliverables/final-packet.md",
      contentType: "text/markdown",
      originalFilename: "final-packet.md",
    });
  });

  it("does not persist artifacts when the run is not issue-backed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Artifacts Co",
      status: "active",
      issuePrefix: `ART${companyId.slice(0, 3)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Gateway Agent",
      role: "writer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: { url: "wss://gateway.example/ws" },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_wake",
      payload: {},
      contextSnapshot: { wakeReason: "manual_wake" },
    });

    expect(run?.id).toBeTruthy();

    const completed = await waitForCondition(async () => {
      const persisted = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      return persisted?.status === "succeeded";
    });
    expect(completed).toBe(true);

    const [attachmentCount, productCount] = await Promise.all([
      db.select().from(issueAttachments).then((rows) => rows.length),
      db.select().from(issueWorkProducts).then((rows) => rows.length),
    ]);
    expect(attachmentCount).toBe(0);
    expect(productCount).toBe(0);
  });

  it("updates the same logical work product across reruns via stable externalId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Artifacts Co",
      status: "active",
      issuePrefix: `ART${companyId.slice(0, 3)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Gateway Agent",
      role: "writer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: { url: "wss://gateway.example/ws" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Prepare campaign packet",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "PAP-1",
    });

    const firstRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    expect(firstRun?.id).toBeTruthy();
    await waitForCondition(async () => {
      const [persisted, productCount] = await Promise.all([
        db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.issueId, issueId))
          .then((rows) => rows.length),
      ]);
      return persisted?.status === "succeeded" && productCount === 1;
    });

    mockStorage.putFile.mockImplementationOnce(async (input: { companyId: string; originalFilename: string | null; contentType: string; body: Buffer }) => ({
      provider: "local_disk",
      objectKey: `${input.companyId}/issues/deliverables/second-${input.originalFilename ?? "file"}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: `sha-second-${input.originalFilename ?? "file"}`,
      originalFilename: input.originalFilename,
    }));

    const secondRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    expect(secondRun?.id).toBeTruthy();
    await waitForCondition(async () => {
      const [persisted, products] = await Promise.all([
        db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondRun!.id))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.issueId, issueId)),
      ]);
      return (
        persisted?.status === "succeeded" &&
        products.length === 1 &&
        products[0]?.createdByRunId === secondRun!.id
      );
    });

    const products = await db
      .select()
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.issueId, issueId),
          eq(issueWorkProducts.externalId, "openclaw_gateway:deliverables/final-packet.md"),
        ),
      );
    expect(products).toHaveLength(1);
    expect(products[0]?.createdByRunId).toBe(secondRun?.id ?? null);
    expect(mockStorage.deleteObject).toHaveBeenCalledTimes(1);
  });
});
