import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  projects,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCatalogEntries,
  toolCallEvents,
  toolConnections,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRateLimitCounters,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>) {
  return db.insert(companies).values({
    name: `Tool Access ${randomUUID()}`,
    issuePrefix: `TA${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
}

async function createAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  permissions: Record<string, unknown> = {},
) {
  return db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID()}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions,
  }).returning().then((rows) => rows[0]!);
}

async function createRun(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  contextSnapshot: Record<string, unknown> = {},
) {
  return db.insert(heartbeatRuns).values({
    companyId,
    agentId,
    invocationSource: "assignment",
    status: "running",
    contextSnapshot,
  }).returning().then((rows) => rows[0]!);
}

async function createIssue(db: ReturnType<typeof createDb>, companyId: string, title = "Tool issue") {
  return db.insert(issues).values({
    companyId,
    title: `${title} ${randomUUID()}`,
    status: "in_progress",
  }).returning().then((rows) => rows[0]!);
}

async function createTool(db: ReturnType<typeof createDb>, companyId: string) {
  const application = await db.insert(toolApplications).values({
    companyId,
    applicationKey: `fixture-${randomUUID()}`,
    name: `Fixture ${randomUUID()}`,
    type: "mcp_http",
    status: "active",
  }).returning().then((rows) => rows[0]!);
  const connection = await db.insert(toolConnections).values({
    companyId,
    applicationId: application.id,
    name: `Connection ${randomUUID()}`,
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: "active",
    enabled: true,
    config: { url: "https://example.invalid/mcp" },
  }).returning().then((rows) => rows[0]!);
  const catalogEntry = await db.insert(toolCatalogEntries).values({
    companyId,
    applicationId: application.id,
    connectionId: connection.id,
    name: "send_email",
    toolName: "send_email",
    riskLevel: "write",
    versionHash: randomUUID(),
    schemaHash: randomUUID(),
  }).returning().then((rows) => rows[0]!);
  return { application, connection, catalogEntry };
}

async function createApprovedToolAction(input: {
  db: ReturnType<typeof createDb>;
  companyId: string;
  agentId: string;
  connectionId: string;
  catalogEntryId: string;
  issueId?: string | null;
  argumentsValue: Record<string, unknown>;
  status?: "approved" | "executed";
}) {
  const svc = toolAccessPolicyService(input.db);
  const decisionInput = {
    companyId: input.companyId,
    actor: { actorType: "agent" as const, actorId: input.agentId, agentId: input.agentId },
    runContext: { issueId: input.issueId ?? null },
    request: {
      connectionId: input.connectionId,
      catalogEntryId: input.catalogEntryId,
      toolName: "send_email",
      arguments: input.argumentsValue,
    },
  };
  const decision = await svc.decide(decisionInput);
  const recorded = await svc.recordInvocation(decisionInput, decision);
  if (!recorded.actionRequest) throw new Error("Expected approval-required action request");
  const [updated] = await input.db
    .update(toolActionRequests)
    .set({
      status: input.status ?? "approved",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(toolActionRequests.id, recorded.actionRequest.id))
    .returning();
  return { decisionInput, invocation: recorded.invocation, actionRequest: updated };
}

describeEmbeddedPostgres("tool access policy service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-access-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(toolRateLimitCounters);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolCallEvents);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolPolicies);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companySecrets);
    await db.delete(principalPermissionGrants);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("denies direct execution without an effective profile or grant", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_default",
    });
  });

  it("allows calls through an effective agent profile", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const profile = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `profile-${randomUUID()}`,
      name: "Write tools",
      defaultAction: "deny",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: profile.id,
      targetType: "agent",
      targetId: agent.id,
    });
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: profile.id,
      selectorType: "tool_name",
      effect: "include",
      toolName: "send_email",
    });

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: true,
      decision: "allow",
      reasonCode: "allow_profile",
      effectiveProfileIds: [profile.id],
    });
  });

  it("uses issue-scoped profiles ahead of company defaults", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const issue = await createIssue(db, company.id, "Scoped deny");

    const [companyProfile, issueProfile] = await db.insert(toolProfiles).values([
      {
        companyId: company.id,
        profileKey: `company-allow-${randomUUID()}`,
        name: "Company allow",
        defaultAction: "deny",
      },
      {
        companyId: company.id,
        profileKey: `issue-deny-${randomUUID()}`,
        name: "Issue deny",
        defaultAction: "deny",
      },
    ]).returning();
    await db.insert(toolProfileBindings).values([
      {
        companyId: company.id,
        profileId: companyProfile!.id,
        targetType: "company",
        targetId: company.id,
      },
      {
        companyId: company.id,
        profileId: issueProfile!.id,
        targetType: "issue",
        targetId: issue.id,
      },
    ]);
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: companyProfile!.id,
      selectorType: "tool_name",
      effect: "include",
      toolName: "send_email",
    });

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      runContext: { issueId: issue.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_default",
      effectiveProfileIds: [issueProfile!.id],
    });
  });

  it("uses agent-scoped profiles ahead of project defaults", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const project = await db.insert(projects).values({
      companyId: company.id,
      name: `Project ${randomUUID()}`,
    }).returning().then((rows) => rows[0]!);

    const [projectProfile, agentProfile] = await db.insert(toolProfiles).values([
      {
        companyId: company.id,
        profileKey: `project-allow-${randomUUID()}`,
        name: "Project allow",
        defaultAction: "deny",
      },
      {
        companyId: company.id,
        profileKey: `agent-deny-${randomUUID()}`,
        name: "Agent deny",
        defaultAction: "deny",
      },
    ]).returning();
    await db.insert(toolProfileBindings).values([
      {
        companyId: company.id,
        profileId: projectProfile!.id,
        targetType: "project",
        targetId: project.id,
      },
      {
        companyId: company.id,
        profileId: agentProfile!.id,
        targetType: "agent",
        targetId: agent.id,
      },
    ]);
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: projectProfile!.id,
      selectorType: "tool_name",
      effect: "include",
      toolName: "send_email",
    });

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      runContext: { projectId: project.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_default",
      effectiveProfileIds: [agentProfile!.id],
    });
  });

  it("uses issue-scoped allows ahead of broader company denies", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const issue = await createIssue(db, company.id, "Scoped allow");

    const [companyProfile, issueProfile] = await db.insert(toolProfiles).values([
      {
        companyId: company.id,
        profileKey: `company-deny-${randomUUID()}`,
        name: "Company deny",
        defaultAction: "deny",
      },
      {
        companyId: company.id,
        profileKey: `issue-allow-${randomUUID()}`,
        name: "Issue allow",
        defaultAction: "deny",
      },
    ]).returning();
    await db.insert(toolProfileBindings).values([
      {
        companyId: company.id,
        profileId: companyProfile!.id,
        targetType: "company",
        targetId: company.id,
      },
      {
        companyId: company.id,
        profileId: issueProfile!.id,
        targetType: "issue",
        targetId: issue.id,
      },
    ]);
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: issueProfile!.id,
      selectorType: "tool_name",
      effect: "include",
      toolName: "send_email",
    });

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      runContext: { issueId: issue.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: true,
      decision: "allow",
      reasonCode: "allow_profile",
      effectiveProfileIds: [issueProfile!.id],
    });
  });

  it("denies calls through draft and archived profiles", async () => {
    const company = await createCompany(db);
    const draftAgent = await createAgent(db, company.id);
    const archivedAgent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const [draftProfile, archivedProfile] = await db.insert(toolProfiles).values([
      {
        companyId: company.id,
        profileKey: `draft-profile-${randomUUID()}`,
        name: "Draft write tools",
        status: "draft",
        defaultAction: "allow",
      },
      {
        companyId: company.id,
        profileKey: `archived-profile-${randomUUID()}`,
        name: "Archived write tools",
        status: "archived",
        defaultAction: "allow",
      },
    ]).returning();
    await db.insert(toolProfileBindings).values([
      {
        companyId: company.id,
        profileId: draftProfile!.id,
        targetType: "agent",
        targetId: draftAgent.id,
      },
      {
        companyId: company.id,
        profileId: archivedProfile!.id,
        targetType: "agent",
        targetId: archivedAgent.id,
      },
    ]);
    await db.insert(toolProfileEntries).values([
      {
        companyId: company.id,
        profileId: draftProfile!.id,
        selectorType: "tool_name",
        effect: "include",
        toolName: "send_email",
      },
      {
        companyId: company.id,
        profileId: archivedProfile!.id,
        selectorType: "tool_name",
        effect: "include",
        toolName: "send_email",
      },
    ]);

    for (const agent of [draftAgent, archivedAgent]) {
      const result = await toolAccessPolicyService(db).decide({
        companyId: company.id,
        actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
        request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
      });
      expect(result).toMatchObject({
        allowed: false,
        decision: "deny",
        reasonCode: "deny_default",
        effectiveProfileIds: [],
      });
    }
  });

  it("denies calls through disabled applications before explicit grants and allows them after reactivation", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { application, connection, catalogEntry } = await createTool(db, company.id);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tools:use",
      scope: { toolName: "send_email" },
    });
    const input = {
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    };

    await expect(toolAccessPolicyService(db).decide(input)).resolves.toMatchObject({
      allowed: true,
      decision: "allow",
      reasonCode: "allow_explicit_grant",
    });

    await db
      .update(toolApplications)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(eq(toolApplications.id, application.id));
    await expect(toolAccessPolicyService(db).decide(input)).resolves.toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_disabled_application",
      explanation: "Application is disabled.",
    });

    await db
      .update(toolApplications)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(toolApplications.id, application.id));
    await expect(toolAccessPolicyService(db).decide(input)).resolves.toMatchObject({
      allowed: true,
      decision: "allow",
      reasonCode: "allow_explicit_grant",
    });
  });

  it("manages generic tool policies without exposing trust rules", async () => {
    const company = await createCompany(db);
    const otherCompany = await createCompany(db);
    const svc = toolAccessPolicyService(db);
    const [trustRule] = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Promoted trust rule",
      policyType: "trust_rule",
      selectors: { toolName: "send_email" },
      config: { trustRule: { hitCount: 0 } },
    }).returning();

    const created = await svc.createPolicy(company.id, {
      name: "Block destructive senders",
      description: "Block a dangerous tool family.",
      policyType: "block",
      priority: 10,
      enabled: true,
      selectors: { toolNames: ["send_email", "delete_email"] },
      conditions: null,
      config: null,
    }, { userId: "board-user" });

    expect(created).toMatchObject({
      companyId: company.id,
      name: "Block destructive senders",
      policyType: "block",
      priority: 10,
      createdByUserId: "board-user",
    });

    await expect(svc.createPolicy(company.id, {
      name: "Generic trust rule",
      description: null,
      policyType: "trust_rule",
      priority: 100,
      enabled: true,
      selectors: {},
      conditions: null,
      config: null,
    })).rejects.toMatchObject({ status: 422 });

    await expect(svc.updatePolicy({
      companyId: otherCompany.id,
      policyId: created.id,
      body: { enabled: false },
    })).rejects.toMatchObject({ status: 404 });

    const listed = await svc.listPolicies(company.id);
    expect(listed.map((policy) => policy.id)).toEqual([created.id]);

    const updated = await svc.updatePolicy({
      companyId: company.id,
      policyId: created.id,
      body: {
        name: "Require review for destructive senders",
        policyType: "require_approval",
        enabled: false,
        selectors: { toolName: "delete_email" },
      },
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: "Require review for destructive senders",
      policyType: "require_approval",
      enabled: false,
      selectors: { toolName: "delete_email" },
    });

    const deleted = await svc.deletePolicy({ companyId: company.id, policyId: created.id });
    expect(deleted.id).toBe(created.id);
    await expect(svc.deletePolicy({ companyId: company.id, policyId: trustRule.id }))
      .rejects.toMatchObject({ status: 404 });
    expect(await svc.listPolicies(company.id)).toEqual([]);
    const remainingTrustRules = await svc.listTrustRules(company.id);
    expect(remainingTrustRules.map((policy) => policy.id)).toEqual([trustRule.id]);
  });

  it("treats glob-looking action-name selectors as exact names", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const profile = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `profile-${randomUUID()}`,
      name: "Write tools",
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: profile.id,
      targetType: "agent",
      targetId: agent.id,
    });
    const wildcardPolicy = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review wildcard-looking sends",
      policyType: "require_approval",
      priority: 10,
      selectors: { toolName: "*send*" },
    }).returning().then((rows) => rows[0]!);

    const input = {
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    };

    await expect(toolAccessPolicyService(db).decide(input)).resolves.toMatchObject({
      allowed: true,
      decision: "allow",
      reasonCode: "allow_profile",
      effectiveProfileIds: [profile.id],
      matchedPolicyIds: [],
    });

    const exactPolicy = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review exact sends",
      policyType: "require_approval",
      priority: 5,
      selectors: { toolName: "send_email" },
    }).returning().then((rows) => rows[0]!);

    await expect(toolAccessPolicyService(db).decide(input)).resolves.toMatchObject({
      allowed: false,
      decision: "require_approval",
      reasonCode: "requires_approval_policy",
      effectiveProfileIds: [profile.id],
      matchedPolicyIds: [exactPolicy.id],
    });
    expect(wildcardPolicy.selectors).toEqual({ toolName: "*send*" });
  });

  it("matches tool name selectors against connected MCP upstream tool names", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const policy = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review upstream todo writes",
      policyType: "require_approval",
      priority: 10,
      selectors: { toolNames: ["todo.add"] },
    }).returning().then((rows) => rows[0]!);

    await expect(toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: {
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        toolName: "mcp.smoke-fixture:todo-add",
        upstreamToolName: "todo.add",
      },
    })).resolves.toMatchObject({
      allowed: false,
      decision: "require_approval",
      reasonCode: "requires_approval_policy",
      matchedPolicyIds: [policy.id],
    });
  });

  it("rejects agent-supplied run context that belongs to another agent", async () => {
    const company = await createCompany(db);
    const actorAgent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, company.id);
    const { connection } = await createTool(db, company.id);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: otherAgent.id,
      invocationSource: "assignment",
      status: "running",
    }).returning().then((rows) => rows[0]!);

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: actorAgent.id, agentId: actorAgent.id },
      runContext: { heartbeatRunId: run.id },
      request: { connectionId: connection.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: "deny_run_context_mismatch",
    });
  });

  it("rejects agent-supplied issue context that differs from the stored heartbeat context", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const canonicalIssue = await createIssue(db, company.id, "Canonical");
    const escalatedIssue = await createIssue(db, company.id, "Escalated");
    const { connection } = await createTool(db, company.id);
    const run = await createRun(db, company.id, agent.id, { issueId: canonicalIssue.id });

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      runContext: { heartbeatRunId: run.id, issueId: escalatedIssue.id },
      request: { connectionId: connection.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: "deny_run_context_mismatch",
    });
  });

  it("audits denied calls without storing secret argument values", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection } = await createTool(db, company.id);
    const input = {
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
      request: {
        connectionId: connection.id,
        toolName: "send_email",
        arguments: { to: "ops@example.com", apiKey: "sk-test-secret-value-123456" },
      },
    };

    const decision = await toolAccessPolicyService(db).decide(input);
    await toolAccessPolicyService(db).writeAudit(input, decision);
    const [legacyAudit] = await db.select().from(toolAccessAuditEvents);
    const [callEvent] = await db.select().from(toolCallEvents);
    const serialized = JSON.stringify({ legacy: legacyAudit.details, dedicated: callEvent });

    expect(decision.reasonCode).toBe("deny_default");
    expect(callEvent).toMatchObject({
      eventType: "policy_decision",
      outcome: "denied",
      reasonCode: "deny_default",
      decision: "deny",
      matchedPolicyIds: [],
      requestHash: expect.any(String),
    });
    expect(serialized).not.toContain("sk-test-secret-value");
    expect(serialized).toContain("[REDACTED]");
  });

  it("records approval-required invocations and action requests with matched policy IDs", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection } = await createTool(db, company.id);
    const policy = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review writes",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
      description: "Writes require board review.",
    }).returning().then((rows) => rows[0]!);
    const input = {
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
      request: {
        connectionId: connection.id,
        toolName: "send_email",
        arguments: { to: "ops@example.com", body: "ship it" },
        sideEffecting: true,
      },
    };

    const decision = await toolAccessPolicyService(db).decide(input);
    const recorded = await toolAccessPolicyService(db).recordInvocation(input, decision);
    await toolAccessPolicyService(db).writeAudit(input, decision);
    const [callEvent] = await db.select().from(toolCallEvents);

    expect(decision).toMatchObject({
      allowed: false,
      decision: "require_approval",
      reasonCode: "requires_approval_policy",
      matchedPolicyIds: [policy.id],
    });
    expect(recorded.actionRequest).toMatchObject({
      invocationId: recorded.invocation.id,
      requestedByAgentId: agent.id,
      status: "pending",
    });
    expect(recorded.invocation).toMatchObject({
      approvalState: "pending",
      status: "awaiting_approval",
      matchedPolicyIds: [policy.id],
    });
    expect(callEvent).toMatchObject({
      eventType: "policy_decision",
      outcome: "pending",
      decision: "require_approval",
      matchedPolicyIds: [policy.id],
      requestSummary: expect.objectContaining({ summary: expect.any(String) }),
    });
  });

  it("replays side-effecting calls with the same idempotency key instead of creating a new invocation", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection } = await createTool(db, company.id);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tools:use",
      scope: { toolName: "send_email" },
    });
    const input = {
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
      request: {
        connectionId: connection.id,
        toolName: "send_email",
        arguments: { to: "ops@example.com" },
        sideEffecting: true,
        idempotencyKey: "send-email-1",
      },
    };

    const decision = await toolAccessPolicyService(db).decide(input);
    const first = await toolAccessPolicyService(db).recordInvocation(input, decision);
    const replay = await toolAccessPolicyService(db).recordInvocation(input, decision);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.invocation.id).toBe(first.invocation.id);
  });

  it("derives a canonical idempotency key for side-effecting calls without caller-supplied keys", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection } = await createTool(db, company.id);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tools:use",
      scope: { toolName: "send_email" },
    });
    const input = {
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
      request: {
        connectionId: connection.id,
        toolName: "send_email",
        arguments: { to: "ops@example.com", body: "only once" },
        sideEffecting: true,
      },
    };

    const decision = await toolAccessPolicyService(db).decide(input);
    const first = await toolAccessPolicyService(db).recordInvocation(input, decision);
    const replay = await toolAccessPolicyService(db).recordInvocation(input, decision);

    expect(first.replayed).toBe(false);
    expect(first.invocation.idempotencyKey).toMatch(/^side_effect:/);
    expect(replay.replayed).toBe(true);
    expect(replay.invocation.id).toBe(first.invocation.id);
  });

  it("enforces rate-limit policies before explicit grants", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection } = await createTool(db, company.id);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tools:use",
      scope: { toolName: "send_email" },
    });
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "One send per minute",
      policyType: "rate_limit",
      selectors: { toolName: "send_email" },
      config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] },
    });
    const input = {
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, toolName: "send_email" },
      consumeRateLimit: true,
    };

    const first = await toolAccessPolicyService(db).decide(input);
    const second = await toolAccessPolicyService(db).decide(input);

    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({
      allowed: false,
      decision: "rate_limited",
      reasonCode: "rate_limited",
    });
  });

  it("atomically consumes the final rate-limit slot", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection } = await createTool(db, company.id);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tools:use",
      scope: { toolName: "send_email" },
    });
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "One concurrent send per minute",
      policyType: "rate_limit",
      selectors: { toolName: "send_email" },
      config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] },
    });
    const input = {
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, toolName: "send_email" },
      consumeRateLimit: true,
    };

    const decisions = await Promise.all([
      toolAccessPolicyService(db).decide(input),
      toolAccessPolicyService(db).decide(input),
    ]);

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => decision.reasonCode === "rate_limited")).toHaveLength(1);
  });

  it("rejects unsupported policy semantics at create and update time", async () => {
    const company = await createCompany(db);
    const svc = toolAccessPolicyService(db);
    const policy = await svc.createPolicy(company.id, {
      name: "Require review",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
    });

    await expect(svc.createPolicy(company.id, {
      name: "Dead redact policy",
      policyType: "redact" as never,
      selectors: { toolName: "send_email" },
      config: { redact: { fields: ["to", "body"] } },
    })).rejects.toThrow("Tool policy type 'redact' is not supported at runtime");
    await expect(svc.createPolicy(company.id, {
      name: "Dead custom check",
      policyType: "validate" as never,
      selectors: { toolName: "send_email" },
      config: { schema: { required: ["body"] } },
    })).rejects.toThrow("Tool policy type 'validate' is not supported at runtime");
    await expect(svc.createPolicy(company.id, {
      name: "Malformed conditional policy",
      policyType: "allow",
      selectors: { toolName: "send_email" },
      conditions: { args: { body: "safe" } } as never,
    })).rejects.toThrow("Tool policy conditions include unsupported runtime semantics");
    await expect(svc.createPolicy(company.id, {
      name: "Ignored approval config",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
      config: { validate: { required: ["body"] } },
    })).rejects.toThrow("Tool policy type 'require_approval' does not support config");
    await expect(svc.createPolicy(company.id, {
      name: "Invalid rate limit",
      policyType: "rate_limit",
      selectors: { toolName: "send_email" },
      config: { rateLimit: { limit: 0, windowSeconds: 60 } },
    })).rejects.toThrow("Rate-limit policy config requires positive numeric limit and windowSeconds");
    await expect(svc.updatePolicy({
      companyId: company.id,
      policyId: policy.id,
      body: { conditions: { args: { body: "safe" } } as never },
    })).rejects.toThrow("Tool policy conditions include unsupported runtime semantics");
  });

  it("rejects fieldMatches patterns with nested quantifiers", async () => {
    const company = await createCompany(db);
    const svc = toolAccessPolicyService(db);

    await expect(svc.createPolicy(company.id, {
      name: "Unsafe regex",
      policyType: "allow",
      priority: 10,
      selectors: { toolName: "send_email" },
      conditions: {
        arguments: { fieldMatches: { body: "^(a+)+$" } },
      },
    })).rejects.toThrow("unsafe regular expression");
  });

  it("rejects fieldMatches patterns with ambiguous alternation", async () => {
    const company = await createCompany(db);
    const svc = toolAccessPolicyService(db);

    await expect(svc.createPolicy(company.id, {
      name: "Unsafe alternation",
      policyType: "allow",
      conditions: {
        arguments: { fieldMatches: { body: "^(a|aa)*b$" } },
      },
    })).rejects.toThrow("unsafe regular expression");
  });

  it("allows a write policy only for a safe argument subset and blocks unsafe arguments", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const svc = toolAccessPolicyService(db);
    const allowPolicy = await svc.createPolicy(company.id, {
      name: "Allow safe destination",
      policyType: "allow",
      priority: 10,
      selectors: { toolName: "send_email" },
      conditions: {
        arguments: {
          fieldEquals: { to: "ops@example.com" },
          fieldMatches: { body: "^[\\s\\S]{1,200}$" },
        },
        risk: { isWrite: true },
      },
    });
    const blockPolicy = await svc.createPolicy(company.id, {
      name: "Block external destination",
      policyType: "block",
      priority: 5,
      selectors: { toolName: "send_email" },
      conditions: {
        arguments: {
          fieldNotEquals: { to: "ops@example.com" },
        },
      },
    });

    await expect(svc.decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: {
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        toolName: "send_email",
        arguments: { to: "ops@example.com", body: "safe update" },
      },
    })).resolves.toMatchObject({
      allowed: true,
      decision: "allow",
      reasonCode: "allow_policy",
      matchedPolicyIds: [allowPolicy.id],
      policyExplanation: {
        conditionsMatched: ["arguments", "risk"],
      },
    });

    await expect(svc.decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: {
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        toolName: "send_email",
        arguments: { to: "outside@example.com", body: "exfiltrate" },
      },
    })).resolves.toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_policy_block",
      matchedPolicyIds: [blockPolicy.id],
    });
  });

  it("fails closed for legacy unsupported redact and validate policies", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const profile = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `profile-${randomUUID()}`,
      name: "Fallback allow",
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: profile.id,
      targetType: "agent",
      targetId: agent.id,
    });
    const [redactPolicy] = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Legacy redact",
      policyType: "redact" as never,
      selectors: { toolName: "send_email" },
      config: { redact: { fields: ["to", "body"] } },
      priority: 1,
    }).returning();
    const [validatePolicy] = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Legacy validate",
      policyType: "validate" as never,
      selectors: { toolName: "send_email" },
      config: { schema: { required: ["body"] } },
      priority: 2,
    }).returning();

    const redactDecision = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });
    await db.update(toolPolicies).set({ enabled: false }).where(eq(toolPolicies.id, redactPolicy!.id));
    const validateDecision = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });

    expect(redactDecision).toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_policy_block",
      matchedPolicyIds: [redactPolicy!.id],
    });
    expect(validateDecision).toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_policy_block",
      matchedPolicyIds: [validatePolicy!.id],
    });
  });

  it("fails closed for legacy condition-bearing policies", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const profile = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `profile-${randomUUID()}`,
      name: "Fallback allow",
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: profile.id,
      targetType: "agent",
      targetId: agent.id,
    });
    const [policy] = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Legacy conditional allow",
      policyType: "allow",
      selectors: { toolName: "send_email" },
      conditions: { args: { body: "safe" } },
      priority: 1,
    }).returning();

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_policy_block",
      matchedPolicyIds: [policy!.id],
    });
  });

  it("fails closed for legacy rate-limit policies with invalid config", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    const profile = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `profile-${randomUUID()}`,
      name: "Fallback allow",
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: profile.id,
      targetType: "agent",
      targetId: agent.id,
    });
    const [policy] = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Broken rate limit",
      policyType: "rate_limit",
      selectors: { toolName: "send_email" },
      config: { rateLimit: { limit: 0, windowSeconds: 60 } },
      priority: 1,
    }).returning();

    const result = await toolAccessPolicyService(db).decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId: connection.id, catalogEntryId: catalogEntry.id, toolName: "send_email" },
    });

    expect(result).toMatchObject({
      allowed: false,
      decision: "deny",
      reasonCode: "deny_policy_block",
      matchedPolicyIds: [policy!.id],
    });
  });

  it("promotes repeated approved actions into a scoped trust rule with audited hits", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const issue = await createIssue(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review send_email",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
      description: "Writes require review until promoted.",
    });
    const args = { to: "ops@example.com", body: "ship it" };
    const first = await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      issueId: issue.id,
      argumentsValue: args,
      status: "executed",
    });
    await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      issueId: issue.id,
      argumentsValue: args,
    });

    const trustRule = await toolAccessPolicyService(db).createTrustRuleFromActionRequest({
      companyId: company.id,
      actionRequestId: first.actionRequest.id,
      body: {
        approvalThreshold: 2,
        scope: { includeIssue: true, includeCatalogEntry: true },
        expiresAt: new Date(Date.now() + 60_000),
        batchApproval: { enabled: true, maxBatchSize: 5, windowSeconds: 3600 },
      },
    });
    const decision = await toolAccessPolicyService(db).decide({
      ...first.decisionInput,
      consumeRateLimit: true,
    });
    const [updatedRule] = await db.select().from(toolPolicies).where(eq(toolPolicies.id, trustRule.id));
    const trustConfig = updatedRule.config as { trustRule?: { hitCount?: number; lastHitAt?: string | null } };
    const trustEvents = await db.select().from(toolCallEvents);

    expect(trustRule).toMatchObject({
      policyType: "trust_rule",
      enabled: true,
      selectors: expect.objectContaining({
        agentId: agent.id,
        issueId: issue.id,
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        toolName: "send_email",
      }),
    });
    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      reasonCode: "allow_trust_rule",
      matchedPolicyIds: [trustRule.id],
    });
    expect(trustConfig.trustRule?.hitCount).toBe(1);
    expect(trustConfig.trustRule?.lastHitAt).toEqual(expect.any(String));
    expect(trustEvents.some((event) => event.eventType === "trust_rule_created")).toBe(true);
    expect(trustEvents.some((event) => event.eventType === "trust_rule_used")).toBe(true);
  });

  it("does not count approved actions outside the final trust-rule agent scope", async () => {
    const company = await createCompany(db);
    const agentA = await createAgent(db, company.id);
    const agentB = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review scoped sends",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
    });
    const args = { to: "ops@example.com", body: "same reviewed payload" };
    await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agentA.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });
    const agentBAction = await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agentB.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });

    await expect(toolAccessPolicyService(db).createTrustRuleFromActionRequest({
      companyId: company.id,
      actionRequestId: agentBAction.actionRequest.id,
      body: { approvalThreshold: 2 },
    })).rejects.toThrow(/final rule scope; found 1/);
  });

  it("does not count approvals from stale catalog versions toward trust-rule promotion", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review versioned sends",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
    });
    const args = { to: "ops@example.com", body: "same payload after tool change" };
    await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });
    await db
      .update(toolCatalogEntries)
      .set({ versionHash: randomUUID(), schemaHash: randomUUID(), updatedAt: new Date() })
      .where(eq(toolCatalogEntries.id, catalogEntry.id));
    const currentVersionAction = await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });

    await expect(toolAccessPolicyService(db).createTrustRuleFromActionRequest({
      companyId: company.id,
      actionRequestId: currentVersionAction.actionRequest.id,
      body: { approvalThreshold: 2, scope: { includeCatalogEntry: true } },
    })).rejects.toThrow(/final rule scope; found 1/);
  });

  it("rejects company-wide trust-rule promotion bodies that drop the reviewed scope", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review scoped sends",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
    });
    const args = { to: "ops@example.com", body: "same reviewed payload" };
    const first = await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });
    await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });

    await expect(toolAccessPolicyService(db).createTrustRuleFromActionRequest({
      companyId: company.id,
      actionRequestId: first.actionRequest.id,
      body: {
        approvalThreshold: 2,
        scope: {
          includeAgent: false,
          includeProject: false,
          includeApplication: false,
          includeConnection: false,
          includeTool: false,
        },
      },
    })).rejects.toThrow(/reviewed actor\/tool scope/);
  });

  it("rejects argument-broadening trust-rule promotion bodies", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review exact payload sends",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
    });
    const args = { to: "ops@example.com", body: "same reviewed payload" };
    const first = await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });
    await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });

    await expect(toolAccessPolicyService(db).createTrustRuleFromActionRequest({
      companyId: company.id,
      actionRequestId: first.actionRequest.id,
      body: {
        approvalThreshold: 2,
        argumentFilters: { allowAny: true },
      },
    })).rejects.toThrow(/exact reviewed argument hash/);
  });

  it("falls back to review when a trusted catalog tool changes", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review changed sends",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
    });
    const args = { to: "ops@example.com", body: "repeatable" };
    const first = await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });
    await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
    });
    const trustRule = await toolAccessPolicyService(db).createTrustRuleFromActionRequest({
      companyId: company.id,
      actionRequestId: first.actionRequest.id,
      body: { approvalThreshold: 2, scope: { includeCatalogEntry: true } },
    });
    await db
      .update(toolCatalogEntries)
      .set({ status: "quarantined", versionHash: randomUUID(), updatedAt: new Date() })
      .where(eq(toolCatalogEntries.id, catalogEntry.id));

    const decision = await toolAccessPolicyService(db).decide(first.decisionInput);

    expect(decision).toMatchObject({
      allowed: false,
      decision: "require_approval",
      reasonCode: "requires_review_changed_tool",
      matchedPolicyIds: [trustRule.id],
    });
  });

  it("revokes trust rules so matching actions return to per-call approval", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { connection, catalogEntry } = await createTool(db, company.id);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review revocable sends",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
    });
    const args = { to: "ops@example.com", body: "revocable" };
    const first = await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
      status: "executed",
    });
    await createApprovedToolAction({
      db,
      companyId: company.id,
      agentId: agent.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      argumentsValue: args,
    });
    const trustRule = await toolAccessPolicyService(db).createTrustRuleFromActionRequest({
      companyId: company.id,
      actionRequestId: first.actionRequest.id,
      body: { approvalThreshold: 2 },
    });
    const revoked = await toolAccessPolicyService(db).revokeTrustRule({
      companyId: company.id,
      policyId: trustRule.id,
      body: { reason: "Tool scope changed" },
    });
    const decision = await toolAccessPolicyService(db).decide(first.decisionInput);
    const config = revoked.config as { trustRule?: { revokedAt?: string | null; revocationReason?: string | null } };

    expect(revoked.enabled).toBe(false);
    expect(config.trustRule?.revokedAt).toEqual(expect.any(String));
    expect(config.trustRule?.revocationReason).toBe("Tool scope changed");
    expect(decision).toMatchObject({
      allowed: false,
      decision: "require_approval",
      reasonCode: "requires_approval_policy",
    });
  });

  it("routes gateway execution through policy decisions instead of legacy gateway permissions", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, { toolGateway: { allowAll: true } });
    const run = await createRun(db, company.id, agent.id);
    const gateway = createToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:echo",
      parameters: { message: "hello" },
    })).rejects.toMatchObject({
      status: 403,
      reasonCode: "deny_default",
    } satisfies Partial<ToolGatewayHttpError>);

    const [invocation] = await db.select().from(toolInvocations);
    expect(invocation).toMatchObject({
      toolName: "mcp-remote-fixture:echo",
      policyDecision: "deny",
      status: "denied",
    });
  });

  it("replays idempotent side-effecting gateway calls without creating a second invocation", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createRun(db, company.id, agent.id);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tools:use",
      scope: { toolName: "mcp-remote-fixture:update_note" },
    });
    const gateway = createToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "ship" },
      idempotencyKey: "note-update-1",
    });
    const replay = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "ship" },
      idempotencyKey: "note-update-1",
    });

    expect(first).toMatchObject({ status: "completed", tool: "mcp-remote-fixture:update_note" });
    expect(replay).toMatchObject({ status: "replayed", invocationId: first.invocationId });
    const invocations = await db.select().from(toolInvocations);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      idempotencyKey: "note-update-1",
      status: "succeeded",
      resultSummary: expect.objectContaining({ summary: expect.any(String) }),
    });
  });

  it("rejects cross-company owner agents and credential secret refs before persisting tool access records", async () => {
    const company = await createCompany(db);
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id);
    const [otherSecret] = await db.insert(companySecrets).values({
      companyId: otherCompany.id,
      key: `secret-${randomUUID()}`,
      name: `Secret ${randomUUID()}`,
    }).returning();
    const svc = toolAccessService(db);

    await expect(svc.createApplication(company.id, {
      name: "Wrong owner",
      type: "mcp_http",
      ownerAgentId: otherAgent.id,
    })).rejects.toThrow(/same company/);

    await expect(svc.createConnection(company.id, {
      name: "Wrong secret",
      transport: "mcp_remote",
      transportConfig: { url: "https://example.invalid/mcp" },
      credentialSecretRefs: [{
        secretId: otherSecret.id,
        configPath: "headers.Authorization",
      }],
    })).rejects.toThrow(/same company/);
  });
});
