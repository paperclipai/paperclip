import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  catalogSkillListQuerySchema,
  companySkillCommentCreateSchema,
  companySkillCommentUpdateSchema,
  companySkillCreateSchema,
  companySkillFileDeleteSchema,
  companySkillFileUpdateSchema,
  companySkillForkSchema,
  companySkillImportSchema,
  companySkillInstallCatalogSchema,
  companySkillInstallUpdateSchema,
  companySkillListQuerySchema,
  companySkillProjectScanRequestSchema,
  companySkillResetSchema,
  companySkillTestInputCreateSchema,
  companySkillTestInputUpdateSchema,
  companySkillTestRunTemplateCreateSchema,
  companySkillTestRunTemplateUpdateSchema,
  companySkillTestRunCreateSchema,
  companySkillTestRunListQuerySchema,
  companySkillUpdateSchema,
  companySkillVersionCreateSchema,
} from "@paperclipai/shared";
import { trackSkillImported } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  companySkillService,
  heartbeatService,
  issueService,
  logActivity,
} from "../services/index.js";
import { isGitRepoSkillImportSource, parseSkillImportSourceInput } from "../services/company-skills.js";
import {
  getCatalogSkillOrThrow,
  listCatalogSkillsOrEmpty,
  readCatalogSkillFile,
} from "../services/skills-catalog.js";
import { forbidden, unauthorized } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";
import {
  companySkillPolicyService,
  normalizeSkillPolicySourceType,
  type SkillPolicyPrincipal,
} from "../services/company-skill-policy.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import {
  normalizeSkillPolicySourceLocator,
  type SkillPolicyAction,
  type SkillPolicyDecision,
  type SkillPolicyEvaluationResource,
} from "@paperclipai/shared";

type SkillTelemetryInput = {
  key: string;
  slug: string;
  sourceType: string;
  sourceLocator: string | null;
  metadata: Record<string, unknown> | null;
};

type SkillPolicyDenialResponse = {
  code: "skill_policy_denied";
  reason: SkillPolicyDecision["reason"];
  remediation?: string;
};

