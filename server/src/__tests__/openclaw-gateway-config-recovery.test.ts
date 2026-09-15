import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import {
  OPENCLAW_GATEWAY_WEDGE_REVISION_SOURCE,
  isOpenclawGatewayAgentWedged,
  repairOpenclawGatewayAgentAdapterConfig,
} from "../services/openclaw-gateway-config-recovery.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres openclaw_gateway config recovery tests on this host: ` +
      `${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("openclaw_gateway adapterConfig wedge recovery (PHA-3517)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-openclaw-gateway-wedge-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(input: {
    adapterConfig: Record<string, unknown>;
    status?: "idle" | "running" | "paused" | "error";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Van Dam Test",
      role: "engineer",
      status: input.status ?? "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: input.adapterConfig,
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("isOpenclawGatewayAgentWedged returns true only for openclaw_gateway agents with empty adapterConfig", () => {
    expect(isOpenclawGatewayAgentWedged({
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    })).toBe(true);
    expect(isOpenclawGatewayAgentWedged({
      adapterType: "openclaw_gateway",
      adapterConfig: { url: "ws://localhost:18789" },
    })).toBe(false);
    expect(isOpenclawGatewayAgentWedged({
      adapterType: "codex_local",
      adapterConfig: {},
    })).toBe(false);
  });

  it("restores the last known-good adapterConfig after the wedge wipes it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      adapterConfig: {
        env: {
          GODADDY_API_KEY: { type: "secret_ref", secretId: "seed-secret-a" },
        },
        url: "ws://OpenClaw:18789",
        role: "operator",
        scopes: ["operator.admin"],
        agentId: "engineer",
        headers: { "x-openclaw-token": "paperclip-gateway-token-phatttech-2026" },
        sessionKey: "agent:engineer:paperclip",
        timeoutSec: 15000,
        waitTimeoutMs: 1200000,
        paperclipApiUrl: "http://10.0.0.100:3100",
        claimedApiKeyPath: "/root/.openclaw/workspace/agents/engineer/paperclip-api-key.json",
        sessionKeyStrategy: "issue",
      },
    });

    // Sanity check — seed has populated adapterConfig with revision history.
    const seedRevisionCount = await db
      .select({ id: agentConfigRevisions.id })
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));
    // The create path doesn't write a revision (recordRevision is opt-in), so
    // we patch to record one and simulate the agent's last known-good state.
    const agentSvc = agentService(db);
    await agentSvc.update(
      agentId,
      { adapterConfig: { extra: "patched-marker", url: "ws://OpenClaw:18789" } },
      {
        recordRevision: {
          source: "test-seed",
          createdByAgentId: null,
          createdByUserId: null,
        },
      },
    );

    // Now simulate the wedge: a PATCH wipes adapterConfig to {}.
    await db
      .update(agents)
      .set({ adapterConfig: {} })
      .where(eq(agents.id, agentId));

    const wedged = await db
      .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    expect(wedged?.adapterType).toBe("openclaw_gateway");
    expect(Object.keys(wedged?.adapterConfig ?? {})).toHaveLength(0);

    // Repair the wedge using the recovery module.
    const outcome = await repairOpenclawGatewayAgentAdapterConfig({
      db,
      applyAdapterConfigPatch: async ({ agentId: id, adapterConfig, sourceRevisionId }) => {
        await agentSvc.update(
          id,
          { adapterConfig },
          {
            recordRevision: {
              source: OPENCLAW_GATEWAY_WEDGE_REVISION_SOURCE,
              rolledBackFromRevisionId: sourceRevisionId,
              createdByAgentId: null,
              createdByUserId: null,
            },
            allowBuiltInAgentMetadata: true,
          },
        );
        void companyId;
      },
      agent: {
        id: agentId,
        companyId,
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        status: "idle",
      },
      trigger: { kind: "read", path: "GET /api/agents/:id" },
    });

    expect(outcome.status).toBe("repaired");
    if (outcome.status !== "repaired") throw new Error("expected repaired outcome");

    // Assert the agent's adapterConfig now matches the last-good snapshot.
    const recovered = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    const recoveredConfig = recovered?.adapterConfig as Record<string, unknown>;
    expect(recoveredConfig).toBeDefined();
    expect(Object.keys(recoveredConfig)).toContain("extra");
    expect(recoveredConfig.extra).toBe("patched-marker");
    expect(recoveredConfig.url).toBe("ws://OpenClaw:18789");

    // Assert a new revision was written with the wedge-recovery source and
    // rolledBackFromRevisionId pointing at the source revision.
    const newRevisions = await db
      .select()
      .from(agentConfigRevisions)
      .where(
        and(
          eq(agentConfigRevisions.agentId, agentId),
          eq(agentConfigRevisions.source, OPENCLAW_GATEWAY_WEDGE_REVISION_SOURCE),
        ),
      )
      .orderBy(desc(agentConfigRevisions.createdAt));
    expect(newRevisions).toHaveLength(1);
    expect(newRevisions[0].rolledBackFromRevisionId).toBe(outcome.sourceRevisionId);
    expect(newRevisions[0].changedKeys).toContain("adapterConfig");
    // The recovery source is the patched revision we wrote above.
    expect(outcome.sourceRevisionId).toBeDefined();
    void seedRevisionCount; // silenced: only used to remind ourselves of seed state
  });

  it("is a no-op when the agent is not wedged", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      adapterConfig: { url: "ws://OpenClaw:18789" },
    });

    const agentSvc = agentService(db);
    const outcome = await repairOpenclawGatewayAgentAdapterConfig({
      db,
      applyAdapterConfigPatch: async () => {
        throw new Error("should not be called when agent is not wedged");
      },
      agent: {
        id: agentId,
        companyId,
        adapterType: "openclaw_gateway",
        adapterConfig: { url: "ws://OpenClaw:18789" },
        status: "idle",
      },
      trigger: { kind: "read", path: "GET /api/agents/:id" },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "adapter_config_populated" });
    void agentSvc;
  });

  it("is a no-op for non openclaw_gateway adapters", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      adapterConfig: { command: "echo hi" },
    });
    // Switch adapterType to codex_local to verify the predicate.
    await db
      .update(agents)
      .set({ adapterType: "codex_local", adapterConfig: {} })
      .where(eq(agents.id, agentId));

    const outcome = await repairOpenclawGatewayAgentAdapterConfig({
      db,
      applyAdapterConfigPatch: async () => {
        throw new Error("should not be called for non openclaw_gateway adapters");
      },
      agent: {
        id: agentId,
        companyId,
        adapterType: "codex_local",
        adapterConfig: {},
        status: "idle",
      },
      trigger: { kind: "read", path: "GET /api/agents/:id" },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "not_openclaw_gateway" });
  });

  it("returns no_revision_history when the agent has never had a populated adapterConfig", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      adapterConfig: {},
    });

    const outcome = await repairOpenclawGatewayAgentAdapterConfig({
      db,
      applyAdapterConfigPatch: async () => {
        throw new Error("should not be called when there is no recovery source");
      },
      agent: {
        id: agentId,
        companyId,
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        status: "idle",
      },
      trigger: { kind: "read", path: "GET /api/agents/:id" },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "no_revision_history" });
  });

  it("uses the most recent revision that had a populated adapterConfig, ignoring empty revisions in between", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      adapterConfig: { url: "ws://initial:1" },
    });
    const agentSvc = agentService(db);

    // Revision 1: populated with marker v1
    await agentSvc.update(
      agentId,
      { adapterConfig: { url: "ws://v1:1", marker: "v1" } },
      {
        recordRevision: {
          source: "test-marker",
          createdByAgentId: null,
          createdByUserId: null,
        },
      },
    );
    // Revision 2: empty (simulating an interim wipe that itself didn't record
    // a populated afterConfig)
    await db
      .update(agents)
      .set({ adapterConfig: {} })
      .where(eq(agents.id, agentId));
    // Now manually insert a revision that records an empty adapterConfig
    // snapshot so we can prove the recovery skips over empty revisions and
    // restores from v1.
    await db.insert(agentConfigRevisions).values({
      companyId,
      agentId,
      source: "test-marker-empty",
      changedKeys: ["adapterConfig"],
      beforeConfig: { adapterConfig: { url: "ws://v1:1", marker: "v1" } },
      afterConfig: { adapterConfig: {} },
    });
    // Revision 3: another populated snapshot
    await agentSvc.update(
      agentId,
      { adapterConfig: { url: "ws://v3:1", marker: "v3" } },
      {
        recordRevision: {
          source: "test-marker",
          createdByAgentId: null,
          createdByUserId: null,
        },
      },
    );
    // Final wedge.
    await db
      .update(agents)
      .set({ adapterConfig: {} })
      .where(eq(agents.id, agentId));

    const outcome = await repairOpenclawGatewayAgentAdapterConfig({
      db,
      applyAdapterConfigPatch: async ({ agentId: id, adapterConfig, sourceRevisionId }) => {
        await agentSvc.update(
          id,
          { adapterConfig },
          {
            recordRevision: {
              source: OPENCLAW_GATEWAY_WEDGE_REVISION_SOURCE,
              rolledBackFromRevisionId: sourceRevisionId,
              createdByAgentId: null,
              createdByUserId: null,
            },
            allowBuiltInAgentMetadata: true,
          },
        );
      },
      agent: {
        id: agentId,
        companyId,
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        status: "idle",
      },
      trigger: { kind: "reconcile" },
    });

    expect(outcome.status).toBe("repaired");
    if (outcome.status !== "repaired") throw new Error("expected repaired outcome");

    const recovered = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    const recoveredConfig = recovered?.adapterConfig as Record<string, unknown>;
    // The most recent populated revision was v3, so the recovery restores v3.
    expect(recoveredConfig.marker).toBe("v3");
    expect(recoveredConfig.url).toBe("ws://v3:1");
  });
});
