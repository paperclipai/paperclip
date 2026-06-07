import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { authorizationService } from "../services/authorization.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>, label: string) {
  return db
    .insert(companies)
    .values({
      name: `Authorization ${label} ${randomUUID()}`,
      issuePrefix: `AZ${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  input: { role?: string; reportsTo?: string | null; permissions?: Record<string, unknown> } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: input.role ?? "engineer",
      reportsTo: input.reportsTo ?? null,
      permissions: input.permissions ?? {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createProject(db: ReturnType<typeof createDb>, companyId: string, label: string) {
  return db
    .insert(projects)
    .values({
      companyId,
      name: `Project ${label} ${randomUUID()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssue(
  db: ReturnType<typeof createDb>,
  companyId: string,
  input: {
    id?: string;
    title?: string;
    projectId?: string | null;
    parentId?: string | null;
    assigneeAgentId?: string | null;
  } = {},
) {
  return db
    .insert(issues)
    .values({
      id: input.id ?? randomUUID(),
      companyId,
      title: input.title ?? `Issue ${randomUUID()}`,
      status: "todo",
      priority: "medium",
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function grantAgentPermission(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  permissionKey: "tasks:assign" | "tasks:assign_scope",
  scope: Record<string, unknown> | null = null,
) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    status: "active",
    membershipRole: "member",
  });
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    permissionKey,
    scope,
    grantedByUserId: null,
  });
}

describeEmbeddedPostgres("authorization service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-authorization-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows active user role grants and explains the grant source", async () => {
    const company = await createCompany(db, "UserGrant");
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      permissionKey: "tasks:assign",
      grantedByUserId: "owner",
    });

    const decision = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      action: "tasks:assign",
      permissionKey: "tasks:assign",
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_explicit_grant",
      grant: {
        principalType: "user",
        principalId: userId,
        permissionKey: "tasks:assign",
      },
    });
    expect(decision.explanation).toContain("Allowed by explicit grant tasks:assign");
  });

  it("allows agent grants for agent configuration decisions", async () => {
    const company = await createCompany(db, "AgentGrant");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      permissionKey: "agents:create",
      grantedByUserId: null,
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "agent_config:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.grant?.permissionKey).toBe("agents:create");
  });

  it("denies cross-company agent decisions before grant evaluation", async () => {
    const sourceCompany = await createCompany(db, "Source");
    const targetCompany = await createCompany(db, "Target");
    const actorAgent = await createAgent(db, sourceCompany.id);

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: sourceCompany.id, source: "agent_jwt" },
      action: "tasks:assign",
      resource: { type: "company", companyId: targetCompany.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_company_boundary",
    });
    expect(decision.explanation).toContain("Agent key cannot access another company");
  });

  it("allows simple-mode task assignment between same-company agents without explicit grants", async () => {
    const company = await createCompany(db, "AssignmentDefault");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      status: "active",
      membershipRole: "member",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_simple_company_member",
    });
    expect(decision.explanation).toContain("simple mode");
  });

  it("limits low-trust issue reads to the configured project and root issue boundary", async () => {
    const company = await createCompany(db, "LowTrustIssueReads");
    const project = await createProject(db, company.id, "Allowed");
    const otherProject = await createProject(db, company.id, "Denied");
    const rootIssueId = randomUUID();
    const actorAgent = await createAgent(db, company.id, {
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            projectIds: [project.id],
            rootIssueId,
          },
        },
      },
    });
    const rootIssue = await createIssue(db, company.id, {
      id: rootIssueId,
      projectId: project.id,
      assigneeAgentId: actorAgent.id,
    });
    const childIssue = await createIssue(db, company.id, {
      projectId: project.id,
      parentId: rootIssue.id,
    });
    const unrelatedIssue = await createIssue(db, company.id, {
      projectId: otherProject.id,
    });

    const authorization = authorizationService(db);
    const actor = { type: "agent" as const, agentId: actorAgent.id, companyId: company.id, source: "agent_key" as const };
    const rootDecision = await authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: rootIssue.id,
        projectId: rootIssue.projectId,
        parentIssueId: rootIssue.parentId,
        assigneeAgentId: rootIssue.assigneeAgentId,
        status: rootIssue.status,
      },
    });
    const childDecision = await authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: childIssue.id,
        projectId: childIssue.projectId,
        parentIssueId: childIssue.parentId,
        status: childIssue.status,
      },
    });
    const unrelatedDecision = await authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: unrelatedIssue.id,
        projectId: unrelatedIssue.projectId,
        parentIssueId: unrelatedIssue.parentId,
        status: unrelatedIssue.status,
      },
    });

    expect(rootDecision).toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
    expect(childDecision).toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
    expect(unrelatedDecision).toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("blocks low-trust project, agent, company-wide, and outside-boundary assignment access", async () => {
    const company = await createCompany(db, "LowTrustOtherResources");
    const project = await createProject(db, company.id, "Allowed");
    const otherProject = await createProject(db, company.id, "Denied");
    const collaborator = await createAgent(db, company.id);
    const higherTrustAgent = await createAgent(db, company.id, { role: "cto" });
    const actorAgent = await createAgent(db, company.id, {
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            projectIds: [project.id],
            allowedAgentIds: [collaborator.id],
          },
        },
      },
    });

    const authorization = authorizationService(db);
    const actor = { type: "agent" as const, agentId: actorAgent.id, companyId: company.id, source: "agent_key" as const };

    await expect(authorization.decide({
      actor,
      action: "project:read",
      resource: { type: "project", companyId: company.id, projectId: project.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "project:read",
      resource: { type: "project", companyId: company.id, projectId: otherProject.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: collaborator.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: higherTrustAgent.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: company.id,
        projectId: project.id,
        assigneeAgentId: higherTrustAgent.id,
      },
      scope: { projectId: project.id, assigneeAgentId: higherTrustAgent.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("denies simple-mode assignment when the target agent requires protected-assignment approval", async () => {
    const company = await createCompany(db, "ProtectedAssignment");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const targetAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        authorizationPolicy: {
          assignmentPolicy: {
            mode: "protected",
            protectedAgentRequiresApproval: true,
          },
          protectedAgent: {
            requiresApproval: true,
            approvalReason: "Production deployment authority",
          },
          managedBy: "permissions-extension",
        },
      },
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_policy_restricted",
    });
    expect(decision.explanation).toContain("requires approval");
  });

  it("requires an explicit grant before assigning to a private target agent", async () => {
    const company = await createCompany(db, "PrivateAssignment");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const targetAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        authorizationPolicy: {
          agentVisibility: {
            mode: "private",
            hiddenFromDefaultDirectory: true,
          },
          assignmentPolicy: {
            mode: "company_default",
            protectedAgentRequiresApproval: false,
          },
          protectedAgent: {
            requiresApproval: false,
          },
          managedBy: "permissions-extension",
        },
      },
    });

    const denied = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      assigneeAgentId: targetAgent.id,
    });

    const allowed = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(denied).toMatchObject({
      allowed: false,
      reason: "deny_policy_restricted",
    });
    expect(denied.explanation).toContain("private");
    expect(allowed).toMatchObject({
      allowed: true,
      reason: "allow_explicit_grant",
      grant: { permissionKey: "tasks:assign_scope" },
    });
  });

  it("allows simple-mode task assignment for active same-company board operators without explicit grants", async () => {
    const company = await createCompany(db, "BoardAssignmentDefault");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "board", userId, source: "session" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_simple_company_member",
    });
  });

  it("denies legacy board assignment context for viewers", async () => {
    const company = await createCompany(db, "BoardViewerAssignment");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "viewer",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "board", userId, companyIds: [company.id], source: "session" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_missing_grant",
    });
  });

  it("denies simple-mode assignment to a target agent from another company", async () => {
    const sourceCompany = await createCompany(db, "AssignmentSource");
    const targetCompany = await createCompany(db, "AssignmentTarget");
    const actorAgent = await createAgent(db, sourceCompany.id, { role: "engineer" });
    const targetAgent = await createAgent(db, targetCompany.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: sourceCompany.id,
      principalType: "agent",
      principalId: actorAgent.id,
      status: "active",
      membershipRole: "member",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: sourceCompany.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: sourceCompany.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_company_boundary",
    });
  });

  it("preserves legacy CEO agent creator authority", async () => {
    const company = await createCompany(db, "Legacy");
    const actorAgent = await createAgent(db, company.id, { role: "ceo" });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_jwt" },
      action: "agents:create",
      resource: { type: "company", companyId: company.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_legacy_agent_creator",
    });
  });

  it("allows scoped assignment inside a granted project and denies other projects", async () => {
    const company = await createCompany(db, "ProjectScope");
    const project = await createProject(db, company.id, "Allowed");
    const otherProject = await createProject(db, company.id, "Denied");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      projectIds: [project.id],
    });

    const allowed = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { projectId: project.id, assigneeAgentId: targetAgent.id },
    });
    const denied = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { projectId: otherProject.id, assigneeAgentId: targetAgent.id },
    });

    expect(allowed).toMatchObject({
      allowed: true,
      grant: { permissionKey: "tasks:assign_scope" },
    });
    expect(denied).toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });
    expect(denied.explanation).toContain("does not cover the requested scope");
  });

  it("treats unknown grant scope metadata as unconstrained", async () => {
    const company = await createCompany(db, "UnknownScopeMetadata");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      note: "CEO-approved",
    });

    const decision = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      grant: { permissionKey: "tasks:assign_scope" },
    });
  });

  it("allows scoped assignment to agents inside a managed subtree only", async () => {
    const company = await createCompany(db, "SubtreeScope");
    const actorAgent = await createAgent(db, company.id);
    const managerAgent = await createAgent(db, company.id);
    const childAgent = await createAgent(db, company.id, { reportsTo: managerAgent.id });
    const grandchildAgent = await createAgent(db, company.id, { reportsTo: childAgent.id });
    const outsideAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      managedSubtreeAgentIds: [managerAgent.id],
    });

    const allowed = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: grandchildAgent.id },
    });
    const denied = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: outsideAgent.id },
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.grant?.permissionKey).toBe("tasks:assign_scope");
    expect(denied).toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });
  });

  it("allows scoped assignment to an explicit target-agent allowlist only", async () => {
    const company = await createCompany(db, "AllowlistScope");
    const actorAgent = await createAgent(db, company.id);
    const allowedTarget = await createAgent(db, company.id);
    const deniedTarget = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      assigneeAgentIds: [allowedTarget.id],
    });

    const allowed = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: allowedTarget.id },
    });
    const denied = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: deniedTarget.id },
    });

    expect(allowed.allowed).toBe(true);
    expect(denied.allowed).toBe(false);
  });

  it("preserves unscoped tasks:assign compatibility for assignment decisions", async () => {
    const company = await createCompany(db, "BroadAssign");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign");

    const decision = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign",
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      grant: { permissionKey: "tasks:assign" },
    });
  });

  describe("issue:mutate boundary walks the reports-to subtree", () => {
    async function buildOrgChain(label: string) {
      const company = await createCompany(db, label);
      const ceo = await createAgent(db, company.id, { role: "ceo", reportsTo: null });
      const manager = await createAgent(db, company.id, { reportsTo: ceo.id });
      const ic = await createAgent(db, company.id, { reportsTo: manager.id });
      const grandchild = await createAgent(db, company.id, { reportsTo: ic.id });
      const siblingManager = await createAgent(db, company.id, { reportsTo: ceo.id });
      const siblingIc = await createAgent(db, company.id, { reportsTo: siblingManager.id });
      return { company, ceo, manager, ic, grandchild, siblingManager, siblingIc };
    }

    function buildDecide(db: ReturnType<typeof createDb>, actorAgentId: string, companyId: string) {
      const svc = authorizationService(db);
      return (assigneeAgentId: string | null, issueId: string | null = null) =>
        svc.decide({
          actor: { type: "agent", agentId: actorAgentId, companyId, source: "agent_key" },
          action: "issue:mutate",
          resource: {
            type: "issue",
            companyId,
            issueId,
            assigneeAgentId,
            assigneeUserId: null,
            status: "todo",
          },
        });
    }

    it("allows a manager to mutate an issue assigned to a direct report", async () => {
      const org = await buildOrgChain("ManagerDirectReport");
      const decide = buildDecide(db, org.manager.id, org.company.id);

      const decision = await decide(org.ic.id);

      expect(decision).toMatchObject({
        allowed: true,
        reason: "allow_manager_chain",
      });
    });

    it("allows a manager to mutate an issue assigned to a grandchild report", async () => {
      const org = await buildOrgChain("ManagerGrandchild");
      const decide = buildDecide(db, org.manager.id, org.company.id);

      const decision = await decide(org.grandchild.id);

      expect(decision).toMatchObject({
        allowed: true,
        reason: "allow_manager_chain",
      });
    });

    it("allows the CEO to mutate any issue in the company", async () => {
      const org = await buildOrgChain("CeoRoot");
      const decide = buildDecide(db, org.ceo.id, org.company.id);

      const directReport = await decide(org.manager.id);
      const grandchild = await decide(org.grandchild.id);
      const otherSubtree = await decide(org.siblingIc.id);

      expect(directReport.allowed).toBe(true);
      expect(grandchild.allowed).toBe(true);
      expect(otherSubtree.allowed).toBe(true);
      expect(directReport.reason).toBe("allow_manager_chain");
    });

    it("rejects a sibling-subtree actor (preserves isolation)", async () => {
      const org = await buildOrgChain("SiblingIsolation");
      const decide = buildDecide(db, org.siblingManager.id, org.company.id);

      const decision = await decide(org.ic.id);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("deny_missing_grant");
    });

    it("rejects an IC trying to mutate their manager's issue (no upward writes)", async () => {
      const org = await buildOrgChain("UpwardWriteBlocked");
      const decide = buildDecide(db, org.ic.id, org.company.id);

      const decision = await decide(org.manager.id);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("deny_missing_grant");
    });

    it("still allows the actor to mutate their own assigned issue", async () => {
      const org = await buildOrgChain("AssigneeSelf");
      const decide = buildDecide(db, org.ic.id, org.company.id);

      const decision = await decide(org.ic.id);

      expect(decision).toMatchObject({
        allowed: true,
        reason: "allow_self",
      });
    });
  });
});
