import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySkillPolicies,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillPolicyService } from "../services/company-skill-policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("companySkillPolicyService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companySkillPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(role = "engineer") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Policy Co",
      issuePrefix: `P${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Policy Agent",
      role,
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    });
    return { companyId, agentId, principal: { type: "agent" as const, id: agentId, role } };
  }

  it("allows every canonical action when no explicit policy exists", async () => {
    const seeded = await seedAgent();
    const service = companySkillPolicyService(db);
    for (const action of [
      "skills.create",
      "skills.import",
      "skills.install",
      "skills.edit",
      "skills.update",
      "skills.test",
      "skills.reset",
      "skills.remove",
    ] as const) {
      await expect(service.evaluate({
        companyId: seeded.companyId,
        principal: seeded.principal,
        action,
      })).resolves.toMatchObject({ allowed: true, action, reason: "no_policy_default", policyRevision: 0 });
    }
  });

  it("evaluates protected resources, role overrides, and agent overrides deterministically", async () => {
    const seeded = await seedAgent("security");
    const service = companySkillPolicyService(db);
    const protectedSkillId = randomUUID();
    await service.replace({
      companyId: seeded.companyId,
      expectedRevision: 0,
      policy: {
        schemaVersion: 1,
        defaultEffect: "allow",
        rules: [
          {
            id: "agent-override",
            priority: 1,
            effect: "allow",
            subject: { type: "agents", agentIds: [seeded.agentId] },
            actions: ["skills.install"],
            resources: { sourceTypes: ["external_package"] },
          },
          {
            id: "security-override",
            priority: 5,
            effect: "allow",
            subject: { type: "roles", roles: ["security"] },
            actions: ["skills.edit"],
            resources: { skillIds: [protectedSkillId] },
          },
          {
            id: "protected-skill",
            priority: 10,
            effect: "deny",
            subject: { type: "all_agents" },
            actions: ["skills.edit", "skills.remove"],
            resources: { skillIds: [protectedSkillId] },
          },
          {
            id: "deny-external",
            priority: 20,
            effect: "deny",
            subject: { type: "all_agents" },
            actions: ["skills.install"],
            resources: { sourceTypes: ["external_package"] },
          },
        ],
      },
      activity: { actorType: "agent", actorId: seeded.agentId, agentId: seeded.agentId },
    });

    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.edit",
      resource: { skillId: protectedSkillId },
    })).resolves.toMatchObject({ allowed: true, matchedRuleId: "security-override" });
    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.remove",
      resource: { skillId: protectedSkillId },
    })).resolves.toMatchObject({ allowed: false, reason: "explicit_rule", matchedRuleId: "protected-skill" });
    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.install",
      resource: { sourceType: "external_package" },
    })).resolves.toMatchObject({ allowed: true, matchedRuleId: "agent-override" });
  });

  it("uses retained legacy grants only after explicit rules fail to match", async () => {
    const seeded = await seedAgent();
    const service = companySkillPolicyService(db);
    await db.insert(companySkillPolicies).values({
      companyId: seeded.companyId,
      schemaVersion: 1,
      revision: 3,
      defaultEffect: "deny",
      rules: [{
        id: "deny-removal",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.remove"],
      }],
    });
    await db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "agent",
      principalId: seeded.agentId,
      permissionKey: "skills:create",
      scope: null,
    });

    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.edit",
    })).resolves.toMatchObject({ allowed: true, reason: "legacy_compatibility" });
    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.remove",
    })).resolves.toMatchObject({ allowed: false, reason: "explicit_rule" });
  });

  /**
   * This reader goes to `principal_permission_grants` directly rather than
   * through `decidePrincipalGrant`, so it is its own place for expiry to be
   * forgotten — and forgetting it here would be invisible from the
   * authorization service's tests. A lapsed grant has to confer nothing on
   * every path that reads one, not only the one that owns the rule
   * (FAI-10152 round 4).
   *
   * The pair matters: the unexpired case proves the bypass still works, so a
   * reader that simply stopped finding grants could not pass both.
   */
  const legacyGrantExpiries: Array<[string, Date | null, boolean]> = [
    ["no expiry", null, true],
    ["an expiry in the future", new Date(Date.now() + 60 * 60 * 1000), true],
    ["an expiry in the past", new Date(Date.now() - 60 * 1000), false],
  ];

  it.each(legacyGrantExpiries)("honours a legacy grant with %s", async (
    _label,
    expiresAt,
    expected,
  ) => {
    const seeded = await seedAgent();
    const service = companySkillPolicyService(db);
    await db.insert(companySkillPolicies).values({
      companyId: seeded.companyId,
      schemaVersion: 1,
      revision: 1,
      defaultEffect: "deny",
      rules: [],
    });
    await db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "agent",
      principalId: seeded.agentId,
      permissionKey: "skills:create",
      scope: null,
      expiresAt,
    });

    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.edit",
    })).resolves.toMatchObject(
      expected
        ? { allowed: true, reason: "legacy_compatibility" }
        : { allowed: false },
    );
  });

  it("matches sourceLocator deny rules regardless of GitHub URL casing or .git suffix", async () => {
    const seeded = await seedAgent();
    const service = companySkillPolicyService(db);
    await service.replace({
      companyId: seeded.companyId,
      expectedRevision: 0,
      policy: {
        schemaVersion: 1,
        defaultEffect: "allow",
        rules: [{
          id: "deny-repo",
          priority: 1,
          effect: "deny",
          subject: { type: "all_agents" },
          actions: ["skills.import"],
          resources: { sourceLocators: ["https://WWW.GitHub.com/Owner/Repo.git"] },
        }],
      },
      activity: { actorType: "agent", actorId: seeded.agentId, agentId: seeded.agentId },
    });

    const stored = await service.get(seeded.companyId);
    expect(stored.rules[0]!.resources!.sourceLocators).toEqual(["https://github.com/owner/repo"]);
    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.import",
      resource: { sourceType: "git", sourceLocator: "https://github.com/owner/repo" },
    })).resolves.toMatchObject({ allowed: false, reason: "explicit_rule", matchedRuleId: "deny-repo" });
    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.import",
      resource: { sourceType: "git", sourceLocator: "https://github.com/Owner/Repo.git" },
    })).resolves.toMatchObject({ allowed: false, reason: "explicit_rule", matchedRuleId: "deny-repo" });
    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.import",
      resource: { sourceType: "git", sourceLocator: "https://github.com/owner/other-repo" },
    })).resolves.toMatchObject({ allowed: true, reason: "policy_default" });
  });

  it("matches deny rules persisted before locator normalization existed", async () => {
    const seeded = await seedAgent();
    const service = companySkillPolicyService(db);
    await db.insert(companySkillPolicies).values({
      companyId: seeded.companyId,
      schemaVersion: 1,
      revision: 2,
      defaultEffect: "allow",
      rules: [{
        id: "legacy-deny-repo",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.import"],
        resources: { sourceLocators: ["https://github.com/Owner/Repo.git"] },
      }],
    });

    await expect(service.evaluate({
      companyId: seeded.companyId,
      principal: seeded.principal,
      action: "skills.import",
      resource: { sourceType: "git", sourceLocator: "https://github.com/owner/repo" },
    })).resolves.toMatchObject({ allowed: false, reason: "explicit_rule", matchedRuleId: "legacy-deny-repo" });
  });

  it("rejects cross-company simulation principals", async () => {
    const first = await seedAgent();
    const second = await seedAgent();
    const service = companySkillPolicyService(db);
    await expect(service.resolveAgentPrincipal(first.companyId, second.agentId)).rejects.toMatchObject({
      status: 403,
      details: { code: "skill_company_boundary_denied" },
    });
  });

  it("rolls back policy replacement when the required activity record cannot persist", async () => {
    const seeded = await seedAgent();
    const service = companySkillPolicyService(db);
    await expect(service.replace({
      companyId: seeded.companyId,
      expectedRevision: 0,
      policy: { schemaVersion: 1, defaultEffect: "deny", rules: [] },
      activity: {
        actorType: "agent",
        actorId: seeded.agentId,
        agentId: randomUUID(),
      },
    })).rejects.toBeDefined();
    await expect(service.get(seeded.companyId)).resolves.toMatchObject({
      revision: 0,
      materialized: false,
      defaultEffect: "allow",
    });
  });
});
