import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  assets,
  companies,
  createDb,
  issueAttachments,
  issueImageGenerationJobs,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createIssueImageGenerationJobService } from "../services/issue-image-generation-jobs.ts";
import type { StorageService } from "../storage/types.js";

const mockGenerateCodexIssueImage = vi.fn();

vi.mock("../services/codex-image-generation.js", () => ({
  generateCodexIssueImage: (...args: unknown[]) => mockGenerateCodexIssueImage(...args),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres image generation job tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let pngBytes!: Buffer;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockStorage(options: { failOnPutNumber?: number } = {}) {
  let putCount = 0;
  const objects = new Map<string, { companyId: string; body: Buffer; contentType: string }>();
  const deletedKeys: string[] = [];

  const storage: StorageService & { deletedKeys: string[] } = {
    provider: "local",
    async putFile(input) {
      putCount += 1;
      if (options.failOnPutNumber && putCount === options.failOnPutNumber) {
        throw new Error(`storage put failure ${putCount}`);
      }
      const objectKey = `${input.namespace}/${putCount}-${input.originalFilename ?? "file"}`;
      objects.set(objectKey, {
        companyId: input.companyId,
        body: Buffer.from(input.body),
        contentType: input.contentType,
      });
      return {
        provider: "local",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: `sha-${putCount}`,
        originalFilename: input.originalFilename,
      };
    },
    async getObject(companyId, objectKey) {
      const stored = objects.get(objectKey);
      if (!stored || stored.companyId !== companyId) {
        throw new Error(`object not found: ${objectKey}`);
      }
      return {
        stream: Readable.from(stored.body),
        contentType: stored.contentType,
        contentLength: stored.body.length,
      };
    },
    async headObject(companyId, objectKey) {
      const stored = objects.get(objectKey);
      if (!stored || stored.companyId !== companyId) return { exists: false };
      return {
        exists: true,
        contentType: stored.contentType,
        contentLength: stored.body.length,
      };
    },
    async deleteObject(companyId, objectKey) {
      const stored = objects.get(objectKey);
      if (stored?.companyId === companyId) {
        objects.delete(objectKey);
        deletedKeys.push(objectKey);
      }
    },
    deletedKeys,
  };

  return storage;
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describeEmbeddedPostgres("createIssueImageGenerationJobService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-image-jobs-");
    db = createDb(tempDb.connectionString);
    pngBytes = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    mockGenerateCodexIssueImage.mockReset();
    delete process.env.PAPERCLIP_IMAGE_PROVIDER;
  });

  afterEach(async () => {
    await db.delete(issueImageGenerationJobs);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `IMG${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Generate image",
      description: "service reliability test",
      status: "todo",
      priority: "high",
      identifier: "IMG-1",
    });

    return { companyId, issueId };
  }

  function buildEnqueueInput(seed: { companyId: string; issueId: string }, overrides: Partial<{ idempotencyKey: string; requestFingerprint: string }> = {}) {
    return {
      companyId: seed.companyId,
      issueId: seed.issueId,
      idempotencyKey: overrides.idempotencyKey ?? "idem-1",
      actor: {
        actorType: "user" as const,
        actorId: "user-1",
        agentId: null,
        runId: null,
      },
      request: {
        prompt: "memoir cover",
        size: "64x64",
        quality: "medium" as const,
        model: "gpt-image-1" as const,
        outputFilename: "memoir.png",
      },
      referenceSnapshot: {
        boardReferenceIntentDetected: false,
        referenceGuardrailApplied: false,
        requestedReferenceImageAttachmentIds: [],
        requestedReferenceImageAssetIds: [],
        autoBoundReferenceImageAttachmentIds: [],
        autoBoundReferenceImageAssetIds: [],
        effectiveReferenceImageAttachmentIds: [],
        effectiveReferenceImageAssetIds: [],
        allowedIssueIds: [seed.issueId],
        exactReferenceRoles: [],
      },
      requestFingerprint: overrides.requestFingerprint ?? "fingerprint-1",
    };
  }

  async function loadJob(jobId: string) {
    return db
      .select()
      .from(issueImageGenerationJobs)
      .where(eq(issueImageGenerationJobs.id, jobId))
      .then((rows) => rows[0] ?? null);
  }

  it("deduplicates concurrent enqueue attempts for the same request fingerprint", async () => {
    const seed = await seedIssue();
    const storage = createMockStorage();
    const serviceA = createIssueImageGenerationJobService(db, storage, { scheduleOnEnqueue: false });
    const serviceB = createIssueImageGenerationJobService(db, storage, { scheduleOnEnqueue: false });
    const input = buildEnqueueInput(seed);

    const [first, second] = await Promise.all([serviceA.enqueue(input), serviceB.enqueue(input)]);

    expect(first.id).toBe(second.id);

    const rows = await db.select().from(issueImageGenerationJobs);
    expect(rows).toHaveLength(1);

    await expect(
      serviceA.enqueue(buildEnqueueInput(seed, { requestFingerprint: "fingerprint-2" })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("marks provider failures as failed without publishing attachments", async () => {
    const seed = await seedIssue();
    const storage = createMockStorage();
    const service = createIssueImageGenerationJobService(db, storage, { leaseMs: 1_500, scheduleOnEnqueue: false });
    mockGenerateCodexIssueImage.mockRejectedValueOnce(new Error("provider unavailable"));

    const job = await service.enqueue(buildEnqueueInput(seed));
    await service.tick();

    const persisted = await loadJob(job.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.lastError).toContain("provider unavailable");
    expect(persisted?.outputAttachmentId).toBeNull();
    expect(persisted?.auditAttachmentId).toBeNull();
    expect(await db.select().from(issueAttachments)).toHaveLength(0);
    expect(await db.select().from(assets)).toHaveLength(0);
  });

  it("prevents a stale worker from publishing after another worker reclaims the lease", async () => {
    const seed = await seedIssue();
    const storage = createMockStorage();
    const serviceA = createIssueImageGenerationJobService(db, storage, { leaseMs: 1_200, scheduleOnEnqueue: false });
    const serviceB = createIssueImageGenerationJobService(db, storage, { leaseMs: 1_200, scheduleOnEnqueue: false });
    const first = deferred<{
      outputBytes: Buffer;
      endpoint: string;
      model: string;
      providerRequestId: string | null;
      generationMode: "prompt_only";
      actualImageInputsBound: [];
    }>();

    mockGenerateCodexIssueImage
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        outputBytes: pngBytes,
        endpoint: "codex",
        model: "codex-test",
        providerRequestId: "req-2",
        generationMode: "prompt_only",
        actualImageInputsBound: [],
      });

    const job = await serviceA.enqueue(buildEnqueueInput(seed));
    const firstTick = serviceA.tick();
    await vi.waitFor(() => expect(mockGenerateCodexIssueImage).toHaveBeenCalledTimes(1));
    await wait(1_350);
    await serviceB.tick();
    first.resolve({
      outputBytes: pngBytes,
      endpoint: "codex",
      model: "codex-test",
      providerRequestId: "req-1",
      generationMode: "prompt_only",
      actualImageInputsBound: [],
    });
    await firstTick;

    const persisted = await loadJob(job.id);
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.attemptCount).toBe(2);
    expect(persisted?.outputAttachmentId).toBeTruthy();
    expect(persisted?.auditAttachmentId).toBeTruthy();
    expect(await db.select().from(issueAttachments)).toHaveLength(2);
    expect(await db.select().from(assets)).toHaveLength(2);
    expect(storage.deletedKeys).toHaveLength(0);
  });

  it("cleans partial output when audit persistence fails mid-delivery", async () => {
    const seed = await seedIssue();
    const storage = createMockStorage({ failOnPutNumber: 2 });
    const service = createIssueImageGenerationJobService(db, storage, { leaseMs: 1_500, scheduleOnEnqueue: false });
    mockGenerateCodexIssueImage.mockResolvedValueOnce({
      outputBytes: pngBytes,
      endpoint: "codex",
      model: "codex-test",
      providerRequestId: "req-3",
      generationMode: "prompt_only",
      actualImageInputsBound: [],
    });

    const job = await service.enqueue(buildEnqueueInput(seed));
    await service.tick();

    const persisted = await loadJob(job.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.lastError).toContain("storage put failure 2");
    expect(persisted?.outputAttachmentId).toBeNull();
    expect(persisted?.auditAttachmentId).toBeNull();
    expect(await db.select().from(issueAttachments)).toHaveLength(0);
    expect(await db.select().from(assets)).toHaveLength(0);
    expect(storage.deletedKeys).toHaveLength(1);
  });
});
