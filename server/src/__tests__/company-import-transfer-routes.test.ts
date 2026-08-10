import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyTransferRunService } from "../services/company-transfer-runs.js";
import { sweepAbandonedImportTransferSpools } from "../services/company-import-transfers.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanyArtifactsService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => mockCompanyArtifactsService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

// Passthrough wrapper around the real spool module whose removeImportTransferSpool
// can be made to throw, so tests can exercise a post-success cleanup failure
// (e.g. EACCES on the spool dir) without touching real filesystem permissions.
const spoolRemovalFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../services/company-import-transfers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/company-import-transfers.js")>();
  return {
    ...actual,
    removeImportTransferSpool: async (spoolRoot: string, runId: string) => {
      if (spoolRemovalFailure.error) throw spoolRemovalFailure.error;
      return actual.removeImportTransferSpool(spoolRoot, runId);
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

const companyId = "11111111-1111-4111-8111-111111111111";
const TEST_USER_HEADER = "x-test-user-id";

function boardActor(userId: string) {
  return {
    type: "board",
    userId,
    userName: "Board User",
    userEmail: `${userId}@example.com`,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
    source: "session",
  };
}

// A minimal STORE-only zip writer (same layout as the portability routes test)
// so apply can be exercised end-to-end through the real readZipArchive path.
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoreZip(files: Record<string, string>, rootPath: string): Buffer {
  const encoder = new TextEncoder();
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;
  const entries = Object.entries(files);

  for (const [relativePath, content] of entries) {
    const fileName = encoder.encode(`${rootPath}/${relativePath}`);
    const body = Buffer.from(encoder.encode(content));
    const checksum = crc32(body);

    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    Buffer.from(fileName).copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + fileName.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    Buffer.from(fileName).copy(centralHeader, 46);

    localChunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Distinct zip content per call: the transfer declaration is content-addressed
// (same content resumes the prior run), so tests that must not share runs
// build distinct fixtures.
let zipSeq = 0;
function buildFixtureZip(): Buffer {
  zipSeq += 1;
  return buildStoreZip(
    {
      "COMPANY.md": `---\nname: Chunked Import ${zipSeq}\n---\n`,
      "agents/ceo/AGENTS.md": "---\nname: CEO\n---\n",
    },
    "paperclip",
  );
}

function sliceIntoParts(zip: Buffer, partSizeBytes: number): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < zip.length; offset += partSizeBytes) {
    parts.push(zip.subarray(offset, Math.min(offset + partSizeBytes, zip.length)));
  }
  return parts;
}

function declareTransfer(zip: Buffer, partSizeBytes: number) {
  const slices = sliceIntoParts(zip, partSizeBytes);
  return {
    slices,
    body: {
      totalBytes: zip.length,
      zipSha256: sha256Hex(zip),
      partSizeBytes,
      parts: slices.map((slice, index) => ({
        index,
        byteSize: slice.length,
        sha256: sha256Hex(slice),
      })),
    },
  };
}

const importMeta = {
  include: { company: true, agents: true, projects: false, issues: false },
  target: { mode: "existing_company", companyId },
  collisionStrategy: "rename",
};

describeEmbeddedPostgres("company import transfer routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let spoolRoot!: string;
  let app!: express.Express;
  let appImportCounter = 0;

  async function createApp() {
    appImportCounter += 1;
    const routeModulePath = `../routes/companies.js?company-import-transfer-routes-${appImportCounter}`;
    const middlewareModulePath = `../middleware/index.js?company-import-transfer-routes-${appImportCounter}`;
    const [{ companyRoutes }, { errorHandler }] = await Promise.all([
      import(routeModulePath) as Promise<typeof import("../routes/companies.js")>,
      import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
    ]);
    const built = express();
    built.use(express.json());
    built.use((req, _res, next) => {
      const header = req.headers[TEST_USER_HEADER];
      const userId = typeof header === "string" && header.length > 0 ? header : "board-user-a";
      (req as any).actor = boardActor(userId);
      next();
    });
    built.use("/api/companies", companyRoutes(db, undefined, { importTransferSpoolRoot: spoolRoot }));
    built.use(errorHandler);
    return built;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-import-transfer-routes-");
    db = createDb(tempDb.connectionString);
    // The mocked import result points at this company; the ledger's
    // company_id foreign key needs the row to exist.
    await db.insert(companies).values({ id: companyId, name: "Chunked Import Target" });
    spoolRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-import-transfer-spool-"));
    app = await createApp();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    await fs.rm(spoolRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    spoolRemovalFailure.error = null;
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      company: { id: companyId, action: "updated" },
      agents: [{ id: "agent-1" }],
      warnings: [],
    });
  });

  function putPart(transferId: string, index: number, bytes: Buffer, userId?: string) {
    let req = request(app)
      .put(`/api/companies/import/transfers/${transferId}/parts/${index}`)
      .set("content-type", "application/octet-stream");
    if (userId) req = req.set(TEST_USER_HEADER, userId);
    return req.send(bytes);
  }

  it("uploads parts out of order, tracks progress, and applies through the import pipeline", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 3));
    expect(slices.length).toBe(3);

    const created = await request(app).post("/api/companies/import/transfers").send(body);
    expect(created.status).toBe(200);
    const transferId = created.body.transferId as string;
    expect(transferId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.body.totalParts).toBe(3);
    expect(created.body.missingParts).toEqual([0, 1, 2]);
    expect(created.body.alreadyCompleted).toBe(false);

    // Out of order: last part first.
    expect((await putPart(transferId, 2, slices[2]!)).status).toBe(200);
    expect((await putPart(transferId, 0, slices[0]!)).status).toBe(200);

    const midway = await request(app).get(`/api/companies/import/transfers/${transferId}`);
    expect(midway.status).toBe(200);
    expect(midway.body.totalParts).toBe(3);
    expect(midway.body.completedParts).toBe(2);
    expect(midway.body.missingParts).toEqual([1]);

    expect((await putPart(transferId, 1, slices[1]!)).status).toBe(200);

    const applied = await request(app)
      .post(`/api/companies/import/transfers/${transferId}/apply`)
      .send(importMeta);
    expect(applied.status).toBe(200);
    expect(applied.body.company).toEqual({ id: companyId, action: "updated" });

    // The assembled zip fed the existing import pipeline unchanged.
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);
    const importBody = mockCompanyPortabilityService.importBundle.mock.calls[0]![0];
    expect(importBody.source.type).toBe("inline");
    expect(importBody.source.files["COMPANY.md"]).toContain("Chunked Import");
    expect(importBody.target).toEqual(importMeta.target);
    expect(importBody.collisionStrategy).toBe("rename");

    const run = (await companyTransferRunService.getRun(db, transferId))!;
    expect(run.status).toBe("completed");
    expect(run.companyId).toBe(companyId);
    // The shared import pipeline writes the same activity entry as the
    // single-shot upload route.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "company.imported", entityId: companyId }),
    );
    // Spool is deleted on success.
    await expect(fs.stat(path.join(spoolRoot, transferId))).rejects.toThrow();

    const finished = await request(app).get(`/api/companies/import/transfers/${transferId}`);
    expect(finished.body.status).toBe("completed");
    expect(finished.body.missingParts).toEqual([]);
  });

  it("applies through the async import job machinery when requested", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    for (const [index, slice] of slices.entries()) {
      expect((await putPart(transferId, index, slice)).status).toBe(200);
    }

    const accepted = await request(app)
      .post(`/api/companies/import/transfers/${transferId}/apply?async=1`)
      .send(importMeta);
    expect(accepted.status).toBe(202);
    const statusUrl = accepted.body.statusUrl as string;
    let job: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const polled = await request(app).get(statusUrl);
      job = polled.body.job;
      if (job?.status === "succeeded" || job?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job?.status).toBe("succeeded");
    expect(job?.result?.companyId).toBe(companyId);

    const run = (await companyTransferRunService.getRun(db, transferId))!;
    expect(run.status).toBe("completed");
    await expect(fs.stat(path.join(spoolRoot, transferId))).rejects.toThrow();
  });

  it("releases the claim when an async apply is refused by a running import", async () => {
    // Two complete transfers for the same board actor. The first async apply
    // parks a live job; the second transfer's async apply is refused by the
    // one-live-import-per-actor rule — and must NOT stay stranded in
    // "applying", or it would be unusable until a restart.
    const firstZip = buildFixtureZip();
    const first = declareTransfer(firstZip, Math.ceil(firstZip.length / 2));
    const firstCreated = await request(app).post("/api/companies/import/transfers").send(first.body);
    const firstId = firstCreated.body.transferId as string;
    for (const [index, slice] of first.slices.entries()) {
      expect((await putPart(firstId, index, slice)).status).toBe(200);
    }
    const secondZip = buildFixtureZip();
    const second = declareTransfer(secondZip, Math.ceil(secondZip.length / 2));
    const secondCreated = await request(app).post("/api/companies/import/transfers").send(second.body);
    const secondId = secondCreated.body.transferId as string;
    for (const [index, slice] of second.slices.entries()) {
      expect((await putPart(secondId, index, slice)).status).toBe(200);
    }

    let releaseImport: (() => void) | undefined;
    mockCompanyPortabilityService.importBundle.mockImplementationOnce(
      async () => {
        await new Promise<void>((resolve) => {
          releaseImport = resolve;
        });
        return {
          company: { id: companyId, action: "updated" },
          agents: [{ id: "agent-1" }],
          warnings: [],
        };
      },
    );
    const accepted = await request(app)
      .post(`/api/companies/import/transfers/${firstId}/apply?async=1`)
      .send(importMeta);
    expect(accepted.status).toBe(202);

    const refused = await request(app)
      .post(`/api/companies/import/transfers/${secondId}/apply?async=1`)
      .send(importMeta);
    expect(refused.status).toBe(409);
    // The refused transfer is failed (retryable), never stranded applying.
    expect((await companyTransferRunService.getRun(db, secondId))!.status).toBe("failed");

    releaseImport!();
    let job: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const polled = await request(app).get(accepted.body.statusUrl as string);
      job = polled.body.job;
      if (job?.status === "succeeded" || job?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job?.status).toBe("succeeded");
    expect((await companyTransferRunService.getRun(db, firstId))!.status).toBe("completed");

    // After the first import settles, the refused transfer applies cleanly.
    const retried = await request(app)
      .post(`/api/companies/import/transfers/${secondId}/apply`)
      .send(importMeta);
    expect(retried.status).toBe(200);
    expect((await companyTransferRunService.getRun(db, secondId))!.status).toBe("completed");
  });

  it("freezes part uploads while an apply holds the claim", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    for (const [index, slice] of slices.entries()) {
      expect((await putPart(transferId, index, slice)).status).toBe(200);
    }

    // Claim the run as an in-flight apply would, then retry a part upload:
    // the route must refuse before touching the spool, and the previously
    // uploaded part file must survive untouched for the apply to read.
    expect(await companyTransferRunService.claimApply(db, transferId)).toBe(true);
    const frozen = await putPart(transferId, 0, slices[0]!);
    expect(frozen.status).toBe(409);
    expect(frozen.body.error).toContain("apply is in progress");
    await expect(
      fs.stat(path.join(spoolRoot, transferId, "part-0")),
    ).resolves.toBeDefined();
    await companyTransferRunService.releaseApplyClaim(db, transferId, "test release");
  });

  it("rejects declarations that are inconsistent or over the limits", async () => {
    const zip = buildFixtureZip();
    const { body } = declareTransfer(zip, Math.ceil(zip.length / 2));

    const oversizedParts = await request(app)
      .post("/api/companies/import/transfers")
      .send({ ...body, partSizeBytes: 65 * 1024 * 1024 });
    expect(oversizedParts.status).toBe(422);

    const outOfOrder = await request(app)
      .post("/api/companies/import/transfers")
      .send({ ...body, parts: [...body.parts].reverse() });
    expect(outOfOrder.status).toBe(422);

    const sumMismatch = await request(app)
      .post("/api/companies/import/transfers")
      .send({ ...body, totalBytes: body.totalBytes + 1 });
    expect(sumMismatch.status).toBe(422);

    const badHash = await request(app)
      .post("/api/companies/import/transfers")
      .send({
        ...body,
        parts: body.parts.map((part) => ({ ...part, sha256: "not-hex" })),
      });
    expect(badHash.status).toBe(400);
  });

  it("rejects a part whose bytes do not match the declaration and records nothing", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;

    // Right length, wrong content -> sha mismatch.
    const corrupted = Buffer.from(slices[0]!);
    corrupted[0] = corrupted[0]! ^ 0xff;
    const wrongSha = await putPart(transferId, 0, corrupted);
    expect(wrongSha.status).toBe(422);

    // Wrong length.
    const wrongLength = await putPart(transferId, 0, slices[0]!.subarray(1));
    expect(wrongLength.status).toBe(422);

    const status = await request(app).get(`/api/companies/import/transfers/${transferId}`);
    expect(status.body.completedParts).toBe(0);
    expect(status.body.missingParts).toEqual([0, 1]);
    const run = (await companyTransferRunService.getRun(db, transferId))!;
    expect(run.completedParts).toEqual([]);
  });

  it("treats a re-upload of a completed part as a no-op success", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;

    expect((await putPart(transferId, 0, slices[0]!)).status).toBe(200);
    const again = await putPart(transferId, 0, slices[0]!);
    expect(again.status).toBe(200);
    expect(again.body.alreadyCompleted).toBe(true);

    const run = (await companyTransferRunService.getRun(db, transferId))!;
    expect(run.completedParts).toEqual(["part-0"]);
  });

  it("refuses to apply while parts are missing", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 3));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    expect((await putPart(transferId, 0, slices[0]!)).status).toBe(200);

    const applied = await request(app)
      .post(`/api/companies/import/transfers/${transferId}/apply`)
      .send(importMeta);
    expect(applied.status).toBe(409);
    expect(applied.body.missingParts).toEqual([1, 2]);
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
    expect((await companyTransferRunService.getRun(db, transferId))!.status).not.toBe("completed");
  });

  it("resumes a re-declared transfer with its prior progress", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 3));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    expect((await putPart(transferId, 0, slices[0]!)).status).toBe(200);

    const redeclared = await request(app).post("/api/companies/import/transfers").send(body);
    expect(redeclared.status).toBe(200);
    expect(redeclared.body.transferId).toBe(transferId);
    expect(redeclared.body.missingParts).toEqual([1, 2]);
    expect(redeclared.body.alreadyCompleted).toBe(false);
  });

  it("reports an already-applied transfer on re-declaration", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, zip.length);
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    expect((await putPart(transferId, 0, slices[0]!)).status).toBe(200);
    expect(
      (await request(app).post(`/api/companies/import/transfers/${transferId}/apply`).send(importMeta)).status,
    ).toBe(200);

    const redeclared = await request(app).post("/api/companies/import/transfers").send(body);
    expect(redeclared.status).toBe(200);
    expect(redeclared.body.transferId).toBe(transferId);
    expect(redeclared.body.alreadyCompleted).toBe(true);
    expect(redeclared.body.missingParts).toEqual([]);

    const reApplied = await request(app)
      .post(`/api/companies/import/transfers/${transferId}/apply`)
      .send(importMeta);
    expect(reApplied.status).toBe(409);
  });

  it("keeps a completed run completed when post-success spool cleanup fails", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    for (const [index, slice] of slices.entries()) {
      expect((await putPart(transferId, index, slice)).status).toBe(200);
    }

    // The import itself succeeds; only the post-success spool deletion blows
    // up. The cleanup error must not surface as an apply failure and — above
    // all — must not flip the completed run back to a claimable state.
    spoolRemovalFailure.error = new Error("EACCES: spool dir is busy");
    try {
      const applied = await request(app)
        .post(`/api/companies/import/transfers/${transferId}/apply`)
        .send(importMeta);
      expect(applied.status).toBe(200);
      expect(applied.body.company).toEqual({ id: companyId, action: "updated" });
    } finally {
      spoolRemovalFailure.error = null;
    }
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("completed");

    // A follow-up apply short-circuits on the completed run instead of
    // claiming it for a duplicate import.
    const reApplied = await request(app)
      .post(`/api/companies/import/transfers/${transferId}/apply`)
      .send(importMeta);
    expect(reApplied.status).toBe(409);
    expect(reApplied.body.error).toContain("already been applied");
    const redeclared = await request(app).post("/api/companies/import/transfers").send(body);
    expect(redeclared.body.transferId).toBe(transferId);
    expect(redeclared.body.alreadyCompleted).toBe(true);
    // The import pipeline never ran a second time.
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("completed");

    // The leftover spool from the failed cleanup is not stranded: the sweep
    // collects terminal-run spools immediately, no idle wait, and the run
    // keeps its terminal status.
    await expect(fs.stat(path.join(spoolRoot, transferId))).resolves.toBeDefined();
    const swept = await sweepAbandonedImportTransferSpools(db, spoolRoot);
    expect(swept.swept).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(path.join(spoolRoot, transferId))).rejects.toThrow();
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("completed");
  });

  it("settles the run completed even when attaching the imported company fails", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    for (const [index, slice] of slices.entries()) {
      expect((await putPart(transferId, index, slice)).status).toBe(200);
    }

    // The import commits, then a post-settlement step (company attachment)
    // blows up. Settlement runs first, so the error must neither surface as
    // an apply failure nor release the claim into a re-importable state.
    const attachSpy = vi
      .spyOn(companyTransferRunService, "attachCompany")
      .mockRejectedValueOnce(new Error("registry write timed out"));
    try {
      const applied = await request(app)
        .post(`/api/companies/import/transfers/${transferId}/apply`)
        .send(importMeta);
      expect(applied.status).toBe(200);
    } finally {
      attachSpy.mockRestore();
    }
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("completed");

    const reApplied = await request(app)
      .post(`/api/companies/import/transfers/${transferId}/apply`)
      .send(importMeta);
    expect(reApplied.status).toBe(409);
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the assembled zip does not match the declared whole-file hash", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    // Per-part hashes are honest, but the declared whole-file hash is not.
    const lying = { ...body, zipSha256: sha256Hex(Buffer.from("something else entirely")) };
    const created = await request(app).post("/api/companies/import/transfers").send(lying);
    const transferId = created.body.transferId as string;
    for (const [index, slice] of slices.entries()) {
      expect((await putPart(transferId, index, slice)).status).toBe(200);
    }

    const applied = await request(app)
      .post(`/api/companies/import/transfers/${transferId}/apply`)
      .send(importMeta);
    expect(applied.status).toBe(422);
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();

    const run = (await companyTransferRunService.getRun(db, transferId))!;
    expect(run.status).toBe("failed");
    // The spool is deleted so a resume re-uploads everything.
    await expect(fs.stat(path.join(spoolRoot, transferId))).rejects.toThrow();
  });

  it("hides transfers from other actors", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;

    const otherStatus = await request(app)
      .get(`/api/companies/import/transfers/${transferId}`)
      .set(TEST_USER_HEADER, "board-user-b");
    expect(otherStatus.status).toBe(404);

    const otherUpload = await putPart(transferId, 0, slices[0]!, "board-user-b");
    expect(otherUpload.status).toBe(404);

    const otherApply = await request(app)
      .post(`/api/companies/import/transfers/${transferId}/apply`)
      .set(TEST_USER_HEADER, "board-user-b")
      .send(importMeta);
    expect(otherApply.status).toBe(404);

    // Malformed ids never reach the filesystem or the database.
    const malformed = await request(app).get("/api/companies/import/transfers/..%2Fescape");
    expect(malformed.status).toBe(404);
  });

  it("sweeps abandoned spools and cancels their open runs", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    expect((await putPart(transferId, 0, slices[0]!)).status).toBe(200);

    // Fresh activity: nothing to sweep at the real threshold.
    expect(await sweepAbandonedImportTransferSpools(db, spoolRoot)).toEqual({ swept: 0 });
    await expect(fs.stat(path.join(spoolRoot, transferId))).resolves.toBeDefined();

    // 25 hours later the run saw no activity: spool deleted, run cancelled.
    // Cancelled — not failed — so no apply can claim the run in the window
    // between the status flip and the spool deletion (claimApply accepts
    // failed runs but never cancelled ones).
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const swept = await sweepAbandonedImportTransferSpools(db, spoolRoot, { now: later });
    expect(swept.swept).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(path.join(spoolRoot, transferId))).rejects.toThrow();
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("cancelled");

    // A redeclaration after the sweep starts a FRESH run — the cancelled run
    // is never resumed — with every part missing again, matching the part
    // upload's 410 "re-create it" contract.
    const redeclared = await request(app).post("/api/companies/import/transfers").send(body);
    expect(redeclared.status).toBe(200);
    expect(redeclared.body.transferId).not.toBe(transferId);
    expect(redeclared.body.alreadyCompleted).toBe(false);
    expect(redeclared.body.missingParts).toEqual([0, 1]);
    // The swept run itself stays terminal.
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("cancelled");
  });

  it("skips the sweep when the run saw activity after the staleness read", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    expect((await putPart(transferId, 0, slices[0]!)).status).toBe(200);

    // TOCTOU simulation: the sweep's initial read sees a 25h-stale updatedAt
    // — as if a part upload bumped the row right after that read — while the
    // guarded UPDATE sees the fresh row in the database and must miss.
    const real = (await companyTransferRunService.getRun(db, transferId))!;
    const staleRead = vi.spyOn(companyTransferRunService, "getRun").mockResolvedValue({
      ...real,
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    try {
      expect(await sweepAbandonedImportTransferSpools(db, spoolRoot)).toEqual({ swept: 0 });
    } finally {
      staleRead.mockRestore();
    }

    // The spool survived and the run is still open.
    await expect(fs.stat(path.join(spoolRoot, transferId))).resolves.toBeDefined();
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("running");
  });

  it("returns 410 for a part upload against a swept transfer and records nothing", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    expect((await putPart(transferId, 0, slices[0]!)).status).toBe(200);

    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const swept = await sweepAbandonedImportTransferSpools(db, spoolRoot, { now: later });
    expect(swept.swept).toBeGreaterThanOrEqual(1);
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("cancelled");

    const upload = await putPart(transferId, 1, slices[1]!);
    expect(upload.status).toBe(410);
    const run = (await companyTransferRunService.getRun(db, transferId))!;
    expect(run.status).toBe("cancelled");
    expect(run.completedParts).toEqual(["part-0"]);
    // The stray part file was discarded, not left half-spooled.
    await expect(fs.stat(path.join(spoolRoot, transferId, "part-1"))).rejects.toThrow();
  });

  it("runs exactly one of two concurrent applies", async () => {
    const zip = buildFixtureZip();
    const { body, slices } = declareTransfer(zip, Math.ceil(zip.length / 2));
    const created = await request(app).post("/api/companies/import/transfers").send(body);
    const transferId = created.body.transferId as string;
    for (const [index, slice] of slices.entries()) {
      expect((await putPart(transferId, index, slice)).status).toBe(200);
    }

    // Hold the import open long enough for the losing apply to reach the
    // claim while the winner is still importing.
    mockCompanyPortabilityService.importBundle.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { company: { id: companyId, action: "updated" }, agents: [], warnings: [] };
    });

    const [first, second] = await Promise.all([
      request(app).post(`/api/companies/import/transfers/${transferId}/apply`).send(importMeta),
      request(app).post(`/api/companies/import/transfers/${transferId}/apply`).send(importMeta),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);
    // The non-idempotent import ran exactly once and the claim settled.
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledTimes(1);
    expect((await companyTransferRunService.getRun(db, transferId))!.status).toBe("completed");
    await expect(fs.stat(path.join(spoolRoot, transferId))).rejects.toThrow();
  });
});
