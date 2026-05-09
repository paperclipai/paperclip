import express from "express";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySharedInstructionsHistory,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { companyService } from "../services/companies.ts";
import {
  buildMergedSharedInstructions,
  resolveSharedInstructions,
  SHARED_INSTRUCTIONS_SEPARATOR,
} from "../services/shared-instructions.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// -------- Route-level S1 gate tests (acceptance #4) --------

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  updateSharedInstructions: vi.fn(),
  listSharedInstructionsHistory: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

async function createCompanyApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const ACTOR_AGENT = (role: string) => ({
  type: "agent" as const,
  agentId: "agent-1",
  companyId: "company-1",
  companyIds: ["company-1"],
  source: "agent_key" as const,
  runId: "run-1",
  role,
});

const ACTOR_BOARD = {
  type: "board" as const,
  userId: "user-1",
  companyIds: ["company-1"],
  source: "local_implicit" as const,
  isInstanceAdmin: true,
};

describe("PATCH /api/companies/:companyId/shared_instructions — S1 gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockCompanyService.updateSharedInstructions.mockResolvedValue({
      id: "company-1",
      sharedInstructions: "policy",
    });
  });

  for (const role of ["general", "cto", "cmo", "ceo"]) {
    it(`rejects agent JWT with role ${role} as 403 forbidden_actor_kind`, async () => {
      mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1", role });
      const app = await createCompanyApp(ACTOR_AGENT(role));
      const res = await request(app)
        .patch("/api/companies/company-1/shared_instructions")
        .send({ sharedInstructions: "policy" });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden_actor_kind");
      expect(mockCompanyService.updateSharedInstructions).not.toHaveBeenCalled();
    });
  }

  it("accepts board users and persists via service", async () => {
    const app = await createCompanyApp(ACTOR_BOARD);
    const res = await request(app)
      .patch("/api/companies/company-1/shared_instructions")
      .send({ sharedInstructions: "founder hard policy" });
    expect(res.status).toBe(200);
    expect(mockCompanyService.updateSharedInstructions).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        newValue: "founder hard policy",
        actor: expect.objectContaining({ actorKind: "user", actorUserId: "user-1" }),
      }),
    );
  });

  it("accepts null to clear policy", async () => {
    const app = await createCompanyApp(ACTOR_BOARD);
    const res = await request(app)
      .patch("/api/companies/company-1/shared_instructions")
      .send({ sharedInstructions: null });
    expect(res.status).toBe(200);
    expect(mockCompanyService.updateSharedInstructions).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ newValue: null }),
    );
  });

  it("rejects unknown extra fields via validate", async () => {
    const app = await createCompanyApp(ACTOR_BOARD);
    const res = await request(app)
      .patch("/api/companies/company-1/shared_instructions")
      .send({ sharedInstructions: "x", extra: "nope" });
    expect(res.status).toBe(400);
    expect(mockCompanyService.updateSharedInstructions).not.toHaveBeenCalled();
  });
});

// -------- Pure helper tests (acceptance #1, #3) --------

describe("buildMergedSharedInstructions", () => {
  it("prepends policy + separator before original content", () => {
    const merged = buildMergedSharedInstructions("POLICY", "ROLE-SPECIFIC");
    expect(merged).toBe(`POLICY${SHARED_INSTRUCTIONS_SEPARATOR}ROLE-SPECIFIC`);
    expect(merged.startsWith("POLICY")).toBe(true);
    expect(merged).toContain("\n\n---\n\n");
  });
});

