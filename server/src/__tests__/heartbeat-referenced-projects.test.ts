import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { projectService } from "../services/projects.ts";
import {
  isMultiProjectWorkspaceSyncEnabled,
  MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS,
  MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS,
  MULTI_PROJECT_WORKSPACE_SYNC_ENV,
  resolveRunReferencedProjects,
  type ResolveRunReferencedProjectsOptions,
} from "../services/heartbeat.ts";
import type { AuthorizationActor, AuthorizationDecision } from "../services/authorization.ts";
import { buildProjectMentionHref } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("multi-project workspace sync kill-switch", () => {
  it("is OFF by default and enabled only by truthy env values", () => {
    expect(isMultiProjectWorkspaceSyncEnabled({})).toBe(false);
    expect(isMultiProjectWorkspaceSyncEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_ENV]: "" })).toBe(false);
    expect(isMultiProjectWorkspaceSyncEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_ENV]: "false" })).toBe(false);
    expect(isMultiProjectWorkspaceSyncEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_ENV]: "0" })).toBe(false);
    expect(isMultiProjectWorkspaceSyncEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_ENV]: "true" })).toBe(true);
    expect(isMultiProjectWorkspaceSyncEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_ENV]: "1" })).toBe(true);
    expect(isMultiProjectWorkspaceSyncEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_ENV]: "on" })).toBe(true);
  });
});

