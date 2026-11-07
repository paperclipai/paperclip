import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function manifestWithCapabilities(capabilities: string[]) {
  return { id: "model-capacity", capabilities } as any;
}

describe("agents.getQueuedRunCounts capability gating", () => {
  const validator = pluginCapabilityValidator();

  it("denies the operation without agents.queued_counts.read (standard 403)", () => {
    const result = validator.checkOperation(
      manifestWithCapabilities([]),
      "agents.getQueuedRunCounts",
    );
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["agents.queued_counts.read"]);

    const err = (() => {
      try {
        validator.assertOperation(
          manifestWithCapabilities([]),
          "agents.getQueuedRunCounts",
        );
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toMatchObject({ status: 403 });
  });

  it("is NOT satisfied by agents.read alone (no bundling)", () => {
    const manifest = manifestWithCapabilities([
      "agents.read",
      "issues.read",
      "events.subscribe",
    ]);
    const result = validator.checkOperation(
      manifest,
      "agents.getQueuedRunCounts",
    );
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["agents.queued_counts.read"]);
    expect(() =>
      validator.assertOperation(manifest, "agents.getQueuedRunCounts"),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it("allows the operation with agents.queued_counts.read", () => {
    const manifest = manifestWithCapabilities([
      "agents.read",
      "agents.queued_counts.read",
    ]);
    const result = validator.checkOperation(
      manifest,
      "agents.getQueuedRunCounts",
    );
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(() =>
      validator.assertOperation(manifest, "agents.getQueuedRunCounts"),
    ).not.toThrow();
    expect(
      validator.getRequiredCapabilities("agents.getQueuedRunCounts"),
    ).toEqual(["agents.queued_counts.read"]);
  });

  it("rejects bridge calls without the capability and never reaches the service", async () => {
    const getQueuedRunCounts = vi.fn();
    const handlers = createHostClientHandlers({
      pluginId: "queued-counts-plugin",
      capabilities: ["agents.read"],
      services: { agents: { getQueuedRunCounts } } as any,
    });

    await expect(
      handlers["agents.getQueuedRunCounts"](
        { companyId: "company-1" },
        { invocationScope: { companyId: "company-1" } },
      ),
    ).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
    expect(getQueuedRunCounts).not.toHaveBeenCalled();
  });

  it("routes bridge calls to the service with the capability declared", async () => {
    const getQueuedRunCounts = vi
      .fn()
      .mockResolvedValue([{ agentId: "agent-1", queued: 2 }]);
    const handlers = createHostClientHandlers({
      pluginId: "queued-counts-plugin",
      capabilities: ["agents.queued_counts.read"],
      services: { agents: { getQueuedRunCounts } } as any,
    });

    await expect(
      handlers["agents.getQueuedRunCounts"](
        { companyId: "company-1" },
        { invocationScope: { companyId: "company-1" } },
      ),
    ).resolves.toEqual([{ agentId: "agent-1", queued: 2 }]);
    expect(getQueuedRunCounts).toHaveBeenCalledWith({ companyId: "company-1" });
  });
});

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queued-run-count aggregate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agents.getQueuedRunCounts host aggregate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-plugin-queued-counts-",
    );
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Engineer") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, status: string) {
    const [row] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status, invocationSource: "assignment" })
      .returning({ id: heartbeatRuns.id });
    return row!.id;
  }

  function services() {
    return buildHostServices(
      db,
      "plugin-record-id",
      "paperclip.queued-counts-test",
      createEventBusStub(),
    );
  }

  function byAgentId(rows: Array<{ agentId: string; queued: number }>) {
    return [...rows].sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  it("returns GROUP BY integer counts with only agentId+queued keys", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "Agent A");
    const agentB = await seedAgent(companyId, "Agent B");
    await seedAgent(companyId, "Agent Idle");
    await seedRun(companyId, agentA, "queued");
    await seedRun(companyId, agentA, "queued");
    await seedRun(companyId, agentA, "queued");
    await seedRun(companyId, agentB, "queued");

    const svc = services();
    try {
      const rows = await svc.agents.getQueuedRunCounts({ companyId });
      expect(byAgentId(rows)).toEqual(
        byAgentId([
          { agentId: agentA, queued: 3 },
          { agentId: agentB, queued: 1 },
        ]),
      );
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["agentId", "queued"]);
        expect(Number.isInteger(row.queued)).toBe(true);
      }
    } finally {
      svc.dispose();
    }
  });

  it("counts status='queued' ONLY — retry/running/terminal excluded", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const excluded = [
      "scheduled_retry",
      "running",
      "succeeded",
      "interrupted",
      "failed",
      "cancelled",
      "timed_out",
    ];
    for (const status of excluded) {
      await seedRun(companyId, agentId, status);
    }
    await seedRun(companyId, agentId, "queued");
    await seedRun(companyId, agentId, "queued");

    const svc = services();
    try {
      await expect(
        svc.agents.getQueuedRunCounts({ companyId }),
      ).resolves.toEqual([{ agentId, queued: 2 }]);
    } finally {
      svc.dispose();
    }
  });

  it("isolates by company: A sees only A counts, B rows invisible", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const agentA = await seedAgent(companyA, "Agent A");
    const agentB = await seedAgent(companyB, "Agent B");
    await seedRun(companyA, agentA, "queued");
    await seedRun(companyA, agentA, "queued");
    await seedRun(companyB, agentB, "queued");
    await seedRun(companyB, agentB, "queued");
    await seedRun(companyB, agentB, "queued");

    const svc = services();
    try {
      await expect(
        svc.agents.getQueuedRunCounts({ companyId: companyA }),
      ).resolves.toEqual([{ agentId: agentA, queued: 2 }]);
      await expect(
        svc.agents.getQueuedRunCounts({ companyId: companyB }),
      ).resolves.toEqual([{ agentId: agentB, queued: 3 }]);
    } finally {
      svc.dispose();
    }
  });

  it("drops rows whose agent belongs to another company (join on id+company)", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const agentA = await seedAgent(companyA, "Agent A");
    const agentB = await seedAgent(companyB, "Agent B");
    await seedRun(companyA, agentA, "queued");
    await seedRun(companyA, agentB, "queued");

    const svc = services();
    try {
      await expect(
        svc.agents.getQueuedRunCounts({ companyId: companyA }),
      ).resolves.toEqual([{ agentId: agentA, queued: 1 }]);
    } finally {
      svc.dispose();
    }
  });

  it("drops queued rows filed under another company when the agent matches (run-side company predicate)", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const agentA = await seedAgent(companyA, "Agent A");
    await seedRun(companyA, agentA, "queued");
    await seedRun(companyB, agentA, "queued");

    const svc = services();
    try {
      await expect(
        svc.agents.getQueuedRunCounts({ companyId: companyA }),
      ).resolves.toEqual([{ agentId: agentA, queued: 1 }]);
    } finally {
      svc.dispose();
    }
  });

  it("returns [] for an unknown company with no existence oracle", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedRun(companyId, agentId, "queued");

    const svc = services();
    try {
      await expect(
        svc.agents.getQueuedRunCounts({ companyId: randomUUID() }),
      ).resolves.toEqual([]);
      const emptyCompany = await seedCompany("Empty");
      await expect(
        svc.agents.getQueuedRunCounts({ companyId: emptyCompany }),
      ).resolves.toEqual([]);
    } finally {
      svc.dispose();
    }
  });

  it.each([[undefined], [null], [""], ["   "]])(
    "rejects missing/empty companyId (%j) with no query executed",
    async (companyId) => {
      const selectSpy = vi.spyOn(db, "select");
      const svc = services();
      try {
        await expect(
          svc.agents.getQueuedRunCounts({
            companyId: companyId as unknown as string,
          }),
        ).rejects.toThrow("companyId is required for this operation");
        expect(selectSpy).not.toHaveBeenCalled();
      } finally {
        svc.dispose();
        selectSpy.mockRestore();
      }
    },
  );

  it("returns ALL queued agents past 100 rows (121-row no-truncation regression)", async () => {
    const companyId = await seedCompany();
    const agentIds: string[] = [];
    for (let i = 0; i < 121; i += 1) {
      agentIds.push(randomUUID());
    }
    await db.insert(agents).values(
      agentIds.map((agentId, i) => ({
        id: agentId,
        companyId,
        name: `Load Agent ${i}`,
        role: "engineer" as const,
        status: "idle" as const,
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(heartbeatRuns).values(
      agentIds.map((agentId) => ({
        companyId,
        agentId,
        status: "queued",
        invocationSource: "assignment",
      })),
    );

    const svc = services();
    try {
      const rows = await svc.agents.getQueuedRunCounts({ companyId });
      expect(rows).toHaveLength(121);
      expect(new Set(rows.map((row) => row.agentId))).toEqual(
        new Set(agentIds),
      );
      for (const row of rows) {
        expect(row).toEqual({ agentId: row.agentId, queued: 1 });
      }
    } finally {
      svc.dispose();
    }
  });

  it("sanitizes upstream DB errors (no raw host text leaks)", async () => {
    const svc = services();
    try {
      const err = await svc.agents
        .getQueuedRunCounts({ companyId: "not-a-uuid" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Failed to read queued run counts");
      expect((err as Error).message).not.toMatch(
        /uuid|syntax|postgres|pg-|22P02/i,
      );
    } finally {
      svc.dispose();
    }
  });

  it("does not confuse queued counts with other companies sharing agent names", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const agentA = await seedAgent(companyA, "Engineer");
    const agentB = await seedAgent(companyB, "Engineer");
    await seedRun(companyA, agentA, "queued");
    await seedRun(companyB, agentB, "queued");
    await seedRun(companyB, agentB, "queued");

    const svc = services();
    try {
      const rowsA = await svc.agents.getQueuedRunCounts({
        companyId: companyA,
      });
      expect(rowsA).toEqual([{ agentId: agentA, queued: 1 }]);
      expect(rowsA[0]?.agentId).not.toBe(agentB);
    } finally {
      svc.dispose();
    }
  });
});
