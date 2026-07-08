import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.ts";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import {
  builtInAgentService,
  deriveBuiltInAgentStatus,
  listBuiltInAgentDefinitions,
  reconcileBuiltInAgentsOnStartup,
  validateBuiltInAgentDefinitions,
} from "../services/built-in-agents.ts";
import { readBuiltInAgentMarker, withBuiltInAgentMarker } from "../services/built-in-agent-metadata.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres built-in agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("built-in agents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-built-in-agents-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(budgetPolicies);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("validates the static registry and rejects invalid definitions", () => {
    expect(listBuiltInAgentDefinitions().map((definition) => definition.key).sort()).toEqual(["briefs", "learning"]);
    expect(() => validateBuiltInAgentDefinitions([
      {
        key: "briefs",
        displayName: "Briefs Agent",
        featureKeys: ["briefs"],
        shortPurpose: "One",
        defaultInstructions: "Do work",
        defaultRole: "general",
      },
      {
        key: "briefs",
        displayName: "Duplicate",
        featureKeys: ["duplicate"],
        shortPurpose: "Two",
        defaultInstructions: "Do work",
        defaultRole: "general",
      },
    ])).toThrow("Duplicate built-in agent key");
    expect(() => validateBuiltInAgentDefinitions([
      {
        key: "Bad Key",
        displayName: "Bad",
        featureKeys: ["bad"],
        shortPurpose: "Bad",
        defaultInstructions: "Bad",
        defaultRole: "general",
      },
    ])).toThrow("Invalid built-in agent key");
  });

  it("lazily provisions one agent per company/key and updates the same row on setup", async () => {
    const companyId = await seedCompany();
    const svc = builtInAgentService(db);

    const created = await svc.ensure(companyId, "briefs");
    expect(created.status).toBe("needs_setup");
    expect(created.agentId).toBeTruthy();
    expect(created.agent).toMatchObject({
      companyId,
      name: "Briefs Agent",
      adapterConfig: {},
      status: "idle",
    });
    expect(readBuiltInAgentMarker(created.agent?.metadata)).toEqual({
      key: "briefs",
      featureKeys: ["briefs"],
    });

    const configured = await svc.ensure(companyId, "briefs", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });
    expect(configured.status).toBe("ready");
    expect(configured.agentId).toBe(created.agentId);
    expect(configured.agent).toMatchObject({
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });

    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("routes policy-gated built-in provisioning through a pending hire approval", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);

    const result = await builtIns.provision(companyId, "briefs", {
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      budgetMonthlyCents: 5000,
    }, { requestedByUserId: "board-user" });

    expect(result.state).toMatchObject({
      status: "pending_approval",
      agent: {
        companyId,
        name: "Briefs Agent",
        status: "pending_approval",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        budgetMonthlyCents: 5000,
      },
    });
    expect(result.approval).toMatchObject({
      companyId,
      type: "hire_agent",
      status: "pending",
      requestedByUserId: "board-user",
      requestedByAgentId: null,
      payload: {
        name: "Briefs Agent",
        role: "general",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        budgetMonthlyCents: 5000,
        agentId: result.state.agentId,
        sourceBuiltInAgentKey: "briefs",
        featureKeys: ["briefs"],
      },
    });

    const rowsBeforeApproval = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rowsBeforeApproval).toHaveLength(1);
    expect(rowsBeforeApproval[0]).toMatchObject({ status: "pending_approval" });

    await expect(builtIns.requireBuiltInAgent(companyId, "briefs")).rejects.toMatchObject({
      status: 412,
      details: { code: "built_in_agent_not_configured", status: "pending_approval" },
    });

    await expect(agentService(db).update(result.state.agentId!, {
      adapterType: "process",
      adapterConfig: { command: "echo tampered" },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: result.state.agentId,
        fields: ["adapterConfig"],
      },
    });

    await expect(builtIns.provision(companyId, "briefs", {
      budgetMonthlyCents: 7500,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "built_in_agent_pending_approval",
        key: "briefs",
        agentId: result.state.agentId,
      },
    });

    await db
      .update(agents)
      .set({
        adapterType: "process",
        adapterConfig: { command: "echo tampered" },
      })
      .where(eq(agents.id, result.state.agentId!));

    await approvalService(db).approve(result.approval!.id, "board-user", "Approved built-in agent");

    await expect(builtIns.get(companyId, "briefs")).resolves.toMatchObject({
      status: "ready",
      agentId: result.state.agentId,
      agent: { status: "idle", adapterType: "process", adapterConfig: { command: "echo safe" }, budgetMonthlyCents: 5000 },
    });
  });

  it("blocks policy-gated built-in reconfiguration instead of applying adapter overrides immediately", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);
    const ready = await builtIns.ensure(companyId, "briefs", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });

    await expect(builtIns.provision(companyId, "briefs", {
      adapterType: "process",
      adapterConfig: { command: "echo bypass" },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "built_in_agent_reconfiguration_requires_approval",
        key: "briefs",
        agentId: ready.agentId,
      },
    });

    await expect(builtIns.get(companyId, "briefs")).resolves.toMatchObject({
      status: "ready",
      agentId: ready.agentId,
      agent: { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } },
    });
  });

  it("rejects adapter types outside the built-in definition allowlist", async () => {
    const companyId = await seedCompany();

    await expect(builtInAgentService(db).ensure(companyId, "briefs", {
      adapterType: "http",
      adapterConfig: { url: "https://example.test/webhook" },
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "built_in_agent_adapter_not_allowed",
        key: "briefs",
        allowedAdapterTypes: ["codex_local", "claude_local", "gemini_local", "opencode_local", "process"],
      },
    });
  });

  it("recovers an orphaned marked row instead of creating a duplicate", async () => {
    const companyId = await seedCompany();
    const orphanId = randomUUID();
    await db.insert(agents).values({
      id: orphanId,
      companyId,
      name: "Old Briefs",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker({ source: "orphan" }, { key: "briefs", featureKeys: ["briefs"] }),
    });

    const state = await builtInAgentService(db).ensure(companyId, "briefs");

    expect(state.status).toBe("ready");
    expect(state.agentId).toBe(orphanId);
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("derives not_provisioned, needs_setup, ready, and paused states", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);

    await expect(builtIns.get(companyId, "learning")).resolves.toMatchObject({ status: "not_provisioned" });

    const needsSetup = await builtIns.ensure(companyId, "learning");
    expect(needsSetup.status).toBe("needs_setup");
    expect(deriveBuiltInAgentStatus(needsSetup.agent)).toBe("needs_setup");

    const ready = await builtIns.ensure(companyId, "learning", {
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4" },
    });
    expect(ready.status).toBe("ready");

    await agentService(db).pause(ready.agentId!, "manual");
    await expect(builtIns.get(companyId, "learning")).resolves.toMatchObject({
      status: "paused",
      agentId: ready.agentId,
      pauseReason: "manual",
    });
  });

  it("requires configured built-ins with typed precondition failures and paused warnings", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);

    await expect(builtIns.requireBuiltInAgent(companyId, "briefs")).rejects.toMatchObject({
      status: 412,
      details: {
        code: "built_in_agent_not_configured",
        key: "briefs",
        status: "not_provisioned",
        agentId: null,
      },
    });

    const needsSetup = await builtIns.ensure(companyId, "briefs");
    await expect(builtIns.requireBuiltInAgent(companyId, "briefs")).rejects.toMatchObject({
      status: 412,
      details: {
        code: "built_in_agent_not_configured",
        key: "briefs",
        status: "needs_setup",
        agentId: needsSetup.agentId,
      },
    });

    const ready = await builtIns.ensure(companyId, "briefs", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });
    await expect(builtIns.requireBuiltInAgent(companyId, "briefs")).resolves.toMatchObject({
      agent: { id: ready.agentId },
      warning: null,
    });

    await agentService(db).pause(ready.agentId!, "maintenance");
    await expect(builtIns.requireBuiltInAgent(companyId, "briefs")).resolves.toMatchObject({
      agent: { id: ready.agentId },
      warning: {
        code: "built_in_agent_paused",
        key: "briefs",
        agentId: ready.agentId,
        pauseReason: "maintenance",
      },
    });
  });

  it("resets marked agents back to registry display defaults without replacing adapter setup", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);
    const ready = await builtIns.ensure(companyId, "briefs", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });

    await agentService(db).update(ready.agentId!, {
      name: "Custom Briefs",
      role: "engineer",
      title: "Custom",
      capabilities: "Custom purpose",
    });

    const reset = await builtIns.reset(companyId, "briefs");

    expect(reset).toMatchObject({
      status: "ready",
      agentId: ready.agentId,
      agent: {
        name: "Briefs Agent",
        role: "general",
        title: null,
        capabilities: "Prepares concise operational briefs for the board and agent company.",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
      },
    });
  });

  it("blocks deleting a built-in agent", async () => {
    const companyId = await seedCompany();
    const state = await builtInAgentService(db).ensure(companyId, "briefs");

    await expect(agentService(db).remove(state.agentId!)).rejects.toMatchObject({
      status: 409,
      details: {
        code: "built_in_agent_undeletable",
        key: "briefs",
      },
    });
  });

  it("prevents direct marker add, remove, or mutation", async () => {
    const companyId = await seedCompany();
    const builtIn = await builtInAgentService(db).ensure(companyId, "briefs");
    const normal = await agentService(db).create(companyId, {
      name: "Normal",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });

    await expect(agentService(db).create(companyId, {
      name: "Spoof",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker({}, { key: "briefs", featureKeys: ["briefs"] }),
    })).rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });

    await expect(agentService(db).update(normal.id, {
      metadata: withBuiltInAgentMarker({}, { key: "briefs", featureKeys: ["briefs"] }),
    })).rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });

    await expect(agentService(db).update(builtIn.agentId!, {
      metadata: { other: "metadata" },
    })).rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });

    await expect(agentService(db).update(builtIn.agentId!, {
      metadata: withBuiltInAgentMarker({}, { key: "learning", featureKeys: ["learning"] }),
    })).rejects.toMatchObject({ status: 409, details: { code: "built_in_agent_marker_readonly" } });

    await expect(agentService(db).update(builtIn.agentId!, {
      metadata: withBuiltInAgentMarker({ note: "allowed" }, { key: "briefs", featureKeys: ["briefs"] }),
    })).resolves.toMatchObject({
      id: builtIn.agentId,
      metadata: {
        note: "allowed",
        paperclipBuiltInAgent: { key: "briefs", featureKeys: ["briefs"] },
      },
    });
  });

  it("repairs display/default drift for marked rows during startup reconciliation", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Old Name",
      role: "engineer",
      title: "Old title",
      capabilities: "Old purpose",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker({}, { key: "briefs", featureKeys: ["old-briefs"] }),
    });

    const result = await reconcileBuiltInAgentsOnStartup(db);
    expect(result).toMatchObject({ scanned: 1, reconciled: 1, unknown: 0, duplicates: 0 });

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row).toMatchObject({
      name: "Briefs Agent",
      role: "general",
      title: null,
      capabilities: "Prepares concise operational briefs for the board and agent company.",
    });
    expect(readBuiltInAgentMarker(row?.metadata)).toEqual({ key: "briefs", featureKeys: ["briefs"] });
  });

  it("reports duplicate active instances for a company/key", async () => {
    const companyId = await seedCompany();
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId,
        name: "Briefs One",
        role: "general",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
        metadata: withBuiltInAgentMarker({}, { key: "briefs", featureKeys: ["briefs"] }),
      },
      {
        id: randomUUID(),
        companyId,
        name: "Briefs Two",
        role: "general",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
        metadata: withBuiltInAgentMarker({}, { key: "briefs", featureKeys: ["briefs"] }),
      },
    ]);

    await expect(builtInAgentService(db).ensure(companyId, "briefs")).rejects.toMatchObject({
      status: 409,
      details: {
        code: "built_in_agent_duplicate_instance",
        key: "briefs",
      },
    } satisfies Partial<HttpError>);
  });
});