describe("resolveSharedInstructions", () => {
  let tmpDir: string;
  let originalPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp("/tmp/paperclip-shared-instructions-test-");
    originalPath = `${tmpDir}/AGENTS.md`;
    await fs.writeFile(originalPath, "ORIGINAL CONTENT", "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("injects merged content when policy is set and agent is not opted out (acceptance #1)", async () => {
    const outcome = await resolveSharedInstructions({
      agentId: "agent-1",
      runId: randomUUID(),
      sharedInstructions: "FOUNDER POLICY",
      optedOut: false,
      originalInstructionsFilePath: originalPath,
    });
    expect(outcome.kind).toBe("injected");
    if (outcome.kind !== "injected") return;
    const written = await fs.readFile(outcome.tempFilePath, "utf8");
    expect(written).toBe(
      `FOUNDER POLICY${SHARED_INSTRUCTIONS_SEPARATOR}ORIGINAL CONTENT`,
    );
    await fs.unlink(outcome.tempFilePath);
  });

  it("skips with no_policy when policy is null (acceptance #3)", async () => {
    const outcome = await resolveSharedInstructions({
      agentId: "agent-1",
      runId: randomUUID(),
      sharedInstructions: null,
      optedOut: false,
      originalInstructionsFilePath: originalPath,
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "no_policy" });
  });

  it("skips with no_policy when policy is empty string (acceptance #3)", async () => {
    const outcome = await resolveSharedInstructions({
      agentId: "agent-1",
      runId: randomUUID(),
      sharedInstructions: "",
      optedOut: false,
      originalInstructionsFilePath: originalPath,
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "no_policy" });
  });

  it("skips with opt_out when agent has sharedInstructionsOptOut=true (acceptance #6)", async () => {
    const outcome = await resolveSharedInstructions({
      agentId: "agent-1",
      runId: randomUUID(),
      sharedInstructions: "POLICY",
      optedOut: true,
      originalInstructionsFilePath: originalPath,
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "opt_out" });
  });

  it("skips when no original instructions file is configured", async () => {
    const outcome = await resolveSharedInstructions({
      agentId: "agent-1",
      runId: randomUUID(),
      sharedInstructions: "POLICY",
      optedOut: false,
      originalInstructionsFilePath: null,
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "no_instructions_file" });
  });

  it("uses the latest policy on subsequent calls (acceptance #2 — no restart)", async () => {
    const first = await resolveSharedInstructions({
      agentId: "agent-1",
      runId: randomUUID(),
      sharedInstructions: "POLICY V1",
      optedOut: false,
      originalInstructionsFilePath: originalPath,
    });
    expect(first.kind).toBe("injected");
    const second = await resolveSharedInstructions({
      agentId: "agent-1",
      runId: randomUUID(),
      sharedInstructions: "POLICY V2",
      optedOut: false,
      originalInstructionsFilePath: originalPath,
    });
    expect(second.kind).toBe("injected");
    if (first.kind !== "injected" || second.kind !== "injected") return;
    expect(await fs.readFile(first.tempFilePath, "utf8")).toContain("POLICY V1");
    expect(await fs.readFile(second.tempFilePath, "utf8")).toContain("POLICY V2");
    await fs.unlink(first.tempFilePath);
    await fs.unlink(second.tempFilePath);
  });
});

// -------- Service-level history persistence tests (acceptance #5) --------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shared_instructions tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService.updateSharedInstructions / listSharedInstructionsHistory", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companyService>;
  let companyId: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("shared-instructions");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = companyService(db);
  });

  afterEach(async () => {
    await db.delete(companySharedInstructionsHistory);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("writes the policy and inserts a history row capturing previous + new value", async () => {
    const first = await svc.updateSharedInstructions(companyId, {
      newValue: "policy v1",
      actor: { actorKind: "user", actorUserId: "user-1", actorIpOrSource: "127.0.0.1" },
    });
    expect(first?.sharedInstructions).toBe("policy v1");

    const second = await svc.updateSharedInstructions(companyId, {
      newValue: "policy v2",
      actor: { actorKind: "user", actorUserId: "user-2" },
    });
    expect(second?.sharedInstructions).toBe("policy v2");

    const rows = await db
      .select()
      .from(companySharedInstructionsHistory)
      .where(eq(companySharedInstructionsHistory.companyId, companyId));
    expect(rows).toHaveLength(2);
    const sortedAsc = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(sortedAsc[0]).toMatchObject({
      previousValue: null,
      newValue: "policy v1",
      actorKind: "user",
      actorUserId: "user-1",
      actorIpOrSource: "127.0.0.1",
    });
    expect(sortedAsc[1]).toMatchObject({
      previousValue: "policy v1",
      newValue: "policy v2",
      actorKind: "user",
      actorUserId: "user-2",
    });
    expect(sortedAsc[0].createdAt).toBeInstanceOf(Date);
  });

  it("clears the policy when newValue=null and records the diff", async () => {
    await svc.updateSharedInstructions(companyId, {
      newValue: "policy",
      actor: { actorKind: "user", actorUserId: "user-1" },
    });
    const cleared = await svc.updateSharedInstructions(companyId, {
      newValue: null,
      actor: { actorKind: "user", actorUserId: "user-1" },
    });
    expect(cleared?.sharedInstructions).toBeNull();

    const rows = await db
      .select()
      .from(companySharedInstructionsHistory)
      .where(eq(companySharedInstructionsHistory.companyId, companyId));
    expect(rows).toHaveLength(2);
    const last = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[1];
    expect(last.previousValue).toBe("policy");
    expect(last.newValue).toBeNull();
    expect(last.diffSummary).toBe("cleared");
  });

  it("listSharedInstructionsHistory returns rows newest-first", async () => {
    await svc.updateSharedInstructions(companyId, {
      newValue: "v1",
      actor: { actorKind: "user", actorUserId: "user-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await svc.updateSharedInstructions(companyId, {
      newValue: "v2",
      actor: { actorKind: "user", actorUserId: "user-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await svc.updateSharedInstructions(companyId, {
      newValue: "v3",
      actor: { actorKind: "user", actorUserId: "user-1" },
    });

    const result = await svc.listSharedInstructionsHistory(companyId, {});
    expect(result.items).toHaveLength(3);
    expect(result.items[0].newValue).toBe("v3");
    expect(result.items[1].newValue).toBe("v2");
    expect(result.items[2].newValue).toBe("v1");
    expect(result.nextCursor).toBeNull();
  });
});
