import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issueComments,
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
    originKind?: string | null;
    originId?: string | null;
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
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
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

async function createUser(
  db: ReturnType<typeof createDb>,
  input: { id?: string; email?: string } = {},
) {
  const id = input.id ?? `user-${randomUUID()}`;
  await db.insert(authUsers).values({
    id,
    name: `User ${id}`,
    email: input.email ?? `${id}@example.com`,
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function grantUserPermission(
  db: ReturnType<typeof createDb>,
  companyId: string,
  userId: string,
  permissionKey: "tasks:assign" | "tasks:assign_scope",
  scope: Record<string, unknown> | null = null,
) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "operator",
  });
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "user",
    principalId: userId,
    permissionKey,
    scope,
    grantedByUserId: "owner",
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
    await db.delete(issueComments);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
    await db.delete(authUsers);
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

  it("denies delegated protected assignment when the responsible user lacks matching authority", async () => {
    const company = await createCompany(db, "ResponsibleUserDenied");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const ceoAgent = await createAgent(db, company.id, {
      role: "ceo",
      permissions: {
        authorizationPolicy: {
          assignmentPolicy: { mode: "protected" },
        },
      },
    });
    const responsibleUserId = await createUser(db);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: ceoAgent.id },
      scope: { assigneeAgentId: ceoAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });
  });

  it("allows active non-viewer responsible users to authorize assigned agent issue mutations", async () => {
    const company = await createCompany(db, "ResponsibleUserIssueMutation");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const issue = await createIssue(db, company.id, {
      title: "Assigned issue mutation",
      assigneeAgentId: actorAgent.id,
    });
    const responsibleUserId = await createUser(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: issue.id,
        assigneeAgentId: actorAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_self",
    });
  });

  it("keeps responsible-user issue mutations denied for viewer memberships", async () => {
    const company = await createCompany(db, "ResponsibleUserIssueViewerDenied");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const issue = await createIssue(db, company.id, {
      title: "Assigned viewer-denied mutation",
      assigneeAgentId: actorAgent.id,
    });
    const responsibleUserId = await createUser(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "viewer",
    });

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: issue.id,
        assigneeAgentId: actorAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: false,
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
      reason: "deny_unsupported_action",
    });
  });

  it("fails closed when the responsible user is unavailable", async () => {
    const company = await createCompany(db, "ResponsibleUserUnavailable");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: `missing-${randomUUID()}`,
        source: "agent_jwt",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "RESPONSIBLE_USER_UNAVAILABLE",
    });
  });

  it("allows delegated protected assignment when both agent and responsible user are authorized", async () => {
    const company = await createCompany(db, "ResponsibleUserAllowed");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const ceoAgent = await createAgent(db, company.id, {
      role: "ceo",
      permissions: {
        authorizationPolicy: {
          assignmentPolicy: { mode: "protected" },
        },
      },
    });
    const responsibleUserId = await createUser(db);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign");
    await grantUserPermission(db, company.id, responsibleUserId, "tasks:assign");

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: ceoAgent.id },
      scope: { assigneeAgentId: ceoAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_explicit_grant",
    });
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

  it("allows null-mapped visibility actions for active same-company board members", async () => {
    const company = await createCompany(db, "BoardVisibility");
    const userId = `user-${randomUUID()}`;
    const project = await createProject(db, company.id, "Visible");
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    const issue = await createIssue(db, company.id, { projectId: project.id });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    const authorization = authorizationService(db);
    const actor = { type: "board" as const, userId, source: "session" as const };

    await expect(authorization.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "project:read",
      resource: { type: "project", companyId: company.id, projectId: project.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        status: issue.status,
      },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "runtime:manage",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "secrets:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
  });

  it("denies null-mapped visibility actions for board users without an active membership", async () => {
    const memberCompany = await createCompany(db, "BoardVisibilityMember");
    const otherCompany = await createCompany(db, "BoardVisibilityOther");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, otherCompany.id, { role: "engineer" });
    const inactiveUserId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: memberCompany.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(companyMemberships).values({
      companyId: otherCompany.id,
      principalType: "user",
      principalId: inactiveUserId,
      status: "removed",
      membershipRole: "member",
    });

    const authorization = authorizationService(db);

    await expect(authorization.decide({
      actor: { type: "board", userId, source: "session" },
      action: "agent:read",
      resource: { type: "agent", companyId: otherCompany.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_membership" });
    await expect(authorization.decide({
      actor: { type: "board", userId: inactiveUserId, source: "session" },
      action: "company_scope:read",
      resource: { type: "company", companyId: otherCompany.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_membership" });
  });

  it("keeps denying self-gated null-mapped actions for board members", async () => {
    const company = await createCompany(db, "BoardWakeDenied");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    const authorization = authorizationService(db);

    await expect(authorization.decide({
      actor: { type: "board", userId, source: "session" },
      action: "agent:wake",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_unsupported_action",
    });
    const issue = await createIssue(db, company.id, { title: "Wake denied issue" });
    await expect(authorization.decide({
      actor: { type: "board", userId, source: "session" },
      action: "issue:mutate",
      resource: { type: "issue", companyId: company.id, issueId: issue.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_unsupported_action",
    });
  });

  it("allows mentioned agents to read and comment on assigned issues without granting issue mutation", async () => {
    const company = await createCompany(db, "MentionCommentAuth");
    const allowedProject = await createProject(db, company.id, "MentionAllowed");
    const targetProject = await createProject(db, company.id, "MentionTarget");
    const ownerAgent = await createAgent(db, company.id, { role: "engineer" });
    const mentionedAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [allowedProject.id],
          },
        },
      },
    });
    const issue = await createIssue(db, company.id, {
      title: "Mention-scoped comment target",
      projectId: targetProject.id,
      assigneeAgentId: ownerAgent.id,
    });

    const authorization = authorizationService(db);
    const actor = { type: "agent", agentId: mentionedAgent.id, companyId: company.id, source: "agent_key" } as const;
    const resource = {
      type: "issue",
      companyId: company.id,
      issueId: issue.id,
      projectId: issue.projectId,
      assigneeAgentId: ownerAgent.id,
      status: issue.status,
    } as const;

    await expect(authorization.decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });

    const deletedMention = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      body: `[@Mentioned Agent](agent://${mentionedAgent.id}) this deleted comment should not count`,
      deletedAt: new Date(),
    }).returning().then((rows) => rows[0]!);
    expect(deletedMention.id).toBeTruthy();

    await expect(authorization.decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });

    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      body: `[@Mentioned Agent](agent://${mentionedAgent.id}) please respond here`,
      authorAgentId: ownerAgent.id,
    });

    await expect(authorization.decide({
      actor,
      action: "issue:read",
      resource,
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_issue_mention_grant",
    });
    await expect(authorization.decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_issue_mention_grant",
    });
    await expect(authorization.decide({
      actor,
      action: "issue:mutate",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("allows a mentioned non-assignee to comment when the mention author is the issue assignee", async () => {
    const company = await createCompany(db, "MentionCommentAssigneeGrant");
    const allowedProject = await createProject(db, company.id, "MentionAssigneeAllowed");
    const targetProject = await createProject(db, company.id, "MentionAssigneeTarget");
    const assigneeAgent = await createAgent(db, company.id, { role: "coach" });
    const mentionedAgent = await createAgent(db, company.id, {
      role: "qa",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [allowedProject.id],
          },
        },
      },
    });
    const issue = await createIssue(db, company.id, {
      title: "Assignee-authored mention reply target",
      projectId: targetProject.id,
      assigneeAgentId: assigneeAgent.id,
    });
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorAgentId: assigneeAgent.id,
      authorType: "agent",
      body: `[@QA](agent://${mentionedAgent.id}) please reply on this issue.`,
    });

    await expect(authorizationService(db).decide({
      actor: { type: "agent", agentId: mentionedAgent.id, companyId: company.id, source: "agent_key" },
      action: "issue:comment",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: issue.id,
        projectId: issue.projectId,
        assigneeAgentId: assigneeAgent.id,
        status: issue.status,
      },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_issue_mention_grant",
    });
  });

  it("does not grant mention-scoped issue access from self-authored or unauthorized-author comments", async () => {
    const company = await createCompany(db, "MentionCommentDenied");
    const allowedProject = await createProject(db, company.id, "MentionDeniedAllowed");
    const targetProject = await createProject(db, company.id, "MentionDeniedTarget");
    const ownerAgent = await createAgent(db, company.id, { role: "engineer" });
    const mentionedAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [allowedProject.id],
          },
        },
      },
    });
    const unrelatedAgent = await createAgent(db, company.id, { role: "engineer" });
    const issue = await createIssue(db, company.id, {
      title: "Mention-scoped comment denial target",
      projectId: targetProject.id,
      assigneeAgentId: ownerAgent.id,
    });

    const authorization = authorizationService(db);
    const actor = { type: "agent", agentId: mentionedAgent.id, companyId: company.id, source: "agent_key" } as const;
    const resource = {
      type: "issue",
      companyId: company.id,
      issueId: issue.id,
      projectId: issue.projectId,
      assigneeAgentId: ownerAgent.id,
      status: issue.status,
    } as const;

    await db.insert(issueComments).values([
      {
        companyId: company.id,
        issueId: issue.id,
        body: `Self mention [@Mentioned Agent](agent://${mentionedAgent.id})`,
        authorAgentId: mentionedAgent.id,
      },
      {
        companyId: company.id,
        issueId: issue.id,
        body: `Unauthorized mention [@Mentioned Agent](agent://${mentionedAgent.id})`,
        authorAgentId: unrelatedAgent.id,
      },
    ]);

    await expect(authorization.decide({
      actor,
      action: "issue:read",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("allows active board-user comments to create mention-scoped issue grants", async () => {
    const company = await createCompany(db, "MentionCommentBoardGrant");
    const allowedProject = await createProject(db, company.id, "MentionBoardAllowed");
    const targetProject = await createProject(db, company.id, "MentionBoardTarget");
    const ownerAgent = await createAgent(db, company.id, { role: "engineer" });
    const mentionedAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [allowedProject.id],
          },
        },
      },
    });
    const issue = await createIssue(db, company.id, {
      title: "Mention-scoped board grant target",
      projectId: targetProject.id,
      assigneeAgentId: ownerAgent.id,
    });
    const boardUserId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      body: `Board mention [@Mentioned Agent](agent://${mentionedAgent.id})`,
      authorUserId: boardUserId,
    });

    const actor = { type: "agent", agentId: mentionedAgent.id, companyId: company.id, source: "agent_key" } as const;
    const resource = {
      type: "issue",
      companyId: company.id,
      issueId: issue.id,
      projectId: issue.projectId,
      assigneeAgentId: ownerAgent.id,
      status: issue.status,
    } as const;

    await expect(authorizationService(db).decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_issue_mention_grant",
    });
  });

  it("limits viewer members to read-only visibility actions", async () => {
    const company = await createCompany(db, "BoardViewerVisibility");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "viewer",
    });

    const authorization = authorizationService(db);
    const actor = { type: "board", userId, source: "session" } as const;

    await expect(authorization.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "runtime:manage",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
    await expect(authorization.decide({
      actor,
      action: "secrets:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
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

  it("never elevates cloud_tenant actors through stale instance_admin rows", async () => {
    const tenantCompany = await createCompany(db, "CloudTenantStale");
    const otherCompany = await createCompany(db, "CloudTenantOther");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, otherCompany.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: tenantCompany.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    // Stale grant left behind by a pre-hardening cloud_tenant deployment.
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });

    const decision = await authorizationService(db).decide({
      actor: {
        type: "board",
        userId,
        companyIds: [tenantCompany.id],
        isInstanceAdmin: false,
        source: "cloud_tenant",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: otherCompany.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).not.toBe("allow_instance_admin");

    // Control: the instanceUserRoles lookup still elevates non-cloud_tenant
    // board actors, so the carve-out is scoped to the tenant contract only.
    const sessionDecision = await authorizationService(db).decide({
      actor: { type: "board", userId, companyIds: [tenantCompany.id], source: "session" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: otherCompany.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });
    expect(sessionDecision).toMatchObject({ allowed: true, reason: "allow_instance_admin" });
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

  it("denies active-checkout management outside the CEO caller company scope", async () => {
    const sourceCompany = await createCompany(db, "CheckoutSource");
    const targetCompany = await createCompany(db, "CheckoutTarget");
    const actorAgent = await createAgent(db, sourceCompany.id, { role: "ceo" });
    const targetAgent = await createAgent(db, targetCompany.id, { role: "engineer" });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: sourceCompany.id, source: "agent_jwt" },
      action: "tasks:manage_active_checkouts",
      resource: { type: "issue", companyId: targetCompany.id, assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_company_boundary",
    });
    expect(decision.explanation).toContain("another company");
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

  it("scopes task bridge keys away from company-wide reads and unrelated issue writes", async () => {
    const company = await createCompany(db, "TaskBridge");
    const bridgeAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    const project = await createProject(db, company.id, "Bridge");
    const parentIssue = await createIssue(db, company.id, { projectId: project.id });
    const assignedIssue = await createIssue(db, company.id, { assigneeAgentId: bridgeAgent.id });
    const keyId = randomUUID();
    const bridgeCreatedIssue = await createIssue(db, company.id, {
      originKind: "task_bridge",
      originId: keyId,
    });
    const unrelatedIssue = await createIssue(db, company.id);
    const actor = {
      type: "agent" as const,
      agentId: bridgeAgent.id,
      companyId: company.id,
      source: "agent_key" as const,
      keyId,
      keyScope: {
        kind: "task_bridge" as const,
        parentIssueId: parentIssue.id,
        allowedAssigneeAgentIds: [targetAgent.id],
      },
    };
    const authz = authorizationService(db);

    await expect(authz.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });

    await expect(authz.decide({
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: company.id,
        parentIssueId: parentIssue.id,
        assigneeAgentId: targetAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: true,
    });

    await expect(authz.decide({
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: company.id,
        projectId: project.id,
        assigneeUserId: randomUUID(),
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });

    await expect(authz.decide({
      actor,
      action: "issue:comment",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: assignedIssue.id,
      },
    })).resolves.toMatchObject({
      allowed: true,
    });

    await expect(authz.decide({
      actor,
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: bridgeCreatedIssue.id,
      },
    })).resolves.toMatchObject({
      allowed: true,
    });

    await expect(authz.decide({
      actor,
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: unrelatedIssue.id,
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });

    await expect(authz.decide({
      actor,
      action: "agent_config:read",
      resource: {
        type: "agent",
        companyId: company.id,
        agentId: bridgeAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });
  });
});
