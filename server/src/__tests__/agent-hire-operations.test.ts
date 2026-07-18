import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentHireOperations,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  AgentHireIdempotencyConflictError,
  agentHireOperationService,
  hashAgentHireRequest,
} from "../services/agent-hire-operations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("durable agent hire operations", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-operations-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentHireOperations);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Paperclip") {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `H${id.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("allows only one concurrent worker and one agent for a scoped key", async () => {
    const companyId = await seedCompany();
    const service = agentHireOperationService(db);
    const input = {
      companyId,
      principalType: "user" as const,
      principalId: "board-user",
      idempotencyKey: "hire-concurrent",
      requestHash: hashAgentHireRequest({ name: "Builder", adapterConfig: {} }),
    };

    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => service.reserve(input)),
    );
    expect(new Set(reservations.map(({ operation }) => operation.id))).toHaveLength(1);

    const operationId = reservations[0]!.operation.id;
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => service.claim(operationId)),
    );
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);

    const winner = winners[0]!;
    await db.insert(agents).values({
      id: winner.operation.agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await service.succeed(operationId, winner.leaseToken, {
      agent: { id: winner.operation.agentId, name: "Builder" },
      approval: null,
    });

    expect(await db.select().from(agents)).toHaveLength(1);
    expect((await service.getById(operationId))?.status).toBe("succeeded");
  });

  it("queries a bounded pending operation to completion and replays its result", async () => {
    const companyId = await seedCompany();
    const service = agentHireOperationService(db);
    const input = {
      companyId,
      principalType: "user" as const,
      principalId: "board-user",
      idempotencyKey: "hire-timeout",
      requestHash: hashAgentHireRequest({ name: "Slow Builder" }),
    };
    const reservation = await service.reserve(input);
    const claim = await service.claim(reservation.operation.id);
    expect(claim).not.toBeNull();

    const completion = new Promise<void>((resolve) => {
      setTimeout(() => {
        void service.succeed(reservation.operation.id, claim!.leaseToken, {
          agent: { id: claim!.operation.agentId, name: "Slow Builder" },
          approval: null,
        }).then(() => resolve());
      }, 20);
    });

    expect((await service.waitForTerminal(reservation.operation.id, 0))?.status).toBe("pending");
    const completed = await service.waitForTerminal(reservation.operation.id, 1_000);
    await completion;
    expect(completed?.status).toBe("succeeded");

    const replay = await service.reserve(input);
    expect(replay.created).toBe(false);
    expect(replay.operation.id).toBe(reservation.operation.id);
    expect(replay.operation.response).toEqual(completed?.response);
  });

  it("rejects a materially different payload for the same scoped key", async () => {
    const companyId = await seedCompany();
    const service = agentHireOperationService(db);
    const scope = {
      companyId,
      principalType: "user" as const,
      principalId: "board-user",
      idempotencyKey: "hire-mismatch",
    };
    await service.reserve({ ...scope, requestHash: hashAgentHireRequest({ name: "Builder" }) });

    await expect(
      service.reserve({ ...scope, requestHash: hashAgentHireRequest({ name: "Different" }) }),
    ).rejects.toBeInstanceOf(AgentHireIdempotencyConflictError);
  });

  it("isolates identical keys by company and authenticated principal", async () => {
    const firstCompanyId = await seedCompany("First");
    const secondCompanyId = await seedCompany("Second");
    const service = agentHireOperationService(db);
    const common = {
      idempotencyKey: "shared-key",
      requestHash: hashAgentHireRequest({ name: "Builder" }),
    };
    const reservations = await Promise.all([
      service.reserve({
        ...common,
        companyId: firstCompanyId,
        principalType: "user",
        principalId: "user-a",
      }),
      service.reserve({
        ...common,
        companyId: firstCompanyId,
        principalType: "agent",
        principalId: randomUUID(),
      }),
      service.reserve({
        ...common,
        companyId: secondCompanyId,
        principalType: "user",
        principalId: "user-a",
      }),
    ]);

    expect(new Set(reservations.map(({ operation }) => operation.id))).toHaveLength(3);
  });

  it("never persists raw credentials in operation payloads or results", async () => {
    const companyId = await seedCompany();
    const service = agentHireOperationService(db);
    const secret = "sk-test-never-store";
    const idempotencyKey = `hire-secret-${randomUUID()}`;
    const reservation = await service.reserve({
      companyId,
      principalType: "user",
      principalId: "board-user",
      idempotencyKey,
      requestHash: hashAgentHireRequest({
        name: "Builder",
        adapterConfig: { apiKey: secret },
      }),
    });
    const claim = await service.claim(reservation.operation.id);
    await service.succeed(reservation.operation.id, claim!.leaseToken, {
      agent: {
        id: claim!.operation.agentId,
        adapterConfig: { apiKey: secret, nested: { accessToken: secret } },
      },
      approval: { payload: { credential: secret } },
    });

    const stored = await service.getById(reservation.operation.id);
    const serialized = JSON.stringify(stored);
    expect(serialized.includes(secret)).toBe(false);
    expect(serialized.includes(idempotencyKey)).toBe(false);
    expect(stored?.idempotencyKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).toContain("***REDACTED***");
    expect(stored).not.toHaveProperty("requestPayload");
  });
});