type SkillTestRunAssignmentAuthorizationScope = {
  issueId?: string | null;
  projectId?: string | null;
  parentIssueId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type SkillPolicyResourceInput =
  | SkillPolicyEvaluationResource
  | Promise<SkillPolicyEvaluationResource>
  | (() => SkillPolicyEvaluationResource | Promise<SkillPolicyEvaluationResource>);

export function companySkillRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const svc = companySkillService(db);
  const issues = issueService(db);
  const heartbeat = heartbeatService(db);
  const skillPolicies = companySkillPolicyService(db);

  function asString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function deriveTrackedSkillRef(skill: SkillTelemetryInput): string | null {
    if (skill.sourceType === "skills_sh") {
      return skill.key;
    }
    if (skill.sourceType !== "github") {
      return null;
    }
    const hostname = asString(skill.metadata?.hostname);
    if (hostname !== "github.com") {
      return null;
    }
    return skill.key;
  }

  function firstQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  }

  function queryStringArray(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
    return [];
  }

  function toSkillPolicyDenialResponse(
    decision: Pick<SkillPolicyDecision, "reason" | "remediation">,
  ): SkillPolicyDenialResponse {
    return {
      code: "skill_policy_denied",
      reason: decision.reason,
      ...(typeof decision.remediation === "string" ? { remediation: decision.remediation } : {}),
    };
  }

  function skillActor(req: Request) {
    if (req.actor.type === "agent") {
      return { type: "agent" as const, agentId: req.actor.agentId ?? null };
    }
    if (req.actor.type === "board") {
      return { type: "user" as const, userId: req.actor.userId ?? null };
    }
    return { type: "system" as const };
  }

  async function skillPolicyPrincipal(req: Request, companyId: string): Promise<SkillPolicyPrincipal> {
    if (req.actor.type === "agent" && req.actor.agentId) {
      return skillPolicies.resolveAgentPrincipal(companyId, req.actor.agentId);
    }
    if (req.actor.type === "board") {
      return { type: "board", id: req.actor.userId ?? "board", role: "board" };
    }
    throw unauthorized("Authentication required");
  }

  async function skillPolicyResource(input: {
    companyId: string;
    skillId?: string | null;
    skillKey?: unknown;
    sourceType?: string | null;
    sourceLocator?: unknown;
  }): Promise<SkillPolicyEvaluationResource> {
    const stored = input.skillId ? await svc.getById(input.companyId, input.skillId) : null;
    const sourceLocator = asString(input.sourceLocator) ?? stored?.sourceLocator ?? undefined;
    return {
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(asString(input.skillKey) || stored?.key ? { skillKey: asString(input.skillKey) ?? stored?.key } : {}),
      ...((input.sourceType || stored?.sourceType) ? {
        sourceType: normalizeSkillPolicySourceType(input.sourceType ?? stored?.sourceType),
      } : {}),
      ...(sourceLocator ? { sourceLocator: normalizeSkillPolicySourceLocator(sourceLocator) } : {}),
    };
  }

  function skillImportPolicyResource(source: string): SkillPolicyEvaluationResource {
    const parsed = parseSkillImportSourceInput(source);
    const resolvedSource = parsed.resolvedSource;
    return {
      sourceType: normalizeSkillPolicySourceType(
        isGitRepoSkillImportSource(resolvedSource) ? "git" : /^https?:\/\//i.test(resolvedSource) ? "external_package" : "workspace",
      ),
      sourceLocator: normalizeSkillPolicySourceLocator(resolvedSource),
    };
  }

  async function assertCanMutateCompanySkills(
    req: Request,
    companyId: string,
    action: SkillPolicyAction,
    resource: SkillPolicyResourceInput = {},
  ) {
    if (req.actor.type === "none") {
      throw unauthorized("Authentication required");
    }
    if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company", { code: "skill_company_boundary_denied" });
    }
    assertCompanyAccess(req, companyId);
    const platformDecision = await access.decide({
      actor: req.actor,
      action: "skill_config:update",
      resource: { type: "company", companyId },
    });
    // Legacy missing-grant and suggest-change-consent denials are not platform
    // invariants for skills. The company skill policy is the governance layer;
    // authentication, company boundaries, and safety checks still fail closed.
    if (
      !platformDecision.allowed
      && !["deny_no_grant", "deny_missing_consent", "deny_missing_grant"].includes(platformDecision.reason)
    ) {
      throw forbidden(platformDecision.explanation, {
        code: platformDecision.reason === "deny_company_boundary"
          ? "skill_company_boundary_denied"
          : "skill_actor_restricted",
        reason: "platform_invariant",
      });
    }
    const resolvedResource = typeof resource === "function" ? await resource() : await resource;
    const policyDecision = await skillPolicies.evaluate({
      companyId,
      principal: await skillPolicyPrincipal(req, companyId),
      action,
      resource: resolvedResource,
    });
    if (!policyDecision.allowed) {
      throw forbidden("Skill action denied by company policy", toSkillPolicyDenialResponse(policyDecision));
    }
  }

  async function assertCanOrchestrateSkillTestHarness(
    req: Request,
    companyId: string,
    assignmentScope: SkillTestRunAssignmentAuthorizationScope = {},
  ) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: assignmentScope.issueId ?? null,
        projectId: assignmentScope.projectId ?? null,
        parentIssueId: assignmentScope.parentIssueId ?? null,
        assigneeAgentId: assignmentScope.assigneeAgentId ?? null,
        assigneeUserId: assignmentScope.assigneeUserId ?? null,
      },
      scope: assignmentScope,
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function loadSkillTestRunAssignmentScope(
    companyId: string,
    skillId: string,
    runId: string,
  ): Promise<SkillTestRunAssignmentAuthorizationScope> {
    const run = await svc.getTestRunDetail(companyId, skillId, runId);
    if (!run?.issueId) return {};
    const issue = await issues.getById(run.issueId);
    if (!issue || issue.companyId !== companyId) {
      return {
        issueId: run.issueId,
        assigneeAgentId: run.agentId ?? null,
      };
    }
    return {
      issueId: issue.id,
      projectId: issue.projectId ?? null,
      parentIssueId: issue.parentId ?? null,
      assigneeAgentId: issue.assigneeAgentId ?? run.agentId ?? null,
      assigneeUserId: issue.assigneeUserId ?? null,
    };
  }

  router.get("/skills/catalog", async (req, res) => {
    assertAuthenticated(req);
    const query = catalogSkillListQuerySchema.parse({
      kind: firstQueryString(req.query.kind),
      category: firstQueryString(req.query.category),
      q: firstQueryString(req.query.q),
    });
    res.json(listCatalogSkillsOrEmpty(query));
  });

  router.get("/skills/catalog/:catalogId/files", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    const relativePath = firstQueryString(req.query.path) ?? "SKILL.md";
    res.json(await readCatalogSkillFile(catalogRef, relativePath));
  });

  router.get("/skills/catalog/:catalogId", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    res.json(getCatalogSkillOrThrow(catalogRef));
  });

  router.get("/companies/:companyId/skills", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId, companySkillListQuerySchema.parse({
      q: firstQueryString(req.query.q),
      sort: firstQueryString(req.query.sort),
      categories: [
        ...queryStringArray(req.query.category),
        ...queryStringArray(req.query.categories),
        ...queryStringArray(req.query["categories[]"]),
      ],
      scope: firstQueryString(req.query.scope),
      include: [
        ...queryStringArray(req.query.include),
        ...queryStringArray(req.query["include[]"]),
      ],
    }));
    res.json(result);
  });

  router.get("/companies/:companyId/skills/categories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.categoryCounts(companyId));
  });

  router.get("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.detail(companyId, skillId, skillActor(req));
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/fork-precheck", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.forkPrecheck(companyId, skillId, skillActor(req));
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listVersions(companyId, skillId));
  });

  router.get("/companies/:companyId/skills/:skillId/versions/:versionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const versionId = req.params.versionId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getVersion(companyId, skillId, versionId);
    if (!result) {
      res.status(404).json({ error: "Skill version not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/test-inputs", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listTestInputs(companyId, skillId));
  });

  router.post(
    "/companies/:companyId/skills/:skillId/test-inputs",
    validate(companySkillTestInputCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.createTestInput(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_test_input_created",
        entityType: "company_skill_test_input",
        entityId: result.id,
        details: { skillId, name: result.name },
      });
      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/test-inputs/:inputId",
    validate(companySkillTestInputUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      const inputId = req.params.inputId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.updateTestInput(companyId, skillId, inputId, req.body);
      if (!result) {
        res.status(404).json({ error: "Test input not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_test_input_updated",
        entityType: "company_skill_test_input",
        entityId: result.id,
        details: { skillId, changedKeys: Object.keys(req.body).sort() },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId/test-inputs/:inputId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const inputId = req.params.inputId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
    const result = await svc.deleteTestInput(companyId, skillId, inputId);
    if (!result) {
      res.status(404).json({ error: "Test input not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_test_input_deleted",
      entityType: "company_skill_test_input",
      entityId: result.id,
      details: { skillId, name: result.name },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/skill-test-run-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listTestRunTemplates(companyId));
  });

  router.post(
    "/companies/:companyId/skill-test-run-templates",
    validate(companySkillTestRunTemplateCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit");
      const result = await svc.createTestRunTemplate(companyId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_test_run_template_created",
        entityType: "company_skill_test_run_template",
        entityId: result.id,
        details: { name: result.name },
      });
      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skill-test-run-templates/:templateId",
    validate(companySkillTestRunTemplateUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const templateId = req.params.templateId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit");
      const result = await svc.updateTestRunTemplate(companyId, templateId, req.body, skillActor(req));
      if (!result) {
        res.status(404).json({ error: "Test run template not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_test_run_template_updated",
        entityType: "company_skill_test_run_template",
        entityId: result.id,
        details: { changedKeys: Object.keys(req.body).sort() },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skill-test-run-templates/:templateId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const templateId = req.params.templateId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.edit");
    const result = await svc.deleteTestRunTemplate(companyId, templateId);
    if (!result) {
      res.status(404).json({ error: "Test run template not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_test_run_template_deleted",
      entityType: "company_skill_test_run_template",
      entityId: result.id,
      details: { name: result.name },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/test-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const query = companySkillTestRunListQuerySchema.parse({
      inputId: firstQueryString(req.query.inputId),
    });
    res.json(await svc.listTestRuns(companyId, skillId, query));
  });

  router.get("/companies/:companyId/skills/:skillId/test-runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const runId = req.params.runId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getTestRunDetail(companyId, skillId, runId);
    if (!result) {
      res.status(404).json({ error: "Test run not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/test-runs",
    validate(companySkillTestRunCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.test", () => skillPolicyResource({ companyId, skillId }));
      await assertCanOrchestrateSkillTestHarness(req, companyId, {
        assigneeAgentId: req.body.agentId,
      });
      const actor = getActorInfo(req);
      const result = await svc.createTestRun(companyId, skillId, req.body, skillActor(req), {
        createHarnessIssue: async (harnessIssue) => {
          const created = await issues.create(companyId, {
            ...harnessIssue,
            priority: "medium",
            createdByAgentId: actor.agentId,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            actorRunId: actor.runId,
          });
          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.created",
            entityType: "issue",
            entityId: created.id,
            details: {
              title: created.title,
              identifier: created.identifier,
              harnessKind: "skill_test",
              source: "company_skill_test_run",
              skillId,
            },
          });
          return { id: created.id };
        },
        wakeHarnessIssue: async (issueId, agentId) => heartbeat.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "skill_test_run_created",
          payload: { issueId, skillId },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId, source: "company.skill_test_run" },
        }),
        cleanupHarnessIssue: async (issueId) => {
          const issue = await issues.getById(issueId);
          if (!issue || issue.companyId !== companyId) return;
          await issues.update(issueId, {
            status: "cancelled",
            hiddenAt: new Date(),
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
          });
          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "company.skill_test_harness_issue_cleaned_up",
            entityType: "issue",
            entityId: issueId,
            details: { skillId },
          });
        },
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_test_run_created",
        entityType: "company_skill_test_run",
        entityId: result.id,
        details: {
          skillId,
          inputId: result.inputId,
          skillVersionId: result.skillVersionId,
          agentId: result.agentId,
          issueId: result.issueId,
        },
      });
      res.status(201).json(result);
    },
  );

  router.post("/companies/:companyId/skills/:skillId/test-runs/:runId/cancel", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const runId = req.params.runId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.test", () => skillPolicyResource({ companyId, skillId }));
    await assertCanOrchestrateSkillTestHarness(req, companyId, await loadSkillTestRunAssignmentScope(companyId, skillId, runId));
    const actor = getActorInfo(req);
    const result = await svc.cancelTestRun(companyId, skillId, runId, {
      cancelHarnessIssue: async (issueId) => {
        const issue = await issues.getById(issueId);
        if (!issue || issue.companyId !== companyId) return;
        if (issue.executionRunId) {
          await heartbeat.cancelRun(issue.executionRunId, "Cancelled by skill test run request");
        }
        if (issue.status !== "done" && issue.status !== "cancelled") {
          await issues.update(issueId, {
            status: "cancelled",
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
          });
        }
      },
    });
    if (!result) {
      res.status(404).json({ error: "Test run not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_test_run_cancelled",
      entityType: "company_skill_test_run",
      entityId: result.id,
      details: { skillId, issueId: result.issueId },
    });
    res.json(result);
  });

  router.delete("/companies/:companyId/skills/:skillId/test-runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const runId = req.params.runId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.test", () => skillPolicyResource({ companyId, skillId }));
    await assertCanOrchestrateSkillTestHarness(req, companyId, await loadSkillTestRunAssignmentScope(companyId, skillId, runId));
    const actor = getActorInfo(req);
    const result = await svc.deleteTestRun(companyId, skillId, runId, {
      hideHarnessIssue: async (issueId) => {
        const issue = await issues.getById(issueId);
        if (!issue || issue.companyId !== companyId) return;
        await issues.update(issueId, {
          hiddenAt: new Date(),
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
        });
      },
    });
    if (!result) {
      res.status(404).json({ error: "Test run not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_test_run_deleted",
      entityType: "company_skill_test_run",
      entityId: result.id,
      details: { skillId, issueId: result.issueId },
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/versions",
    validate(companySkillVersionCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.create", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.createVersion(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_version_created",
        entityType: "company_skill_version",
        entityId: result.id,
        details: {
          skillId,
          revisionNumber: result.revisionNumber,
          label: result.label,
        },
      });
      res.status(201).json(result);
    },
  );

  router.post("/companies/:companyId/skills/:skillId/star", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.starSkill(companyId, skillId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_starred",
      entityType: "company_skill",
      entityId: skillId,
      details: { starCount: result.starCount },
    });
    res.json(result);
  });

  router.delete("/companies/:companyId/skills/:skillId/star", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.unstarSkill(companyId, skillId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_unstarred",
      entityType: "company_skill",
      entityId: skillId,
      details: { starCount: result.starCount },
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/fork",
    validate(companySkillForkSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(
        req,
        companyId,
        "skills.create",
        () => skillPolicyResource({ companyId, skillId }),
      );
      const result = await svc.forkSkill(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_forked",
        entityType: "company_skill",
        entityId: result.skill.id,
        details: {
          sourceSkillId: skillId,
          slug: result.skill.slug,
          name: result.skill.name,
          reassignedAgentIds: result.reassignments.map((entry: { agentId: string }) => entry.agentId),
        },
      });
      res.status(201).json(result);
    },
  );

  router.get("/companies/:companyId/skills/:skillId/comments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listComments(companyId, skillId));
  });

  router.post(
    "/companies/:companyId/skills/:skillId/comments",
    validate(companySkillCommentCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createComment(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_comment_created",
        entityType: "company_skill_comment",
        entityId: result.id,
        details: { skillId, parentCommentId: result.parentCommentId },
      });
      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/comments/:commentId",
    validate(companySkillCommentUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      const commentId = req.params.commentId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateComment(companyId, skillId, commentId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_comment_updated",
        entityType: "company_skill_comment",
        entityId: result.id,
        details: { skillId },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId/comments/:commentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const commentId = req.params.commentId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.deleteComment(companyId, skillId, commentId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_comment_deleted",
      entityType: "company_skill_comment",
      entityId: result.id,
      details: { skillId },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/update-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.updateStatus(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/files", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const relativePath = String(req.query.path ?? "SKILL.md");
    assertCompanyAccess(req, companyId);
    const result = await svc.readFile(companyId, skillId, relativePath);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills",
    validate(companySkillCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.create", {
        sourceType: "generated",
      });
      const result = await svc.createLocalSkill(companyId, req.body, skillActor(req));

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_created",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          name: result.name,
        },
      });

      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId",
    validate(companySkillUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.updateSkill(companyId, skillId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_updated",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          categories: result.categories,
          sharingScope: result.sharingScope,
        },
      });

      res.json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/files",
    validate(companySkillFileUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.updateFile(
        companyId,
        skillId,
        String(req.body.path ?? ""),
        String(req.body.content ?? ""),
        skillActor(req),
      );

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_file_updated",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          path: result.path,
          markdown: result.markdown,
        },
      });

      res.json(result);
    },
  );

  router.delete(
    "/companies/:companyId/skills/:skillId/files",
    validate(companySkillFileDeleteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.deleteFile(companyId, skillId, req.body, skillActor(req));

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_file_deleted",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          path: result.path,
          target: result.target,
          deletedPaths: result.deletedPaths,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/import",
    validate(companySkillImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const source = String(req.body.source ?? "");
      await assertCanMutateCompanySkills(req, companyId, "skills.import", () => skillImportPolicyResource(source));
      const result = await svc.importFromSource(companyId, source);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_imported",
        entityType: "company",
        entityId: companyId,
        details: {
          source,
          importedCount: result.imported.length,
          importedSlugs: result.imported.map((skill) => skill.slug),
          warningCount: result.warnings.length,
        },
      });
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        for (const skill of result.imported) {
          trackSkillImported(telemetryClient, {
            sourceType: skill.sourceType,
            skillRef: deriveTrackedSkillRef(skill),
          });
        }
      }

      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/install-catalog",
    validate(companySkillInstallCatalogSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.install", {
        sourceType: "catalog",
        sourceLocator: req.body.catalogSkillId,
      });
      const result = await svc.installFromCatalog(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: result.action === "created" ? "company.skill_catalog_installed" : "company.skill_catalog_updated",
        entityType: "company_skill",
        entityId: result.skill.id,
        details: {
          action: result.action,
          catalogId: result.catalogSkill.id,
          catalogKey: result.catalogSkill.key,
          slug: result.skill.slug,
          originHash: result.catalogSkill.contentHash,
          warningCount: result.warnings.length,
        },
      });

      res.status(result.action === "created" ? 201 : 200).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/scan-projects",
    validate(companySkillProjectScanRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.import", { sourceType: "workspace" });
      const result = await svc.scanProjectWorkspaces(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_scanned",
        entityType: "company",
        entityId: companyId,
        details: {
          scannedProjects: result.scannedProjects,
          scannedWorkspaces: result.scannedWorkspaces,
          discovered: result.discovered,
          importedCount: result.imported.length,
          updatedCount: result.updated.length,
          conflictCount: result.conflicts.length,
          warningCount: result.warnings.length,
        },
      });

      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.remove", () => skillPolicyResource({ companyId, skillId }));
    const result = await svc.deleteSkill(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_deleted",
      entityType: "company_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        name: result.name,
      },
    });

    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/audit",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.test", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.auditSkill(companyId, skillId);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_audited",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          verdict: result.verdict,
          codes: result.codes,
          installedHash: result.installedHash,
          originHash: result.originHash,
          scanVersion: result.scanVersion,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/:skillId/install-update",
    validate(companySkillInstallUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.update", () => skillPolicyResource({ companyId, skillId }));
      const before = await svc.getById(companyId, skillId);
      const result = await svc.installUpdate(companyId, skillId, req.body);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_update_installed",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          previousOriginHash: before?.metadata?.originHash ?? before?.sourceRef ?? null,
          previousOriginVersion: before?.metadata?.originVersion ?? null,
          newOriginHash: result.metadata?.originHash ?? result.sourceRef,
          newOriginVersion: result.metadata?.originVersion ?? null,
          driftDetected: Boolean(before?.metadata?.userModifiedAt),
          force: Boolean(req.body.force),
          auditVerdict: result.metadata?.auditVerdict ?? null,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/:skillId/reset",
    validate(companySkillResetSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.reset", () => skillPolicyResource({ companyId, skillId }));
      const before = await svc.getById(companyId, skillId);
      const result = await svc.resetSkill(companyId, skillId, req.body);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_reset",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          previousOriginHash: before?.metadata?.originHash ?? before?.sourceRef ?? null,
          previousOriginVersion: before?.metadata?.originVersion ?? null,
          newOriginHash: result.metadata?.originHash ?? result.sourceRef,
          newOriginVersion: result.metadata?.originVersion ?? null,
          driftDetected: Boolean(before?.metadata?.userModifiedAt),
          force: Boolean(req.body.force),
          auditVerdict: result.metadata?.auditVerdict ?? null,
        },
      });

      res.json(result);
    },
  );

  return router;
}
