import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  budgetPolicies,
  builtInManagedResources,
  companies,
  companyMemberships,
  companySkillVersions,
  companySkills,
  createDb,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.ts";
import { agentInstructionsService } from "../services/agent-instructions.ts";
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
import { issueThreadInteractionService } from "../services/issue-thread-interactions.ts";

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
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(builtInManagedResources);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
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

  async function permissionKeysForAgent(agentId: string) {
    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, agentId));
    return grants.map((grant) => grant.permissionKey).sort();
  }

  async function seedCompany(options: { requireApproval?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: options.requireApproval ?? true,
    });
    return companyId;
  }

  it("validates the static registry and rejects invalid definitions", () => {
    expect(listBuiltInAgentDefinitions().map((definition) => definition.key).sort()).toEqual(["briefs", "learning", "reflection-coach"]);
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

  it("auto-provisions a paused Reflection Coach bundle with skill sync and a disabled routine", async () => {
    const companyId = await seedCompany({ requireApproval: false });
    const root = await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4", apiKey: "do-not-copy" },
      runtimeConfig: {},
      permissions: {},
    });

    const result = await reconcileBuiltInAgentsOnStartup(db);
    expect(result.autoEnsured).toBeGreaterThanOrEqual(1);
    expect(result.defaultGrantsEnsured).toBeGreaterThanOrEqual(4);

    const rootGrantKeys = await permissionKeysForAgent(root.id);
    expect(rootGrantKeys).toEqual(expect.arrayContaining(["agents:configure", "skills:create"]));
    expect(rootGrantKeys).not.toContain("agents:suggest-changes");
    expect(rootGrantKeys).not.toContain("skills:suggest-changes");

    const state = await builtInAgentService(db).get(companyId, "reflection-coach");
    expect(state).toMatchObject({
      status: "paused",
      agent: {
        companyId,
        name: "Reflection Coach",
        role: "general",
        title: "Reflection Coach",
        icon: "eye",
        adapterType: "codex_local",
        permissions: {
          canCreateAgents: false,
          canCreateSkills: false,
        },
      },
    });
    expect(state.agent?.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsEntryFile: "AGENTS.md",
    });
    expect(state.agent?.adapterConfig).not.toMatchObject({ model: "gpt-5.4", apiKey: "do-not-copy" });
    expect(state.resources.map((resource) => [resource.resourceKind, resource.stockStatus])).toEqual([
      ["instructions", "stock_current"],
      ["skill", "stock_current"],
      ["routine", "stock_current"],
    ]);
    expect(state.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      resourceId: expect.any(String),
      scheduleEnabled: false,
    });

    const agentRows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(agentRows.filter((row) => readBuiltInAgentMarker(row.metadata)?.key === "reflection-coach")).toHaveLength(1);

    const [skill] = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.key, "paperclipai/bundled/paperclip-operations/reflection-coach"));
    expect(skill).toMatchObject({
      key: "paperclipai/bundled/paperclip-operations/reflection-coach",
      slug: "reflection-coach",
    });
    expect(readPaperclipSkillSyncPreference(state.agent!.adapterConfig as Record<string, unknown>).desiredSkills).toContain(
      "paperclipai/bundled/paperclip-operations/reflection-coach",
    );

    const [routine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(routine).toMatchObject({
      title: "Review recent agent trajectories for coaching proposals",
      status: "paused",
      assigneeAgentId: state.agentId,
    });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
    expect(trigger).toMatchObject({
      kind: "schedule",
      enabled: false,
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });
    const coachGrantKeys = await permissionKeysForAgent(state.agentId!);
    expect(coachGrantKeys).toEqual(expect.arrayContaining(["agents:suggest-changes", "skills:suggest-changes"]));
    expect(coachGrantKeys).not.toContain("agents:configure");
    expect(coachGrantKeys).not.toContain("skills:create");
  });

  it("recreates missing managed resource bindings idempotently during concurrent reconcile", async () => {
    const companyId = await seedCompany({ requireApproval: false });
    await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const builtIns = builtInAgentService(db);
    await builtIns.ensure(companyId, "reflection-coach");
    await db.delete(builtInManagedResources).where(eq(builtInManagedResources.companyId, companyId));

    const states = await Promise.all([
      builtIns.ensure(companyId, "reflection-coach"),
      builtIns.ensure(companyId, "reflection-coach"),
    ]);

    expect(states).toHaveLength(2);
    for (const state of states) {
      expect(state.resources.map((resource) => [resource.resourceKind, resource.stockStatus])).toEqual([
        ["instructions", "stock_current"],
        ["skill", "stock_current"],
        ["routine", "stock_current"],
      ]);
    }
    const bindings = await db
      .select()
      .from(builtInManagedResources)
      .where(eq(builtInManagedResources.companyId, companyId));
    expect(bindings).toHaveLength(3);
    expect(new Set(bindings.map((binding) =>
      `${binding.bundleKey}:${binding.resourceKind}:${binding.resourceKey}`
    )).size).toBe(3);
  });

  it("preserves new-agent approval gates during automatic Reflection Coach provisioning", async () => {
    const companyId = await seedCompany({ requireApproval: true });
    const mutationPolicy = {
      requiresDisplayedDiff: true,
      requiresAcceptedTaskInteraction: true,
      applyInSeparateFollowUpRun: true,
    };

    const result = await reconcileBuiltInAgentsOnStartup(db);

    expect(result).toMatchObject({
      autoEnsured: 1,
      pendingApprovals: 1,
    });
    const state = await builtInAgentService(db).get(companyId, "reflection-coach");
    expect(state).toMatchObject({
      status: "pending_approval",
      agent: {
        companyId,
        name: "Reflection Coach",
        status: "pending_approval",
        budgetMonthlyCents: 0,
        permissions: {
          builtInMutationPolicy: mutationPolicy,
        },
      },
    });
    expect(state.resources.map((resource) => resource.stockStatus)).toEqual(["missing", "missing", "missing"]);

    const [approval] = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(approval).toMatchObject({
      type: "hire_agent",
      status: "pending",
      payload: {
        agentId: state.agentId,
        sourceBuiltInAgentKey: "reflection-coach",
        featureKeys: ["reflection-coach"],
        permissions: expect.objectContaining({
          builtInMutationPolicy: mutationPolicy,
        }),
      },
    });

    await approvalService(db).approve(approval.id, "board-user", "Approved Reflection Coach");
    await expect(builtInAgentService(db).get(companyId, "reflection-coach")).resolves.toMatchObject({
      agent: {
        permissions: {
          builtInMutationPolicy: mutationPolicy,
        },
      },
    });

    await reconcileBuiltInAgentsOnStartup(db);
    const agentRows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(agentRows.filter((row) => readBuiltInAgentMarker(row.metadata)?.key === "reflection-coach")).toHaveLength(1);
    const approvalRows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(approvalRows).toHaveLength(1);
  });

  it("preserves Reflection Coach instruction drift on reconcile and restores it on reset", async () => {
    const companyId = await seedCompany();
    const builtIns = builtInAgentService(db);
    const created = await builtIns.ensure(companyId, "reflection-coach");
    const instructions = agentInstructionsService();

    await instructions.writeFile(created.agent!, "AGENTS.md", "# Custom Reflection Coach\n\nOperator edit.\n");

    const reconciled = await builtIns.ensure(companyId, "reflection-coach");
    const drift = reconciled.resources.find((resource) => resource.resourceKind === "instructions");
    expect(drift).toMatchObject({
      stockStatus: "operator_modified",
      updateAvailable: true,
      resetAvailable: true,
      changedFiles: ["AGENTS.md"],
    });
    await expect(instructions.readFile(reconciled.agent!, "AGENTS.md")).resolves.toMatchObject({
      content: "# Custom Reflection Coach\n\nOperator edit.\n",
    });

    const reset = await builtIns.reset(companyId, "reflection-coach");
    expect(reset.resources.find((resource) => resource.resourceKind === "instructions")).toMatchObject({
      stockStatus: "stock_current",
      resetAvailable: false,
    });
    const resetFile = await instructions.readFile(reset.agent!, "AGENTS.md");
    expect(resetFile.content).toContain("Reflection Coach");
    expect(resetFile.content).not.toContain("Operator edit.");
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
    expect(result).toMatchObject({ unknown: 0, duplicates: 0 });
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.reconciled).toBeGreaterThanOrEqual(1);

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

  it("automatically materializes the Reflection Coach bundle without enabling background work", async () => {
    const companyId = await seedCompany();
    const root = await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });

    const state = await builtInAgentService(db).ensure(companyId, "reflection-coach");

    expect(state.agent).toMatchObject({
      companyId,
      name: "Reflection Coach",
      title: "Reflection Coach",
      icon: "eye",
      reportsTo: root.id,
      adapterType: "codex_local",
      budgetMonthlyCents: 0,
    });
    expect(state.status).toBe("paused");
    expect(readBuiltInAgentMarker(state.agent?.metadata)).toEqual({
      key: "reflection-coach",
      featureKeys: ["reflection-coach"],
    });
    expect(state.resources.map((resource) => [resource.resourceKind, resource.stockStatus])).toEqual([
      ["instructions", "stock_current"],
      ["skill", "stock_current"],
      ["routine", "stock_current"],
    ]);
    const reported = await builtInAgentService(db).get(companyId, "reflection-coach");
    const reportedRoutine = reported.resources.find((resource) => resource.resourceKind === "routine");
    expect(reportedRoutine).toMatchObject({
      stockStatus: "stock_current",
      updateAvailable: false,
      resetAvailable: false,
    });
    expect(reportedRoutine?.currentHash).toBe(reportedRoutine?.stockHash);

    const [skill] = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.key, "paperclipai/bundled/paperclip-operations/reflection-coach"));
    expect(skill).toMatchObject({
      key: "paperclipai/bundled/paperclip-operations/reflection-coach",
      slug: "reflection-coach",
    });
    expect(readPaperclipSkillSyncPreference(state.agent!.adapterConfig).desiredSkills).toContain(skill!.key);

    const [routine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(routine).toMatchObject({
      title: "Review recent agent trajectories for coaching proposals",
      status: "paused",
      assigneeAgentId: state.agentId,
      originKind: "built_in_agent_bundle",
      originId: "reflection-coach:recent-agent-reflection",
    });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
    expect(trigger).toMatchObject({
      kind: "schedule",
      enabled: false,
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    const grantKeys = await permissionKeysForAgent(state.agentId!);
    expect(grantKeys).toEqual(expect.arrayContaining(["agents:suggest-changes", "skills:suggest-changes"]));
    expect(grantKeys).not.toContain("tasks:assign");
    expect(grantKeys).not.toContain("agents:configure");
    expect(grantKeys).not.toContain("skills:create");
  });

  it("controls the Reflection Coach routine schedule without enabling it by default", async () => {
    const companyId = await seedCompany();
    await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const builtIns = builtInAgentService(db);
    const created = await builtIns.ensure(companyId, "reflection-coach");
    expect(created.status).toBe("paused");
    expect(created.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "stock_current",
      scheduleEnabled: false,
    });

    const enabled = await builtIns.enableRoutineSchedule(
      companyId,
      "reflection-coach",
      "recent-agent-reflection",
      { userId: "board-user" },
    );
    expect(enabled.status).toBe("needs_setup");
    expect(enabled.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "stock_current",
      scheduleEnabled: true,
    });
    const [enabledRoutine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    const [enabledTrigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, enabledRoutine!.id));
    expect(enabledRoutine).toMatchObject({ status: "active" });
    expect(enabledTrigger).toMatchObject({ enabled: true });

    const disabled = await builtIns.disableRoutineSchedule(
      companyId,
      "reflection-coach",
      "recent-agent-reflection",
      { userId: "board-user" },
    );
    expect(disabled.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "stock_current",
      scheduleEnabled: false,
    });
    const [disabledRoutine] = await db.select().from(routines).where(eq(routines.id, enabledRoutine!.id));
    const [disabledTrigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, enabledTrigger!.id));
    expect(disabledRoutine).toMatchObject({ status: "paused" });
    expect(disabledTrigger).toMatchObject({ enabled: false });
  });

  it("surfaces pending Reflection Coach proposal interactions on the routine resource", async () => {
    const companyId = await seedCompany();
    await agentService(db).create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const created = await builtInAgentService(db).ensure(companyId, "reflection-coach");
    const proposalIssueId = randomUUID();
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review Reflection Coach proposal",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-42`,
      issueNumber: 42,
      assigneeAgentId: created.agentId,
      createdByAgentId: created.agentId,
    });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      title: "Review proposed coaching change",
      summary: "Accept or reject the proposed update.",
      createdByAgentId: created.agentId,
      payload: {
        version: 1,
        prompt: "Accept the proposed coaching change?",
        acceptLabel: "Accept",
        rejectLabel: "Reject",
      },
    });

    const state = await builtInAgentService(db).get(companyId, "reflection-coach");

    expect(state.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      pendingUpdateInteractionId: interactionId,
      pendingUpdateIssueId: proposalIssueId,
      pendingUpdateIssueIdentifier: `${issuePrefix(companyId)}-42`,
    });
  });

  it("gates Reflection Coach proposal mutations until an accepted follow-up apply step", async () => {
    const companyId = await seedCompany();
    const agentsSvc = agentService(db);
    await agentsSvc.create(companyId, {
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const target = await agentsSvc.create(companyId, {
      name: "Target Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });
    const created = await builtInAgentService(db).ensure(companyId, "reflection-coach");
    const coach = created.agent!;
    const instructionsSvc = agentInstructionsService();
    const originalInstructions = "# Target Coder\n\nWork from the assigned issue.\n";
    const prepared = await instructionsSvc.writeFile(target, "AGENTS.md", originalInstructions);
    let persistedTarget = (await agentsSvc.update(target.id, { adapterConfig: prepared.adapterConfig }))!;

    const interactionsSvc = issueThreadInteractionService(db);
    const applyAcceptedProposalFollowUp = async (input: {
      interactionId: string;
      nextInstructions: string;
    }) => {
      const interaction = await interactionsSvc.getById(input.interactionId);
      if (interaction?.kind !== "request_confirmation" || interaction.status !== "accepted") {
        return false;
      }
      const written = await instructionsSvc.writeFile(persistedTarget, "AGENTS.md", input.nextInstructions);
      persistedTarget = (await agentsSvc.update(persistedTarget.id, { adapterConfig: written.adapterConfig }))!;
      return true;
    };
    const readTargetInstructions = async () =>
      (await instructionsSvc.readFile(persistedTarget, "AGENTS.md")).content;

    const proposalIssueId = randomUUID();
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review Reflection Coach proposal",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-43`,
      issueNumber: 43,
      assigneeUserId: "board-user",
      createdByAgentId: coach.id,
    });
    const acceptedInstructions = `${originalInstructions}\nWhen finishing, name the exact verification command.\n`;
    const acceptedProposal = await interactionsSvc.create({
      id: proposalIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      title: "Review proposed coaching change",
      summary: "Accept or reject the proposed instruction diff.",
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach instruction diff in a follow-up run?",
        acceptLabel: "Accept",
        rejectLabel: "Reject",
        detailsMarkdown: [
          "```diff",
          " # Target Coder",
          "",
          " Work from the assigned issue.",
          "+When finishing, name the exact verification command.",
          "```",
        ].join("\n"),
        target: {
          type: "custom",
          key: `agent:${target.id}:instructions`,
          revisionId: "proposal-v1",
          label: "Target Coder AGENTS.md diff",
        },
      },
    }, {
      agentId: coach.id,
    });

    const accepted = await interactionsSvc.acceptInteraction(
      { id: proposalIssueId, companyId, goalId: null, projectId: null },
      acceptedProposal.id,
      {},
      { userId: "board-user" },
    );

    expect(accepted.interaction).toMatchObject({
      id: acceptedProposal.id,
      kind: "request_confirmation",
      status: "accepted",
    });
    expect(accepted.continuationIssue).toMatchObject({
      id: proposalIssueId,
      assigneeAgentId: coach.id,
      assigneeUserId: null,
      status: "todo",
    });
    expect(await readTargetInstructions()).toBe(originalInstructions);

    await expect(applyAcceptedProposalFollowUp({
      interactionId: acceptedProposal.id,
      nextInstructions: acceptedInstructions,
    })).resolves.toBe(true);
    expect(await readTargetInstructions()).toBe(acceptedInstructions);

    const rejectedProposal = await interactionsSvc.create({
      id: proposalIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      idempotencyKey: "reflection-coach:proposal-v2",
      title: "Review rejected coaching change",
      summary: "Rejecting this diff must not mutate the target instructions.",
      payload: {
        version: 1,
        prompt: "Apply this rejected Reflection Coach instruction diff?",
        acceptLabel: "Accept",
        rejectLabel: "Reject",
        detailsMarkdown: [
          "```diff",
          "+This rejected line must not be applied.",
          "```",
        ].join("\n"),
        target: {
          type: "custom",
          key: `agent:${target.id}:instructions`,
          revisionId: "proposal-v2",
          label: "Target Coder AGENTS.md rejected diff",
        },
      },
    }, {
      agentId: coach.id,
    });

    const rejected = await interactionsSvc.rejectInteraction(
      { id: proposalIssueId, companyId },
      rejectedProposal.id,
      { reason: "Not the right rule." },
      { userId: "board-user" },
    );

    expect(rejected).toMatchObject({
      id: rejectedProposal.id,
      kind: "request_confirmation",
      status: "rejected",
      result: expect.objectContaining({
        outcome: "rejected",
        reason: "Not the right rule.",
      }),
    });
    await expect(applyAcceptedProposalFollowUp({
      interactionId: rejectedProposal.id,
      nextInstructions: `${acceptedInstructions}\nThis rejected line must not be applied.\n`,
    })).resolves.toBe(false);
    expect(await readTargetInstructions()).toBe(acceptedInstructions);
  });

  it("preserves Reflection Coach stock drift until explicit reset", async () => {
    const companyId = await seedCompany();
    const created = await builtInAgentService(db).ensure(companyId, "reflection-coach");
    const agent = created.agent!;

    const instructionsSvc = agentInstructionsService();
    await instructionsSvc.writeFile(agent, "AGENTS.md", "# Custom Reflection Coach\n\nDo not overwrite me.\n");
    await db
      .update(companySkills)
      .set({ markdown: "---\nname: reflection-coach\n---\n\n# Custom skill\n" })
      .where(eq(companySkills.companyId, companyId));
    await db
      .update(routines)
      .set({ title: "DRIFTED BY TEST - do not clobber" })
      .where(eq(routines.companyId, companyId));

    const drifted = await builtInAgentService(db).ensure(companyId, "reflection-coach");
    expect(drifted.resources.find((resource) => resource.resourceKind === "instructions")).toMatchObject({
      stockStatus: "operator_modified",
      resetAvailable: true,
    });
    expect(drifted.resources.find((resource) => resource.resourceKind === "skill")).toMatchObject({
      stockStatus: "operator_modified",
      resetAvailable: true,
    });
    expect(drifted.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "operator_modified",
      resetAvailable: true,
    });
    expect((await instructionsSvc.readFile(drifted.agent!, "AGENTS.md")).content).toContain("Do not overwrite me.");
    const [preservedRoutine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(preservedRoutine?.title).toBe("DRIFTED BY TEST - do not clobber");

    const reset = await builtInAgentService(db).reset(companyId, "reflection-coach", {
      resources: ["instructions", "routine"],
    });
    expect(reset.resources.find((resource) => resource.resourceKind === "instructions")).toMatchObject({
      stockStatus: "stock_current",
      resetAvailable: false,
    });
    expect(reset.resources.find((resource) => resource.resourceKind === "skill")).toMatchObject({
      stockStatus: "operator_modified",
      resetAvailable: true,
    });
    expect(reset.resources.find((resource) => resource.resourceKind === "routine")).toMatchObject({
      stockStatus: "stock_current",
      resetAvailable: false,
    });
    expect((await instructionsSvc.readFile(reset.agent!, "AGENTS.md")).content).toContain("You are Reflection Coach");
    const [resetRoutine] = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(resetRoutine?.title).toBe("Review recent agent trajectories for coaching proposals");
  });
});