describeEmbeddedPostgres("resolveRunReferencedProjects", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let projectsSvc!: ReturnType<typeof projectService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-referenced-projects-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
    projectsSvc = projectService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const buildActor = (companyId: string): AuthorizationActor => ({
    type: "agent",
    agentId: randomUUID(),
    companyId,
    source: "agent_key",
  });

  const decision = (allowed: boolean): AuthorizationDecision => ({
    allowed,
    action: "project:read",
    reason: allowed ? "allow_company_agent" : "deny_company_boundary",
    explanation: "test decision",
  });

  // Records every project:read authorization call and answers via the supplied resolver.
  const recordingAccess = (
    resolve: (projectId: string) => AuthorizationDecision | Promise<AuthorizationDecision>,
  ) => {
    const decidedProjectIds: string[] = [];
    const access: ResolveRunReferencedProjectsOptions["access"] = {
      decide: async (input) => {
        const resource = input.resource;
        const projectId = resource.type === "project" ? resource.projectId ?? "" : "";
        decidedProjectIds.push(projectId);
        return resolve(projectId);
      },
    };
    return { decidedProjectIds, access };
  };

  const seedCompany = async (companyId: string) => {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  };

  const seedIssueWithMentions = async (input: {
    companyId: string;
    issueId: string;
    anchorProjectId: string | null;
    mentionedProjectIds: string[];
  }) => {
    const mentionMarkup = input.mentionedProjectIds
      .map((projectId, index) => `[Ref${index}](${buildProjectMentionHref(projectId)})`)
      .join(" ");
    await db.insert(issues).values({
      id: input.issueId,
      companyId: input.companyId,
      projectId: input.anchorProjectId,
      title: `Referencing ${mentionMarkup}`,
      description: null,
      status: "todo",
      priority: "medium",
    });
  };

  const baseOpts = (
    companyId: string,
    access: ResolveRunReferencedProjectsOptions["access"],
    overrides?: Partial<ResolveRunReferencedProjectsOptions>,
  ): ResolveRunReferencedProjectsOptions => ({
    companyId,
    actor: buildActor(companyId),
    issues: issuesSvc,
    projects: projectsSvc,
    access,
    ...overrides,
  });

  it("admits a same-company project that passes project:read", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const mentionedProjectId = randomUUID();

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      { id: mentionedProjectId, companyId, name: "Mentioned", status: "in_progress" },
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds: [mentionedProjectId] });

    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    const result = await resolveRunReferencedProjects(issueId, anchorProjectId, baseOpts(companyId, access));

    expect(result.anchor?.projectId).toBe(anchorProjectId);
    expect(result.additional.map((entry) => entry.projectId)).toEqual([mentionedProjectId]);
    expect(result.warnings).toEqual([]);
    // The anchor is never re-authorized; only the additional project is checked.
    expect(decidedProjectIds).toEqual([mentionedProjectId]);
  });

  it("dedupes the anchor against the mentioned set (anchor wins)", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const mentionedProjectId = randomUUID();

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      { id: mentionedProjectId, companyId, name: "Mentioned", status: "in_progress" },
    ]);
    // The anchor is also @-mentioned in the body; it must not appear in `additional`.
    await seedIssueWithMentions({
      companyId,
      issueId,
      anchorProjectId,
      mentionedProjectIds: [anchorProjectId, mentionedProjectId],
    });

    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    const result = await resolveRunReferencedProjects(issueId, anchorProjectId, baseOpts(companyId, access));

    expect(result.anchor?.projectId).toBe(anchorProjectId);
    expect(result.additional.map((entry) => entry.projectId)).toEqual([mentionedProjectId]);
    expect(decidedProjectIds).not.toContain(anchorProjectId);
  });

  it("drops a foreign-company project before authorization", async () => {
    const companyId = randomUUID();
    const foreignCompanyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const foreignProjectId = randomUUID();

    await seedCompany(companyId);
    await seedCompany(foreignCompanyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      { id: foreignProjectId, companyId: foreignCompanyId, name: "Foreign", status: "in_progress" },
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds: [foreignProjectId] });

    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    const result = await resolveRunReferencedProjects(issueId, anchorProjectId, baseOpts(companyId, access));

    expect(result.additional).toEqual([]);
    // Company scoping drops the foreign project before any authorization call is made.
    expect(decidedProjectIds).toEqual([]);
  });

  it("drops and warns on a project that fails per-project authorization", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const deniedProjectId = randomUUID();

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      { id: deniedProjectId, companyId, name: "Denied", status: "in_progress" },
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds: [deniedProjectId] });

    const { access } = recordingAccess((projectId) => decision(projectId !== deniedProjectId));
    const result = await resolveRunReferencedProjects(issueId, anchorProjectId, baseOpts(companyId, access));

    expect(result.additional).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(deniedProjectId);
    expect(result.warnings[0]).toContain("not authorized");
  });

  it("fail-closed drops a project when the authorization service throws", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const explodingProjectId = randomUUID();

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      { id: explodingProjectId, companyId, name: "Exploding", status: "in_progress" },
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds: [explodingProjectId] });

    const access: ResolveRunReferencedProjectsOptions["access"] = {
      decide: async () => {
        throw new Error("authorization backend unavailable");
      },
    };
    const result = await resolveRunReferencedProjects(issueId, anchorProjectId, baseOpts(companyId, access));

    // The run continues; the un-authorizable project is dropped with a warning rather than throwing.
    expect(result.anchor?.projectId).toBe(anchorProjectId);
    expect(result.additional).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(explodingProjectId);
    expect(result.warnings[0]).toContain("not authorized");
  });

  it("caps the number of additional projects and warns about the overflow", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const mentionedProjectIds = [randomUUID(), randomUUID(), randomUUID()];

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      ...mentionedProjectIds.map((id, index) => ({
        id,
        companyId,
        name: `Mentioned ${index}`,
        status: "in_progress" as const,
      })),
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds });

    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    const result = await resolveRunReferencedProjects(
      issueId,
      anchorProjectId,
      baseOpts(companyId, access, { maxAdditionalProjects: 2 }),
    );

    expect(result.additional.map((entry) => entry.projectId)).toEqual(mentionedProjectIds.slice(0, 2));
    // The cap counts admitted projects, so the third project is never authorized once two are admitted.
    expect(decidedProjectIds).toEqual(mentionedProjectIds.slice(0, 2));
    expect(result.warnings.some((warning) => warning.includes("Only the first 2"))).toBe(true);
    expect(MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS).toBeGreaterThan(0);
  });

  it("does not let an unauthorized mention consume an additional-project cap slot", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const deniedProjectId = randomUUID();
    const allowedProjectIds = [randomUUID(), randomUUID()];
    // Mention order: the denied project comes first, ahead of two authorized projects.
    const mentionedProjectIds = [deniedProjectId, ...allowedProjectIds];

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      { id: deniedProjectId, companyId, name: "Denied", status: "in_progress" },
      ...allowedProjectIds.map((id, index) => ({
        id,
        companyId,
        name: `Allowed ${index}`,
        status: "in_progress" as const,
      })),
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds });

    const { access } = recordingAccess((projectId) => decision(projectId !== deniedProjectId));
    const result = await resolveRunReferencedProjects(
      issueId,
      anchorProjectId,
      baseOpts(companyId, access, { maxAdditionalProjects: 2 }),
    );

    // The denied mention is dropped without using a cap slot, so both authorized projects still fit.
    expect(result.additional.map((entry) => entry.projectId)).toEqual(allowedProjectIds);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(deniedProjectId);
    expect(result.warnings[0]).toContain("not authorized");
    // The cap was satisfied by admitted projects, so no overflow warning is emitted.
    expect(result.warnings.some((warning) => warning.includes("Only the first"))).toBe(false);
  });

  it("bounds authorization fan-out when a same-company mention flood is denied", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    // A flood of same-company mentions that every fail authorization. Without a fan-out cap this
    // would authorize all eight candidates because the admitted cap is never reached.
    const deniedProjectIds = Array.from({ length: 8 }, () => randomUUID());

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      ...deniedProjectIds.map((id, index) => ({
        id,
        companyId,
        name: `Denied ${index}`,
        status: "in_progress" as const,
      })),
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds: deniedProjectIds });

    const { decidedProjectIds, access } = recordingAccess(() => decision(false));
    const result = await resolveRunReferencedProjects(
      issueId,
      anchorProjectId,
      baseOpts(companyId, access, { maxAdditionalProjects: 2, maxCandidateEvaluations: 3 }),
    );

    // No project is admitted (all denied), but only the first three candidates are ever authorized —
    // the remaining five are dropped before any authorization decision is made.
    expect(result.additional).toEqual([]);
    expect(decidedProjectIds).toEqual(deniedProjectIds.slice(0, 3));
    expect(decidedProjectIds).toHaveLength(3);
    // Each dropped-but-evaluated candidate warns it was unauthorized; the tail warns it was skipped
    // without evaluation.
    expect(result.warnings.some((warning) => warning.includes("were evaluated for this run"))).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.includes("Only the first 3") && warning.includes("5 additional"),
      ),
    ).toBe(true);
  });

  it("still admits authorized candidates inside the evaluation window under a flood", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const allowedProjectId = randomUUID();
    // The single authorized project sits ahead of a flood of denied mentions and inside the window.
    const deniedProjectIds = Array.from({ length: 5 }, () => randomUUID());
    const mentionedProjectIds = [allowedProjectId, ...deniedProjectIds];

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      { id: allowedProjectId, companyId, name: "Allowed", status: "in_progress" },
      ...deniedProjectIds.map((id, index) => ({
        id,
        companyId,
        name: `Denied ${index}`,
        status: "in_progress" as const,
      })),
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds });

    const { decidedProjectIds, access } = recordingAccess((projectId) =>
      decision(projectId === allowedProjectId),
    );
    const result = await resolveRunReferencedProjects(
      issueId,
      anchorProjectId,
      baseOpts(companyId, access, { maxAdditionalProjects: 2, maxCandidateEvaluations: 3 }),
    );

    // The authorized project is admitted; only the first three candidates are ever authorized.
    expect(result.additional.map((entry) => entry.projectId)).toEqual([allowedProjectId]);
    expect(decidedProjectIds).toEqual(mentionedProjectIds.slice(0, 3));
    expect(result.warnings.some((warning) => warning.includes("were evaluated for this run"))).toBe(true);
  });

  it("does not let unavailable mentions consume the evaluation window", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const allowedProjectId = randomUUID();
    // Two unavailable (foreign-company / deleted / unknown) mentions sit ahead of the authorized
    // project in mention order. The production mention lookup company-filters these out, so drive the
    // mention set through a stub to exercise the resolver's own availability filtering directly.
    const unavailableProjectIds = [randomUUID(), randomUUID()];

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      { id: allowedProjectId, companyId, name: "Allowed", status: "in_progress" },
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds: [allowedProjectId] });

    const mentions: ResolveRunReferencedProjectsOptions["issues"] = {
      findMentionedProjectIds: async () => [...unavailableProjectIds, allowedProjectId],
    };

    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    // The evaluation cap is only two slots; if unavailable mentions consumed them, the authorized
    // project would be displaced out of the window and the set would underfill.
    const result = await resolveRunReferencedProjects(
      issueId,
      anchorProjectId,
      baseOpts(companyId, access, { issues: mentions, maxAdditionalProjects: 2, maxCandidateEvaluations: 2 }),
    );

    // Availability filtering runs before the evaluation cap, so the authorized project still lands
    // inside the window and is admitted rather than displaced.
    expect(result.additional.map((entry) => entry.projectId)).toEqual([allowedProjectId]);
    expect(decidedProjectIds).toEqual([allowedProjectId]);
    // Each unavailable mention warns, but none of them consumed an evaluation slot.
    expect(
      result.warnings.filter((warning) => warning.includes("not available in this company")),
    ).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.includes("without evaluation"))).toBe(false);
  });

  it("floors the evaluation cap at the admitted cap so the admitted cap stays reachable", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const allowedProjectIds = [randomUUID(), randomUUID()];

    await seedCompany(companyId);
    await db.insert(projects).values([
      { id: anchorProjectId, companyId, name: "Anchor", status: "in_progress" },
      ...allowedProjectIds.map((id, index) => ({
        id,
        companyId,
        name: `Allowed ${index}`,
        status: "in_progress" as const,
      })),
    ]);
    await seedIssueWithMentions({ companyId, issueId, anchorProjectId, mentionedProjectIds: allowedProjectIds });

    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    // An evaluation cap below the admitted cap must not starve the admitted cap.
    const result = await resolveRunReferencedProjects(
      issueId,
      anchorProjectId,
      baseOpts(companyId, access, { maxAdditionalProjects: 2, maxCandidateEvaluations: 0 }),
    );

    expect(result.additional.map((entry) => entry.projectId)).toEqual(allowedProjectIds);
    expect(decidedProjectIds).toEqual(allowedProjectIds);
    expect(result.warnings).toEqual([]);
  });

  it("defaults the evaluation cap at or above the admitted cap", () => {
    expect(MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS).toBeGreaterThanOrEqual(
      MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS,
    );
  });
});
