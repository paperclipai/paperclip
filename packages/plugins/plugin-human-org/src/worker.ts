import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginContext,
  type PluginEntityRecord,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";
import manifest from "./manifest.js";
import {
  buildMattermostAssignmentPayload,
  buildOrgTree,
  HUMAN_ORG_LIMITS,
  normalizeOrgChartRows,
  parseOrgChartCsv,
  validateOrgChartRows,
  type HumanProfile,
} from "./model.js";

const PROFILE_ENTITY = "human-profile";
const ASSIGNMENT_ENTITY = "human-assignment";
const TASK_ORIGIN_KIND = "plugin:paperclipai.plugin-human-org";
const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
const ENTITY_PAGE_SIZE = 500;

type AssignmentRecord = {
  issueId: string;
  humanExternalId: string;
  linkedUserId: string | null;
  assignedAt: string;
  assignedByUserId: string | null;
  notificationState: "pending" | "sent" | "skipped" | "failed" | "unknown";
};

type HumanOrgConfig = {
  mattermostWebhook?: unknown;
  paperclipBaseUrl?: string;
  notifyMattermost?: boolean;
};

function requiredCompanyId(params: Record<string, unknown>): string {
  const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
  if (!companyId) throw new Error("companyId is required");
  return companyId;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function scopedExternalId(companyId: string, externalId: string): string {
  return `${companyId}:${externalId}`;
}

function belongsToCompany(entity: PluginEntityRecord, companyId: string): boolean {
  return entity.scopeKind === "company" && entity.scopeId === companyId;
}

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === "secret_ref"
    && typeof (value as { secretId?: unknown }).secretId === "string",
  );
}

function profileFromEntity(entity: PluginEntityRecord): HumanProfile {
  return normalizeOrgChartRows([{ ...entity.data, externalId: entity.data.externalId ?? entity.externalId }])[0]!;
}

function assignmentFromEntity(entity: PluginEntityRecord): AssignmentRecord | null {
  const issueId = optionalString(entity.data.issueId) ?? entity.externalId ?? undefined;
  const humanExternalId = optionalString(entity.data.humanExternalId);
  if (!issueId || !humanExternalId) return null;
  return {
    issueId,
    humanExternalId,
    linkedUserId: optionalString(entity.data.linkedUserId) ?? null,
    assignedAt: optionalString(entity.data.assignedAt) ?? entity.updatedAt,
    assignedByUserId: optionalString(entity.data.assignedByUserId) ?? null,
    notificationState: entity.data.notificationState === "pending"
      || entity.data.notificationState === "sent"
      || entity.data.notificationState === "failed"
      || entity.data.notificationState === "unknown"
      ? entity.data.notificationState
      : "skipped",
  };
}

async function listAllEntities(
  ctx: PluginContext,
  params: Omit<Parameters<PluginContext["entities"]["list"]>[0], "limit" | "offset">,
): Promise<PluginEntityRecord[]> {
  const records: PluginEntityRecord[] = [];
  let offset = 0;
  while (true) {
    const page = await ctx.entities.list({ ...params, limit: ENTITY_PAGE_SIZE, offset });
    records.push(...page);
    if (page.length < ENTITY_PAGE_SIZE) return records;
    offset += page.length;
  }
}

async function listAllIssues(ctx: PluginContext, companyId: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  let offset = 0;
  while (true) {
    const page = await ctx.issues.list({ companyId, limit: ENTITY_PAGE_SIZE, offset });
    issues.push(...page);
    if (page.length < ENTITY_PAGE_SIZE) return issues;
    offset += page.length;
  }
}

async function listAllProjects(ctx: PluginContext, companyId: string) {
  const projects = [];
  let offset = 0;
  while (true) {
    const page = await ctx.projects.list({ companyId, limit: ENTITY_PAGE_SIZE, offset });
    projects.push(...page);
    if (page.length < ENTITY_PAGE_SIZE) return projects;
    offset += page.length;
  }
}

async function listProfiles(ctx: PluginContext, companyId: string, includeInactive = false): Promise<HumanProfile[]> {
  const records = await listAllEntities(ctx, {
    entityType: PROFILE_ENTITY,
    scopeKind: "company",
    scopeId: companyId,
  });
  const profiles = records
    .filter((record) => belongsToCompany(record, companyId))
    .map(profileFromEntity);
  return includeInactive ? profiles : profiles.filter((profile) => profile.status === "active");
}

async function getProfile(ctx: PluginContext, companyId: string, externalId: string): Promise<HumanProfile> {
  const records = await ctx.entities.list({
    entityType: PROFILE_ENTITY,
    scopeKind: "company",
    scopeId: companyId,
    externalId: scopedExternalId(companyId, externalId),
    limit: 2,
    offset: 0,
  });
  const record = records.find((candidate) => belongsToCompany(candidate, companyId));
  const profile = record ? profileFromEntity(record) : null;
  if (!profile || profile.status !== "active") throw new Error(`Active human profile not found: ${externalId}`);
  return profile;
}

async function listAssignments(ctx: PluginContext, companyId: string): Promise<AssignmentRecord[]> {
  const records = await listAllEntities(ctx, {
    entityType: ASSIGNMENT_ENTITY,
    scopeKind: "company",
    scopeId: companyId,
  });
  return records
    .filter((record) => belongsToCompany(record, companyId) && record.status !== "inactive")
    .map(assignmentFromEntity)
    .filter((record): record is AssignmentRecord => record !== null);
}

async function getAssignmentEntity(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<PluginEntityRecord | null> {
  const records = await ctx.entities.list({
    entityType: ASSIGNMENT_ENTITY,
    scopeKind: "company",
    scopeId: companyId,
    externalId: scopedExternalId(companyId, issueId),
    limit: 2,
    offset: 0,
  });
  return records.find((candidate) => belongsToCompany(candidate, companyId)) ?? null;
}

async function getAssignment(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<AssignmentRecord | null> {
  const record = await getAssignmentEntity(ctx, companyId, issueId);
  return record && record.status !== "inactive" ? assignmentFromEntity(record) : null;
}

async function resolveLinkedUserId(ctx: PluginContext, companyId: string, profile: HumanProfile): Promise<string | null> {
  if (!profile.paperclipUserId) return null;
  const members = await ctx.access.members.list({ companyId, includeArchived: false });
  const linked = members.find((member) => (
    member.principalType === "user"
    && member.principalId === profile.paperclipUserId
    && member.status === "active"
  ));
  if (!linked) {
    throw new Error(`Linked Paperclip user ${profile.paperclipUserId} is not an active member of this company`);
  }
  return linked.principalId;
}

async function authorizeMutation(
  ctx: PluginContext,
  actionContext: PluginPerformActionContext,
): Promise<{ companyId: string; userId: string }> {
  const companyId = optionalString(actionContext.companyId);
  const userId = actionContext.actor.type === "user" ? optionalString(actionContext.actor.userId) : undefined;
  if (!companyId || !userId) throw new Error("A signed-in company member is required");
  const members = await ctx.access.members.list({ companyId, includeArchived: false });
  const actorMembership = members.find((member) => (
    member.principalType === "user"
    && member.principalId === userId
    && member.status === "active"
  ));
  if (!actorMembership || !["owner", "admin", "member"].includes(actorMembership.membershipRole ?? "")) {
    throw new Error("Active member role is required to manage human work");
  }
  return { companyId, userId };
}

function issueIdentifier(issue: Issue): string {
  const record = issue as Issue & { identifier?: string | null };
  return record.identifier || issue.id;
}

function issueLink(config: HumanOrgConfig, issue: Issue): string {
  const base = optionalString(config.paperclipBaseUrl)?.replace(/\/$/, "");
  if (!base) return issue.id;
  return `${base}/issues/${encodeURIComponent(issueIdentifier(issue))}`;
}

async function notifyMattermost(
  ctx: PluginContext,
  companyId: string,
  profile: HumanProfile,
  issue: Issue,
): Promise<{ state: "sent" | "skipped" | "failed"; reason?: string }> {
  try {
    const config = await ctx.config.get(companyId) as HumanOrgConfig;
    if (config.notifyMattermost === false) return { state: "skipped", reason: "disabled" };
    if (!profile.mattermostUsername) return { state: "skipped", reason: "no_mattermost_username" };
    if (!isSecretRef(config.mattermostWebhook)) return { state: "skipped", reason: "webhook_not_configured" };
    const webhookUrl = await ctx.secrets.resolve(config.mattermostWebhook, {
      companyId,
      configPath: "mattermostWebhook",
    });
    const payload = buildMattermostAssignmentPayload({
      humanName: profile.name,
      mattermostUsername: profile.mattermostUsername,
      issueTitle: issue.title,
      issueIdentifier: issueIdentifier(issue),
      issueUrl: issueLink(config, issue),
      priority: issue.priority,
    });
    const response = await ctx.http.fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { state: "failed", reason: `http_${response.status}` };
    return { state: "sent" };
  } catch {
    return { state: "failed", reason: "delivery_error" };
  }
}

async function persistAssignment(
  ctx: PluginContext,
  companyId: string,
  issue: Issue,
  profile: HumanProfile,
  linkedUserId: string | null,
  assignedByUserId: string | null,
  notificationState: AssignmentRecord["notificationState"],
  assignedAt = new Date().toISOString(),
): Promise<AssignmentRecord> {
  const assignment: AssignmentRecord = {
    issueId: issue.id,
    humanExternalId: profile.externalId,
    linkedUserId,
    assignedAt,
    assignedByUserId,
    notificationState,
  };
  await ctx.entities.upsert({
    entityType: ASSIGNMENT_ENTITY,
    scopeKind: "company",
    scopeId: companyId,
    externalId: scopedExternalId(companyId, issue.id),
    title: `${profile.name}: ${issue.title}`,
    status: "active",
    data: assignment,
  });
  return assignment;
}

async function persistNotificationOutcome(
  ctx: PluginContext,
  companyId: string,
  issue: Issue,
  profile: HumanProfile,
  assignment: AssignmentRecord,
  notificationState: "sent" | "skipped" | "failed",
): Promise<AssignmentRecord> {
  try {
    return await persistAssignment(
      ctx,
      companyId,
      issue,
      profile,
      assignment.linkedUserId,
      assignment.assignedByUserId,
      notificationState,
      assignment.assignedAt,
    );
  } catch {
    const unknownAssignment: AssignmentRecord = { ...assignment, notificationState: "unknown" };
    try {
      return await persistAssignment(
        ctx,
        companyId,
        issue,
        profile,
        assignment.linkedUserId,
        assignment.assignedByUserId,
        "unknown",
        assignment.assignedAt,
      );
    } catch {
      return unknownAssignment;
    }
  }
}

async function reconcilePendingNotification(
  ctx: PluginContext,
  companyId: string,
  issue: Issue,
  profile: HumanProfile,
  assignment: AssignmentRecord,
): Promise<AssignmentRecord> {
  if (assignment.notificationState !== "pending") return assignment;
  try {
    return await persistAssignment(
      ctx,
      companyId,
      issue,
      profile,
      assignment.linkedUserId,
      assignment.assignedByUserId,
      "unknown",
      assignment.assignedAt,
    );
  } catch {
    return { ...assignment, notificationState: "unknown" };
  }
}

async function assignIssue(
  ctx: PluginContext,
  companyId: string,
  issue: Issue,
  profile: HumanProfile,
  assignedBy: string | null,
): Promise<{ issue: Issue; assignment: AssignmentRecord; notification: { state: string; reason?: string } }> {
  const linkedUserId = await resolveLinkedUserId(ctx, companyId, profile);
  const observedEntity = await getAssignmentEntity(ctx, companyId, issue.id);
  let assignment: AssignmentRecord = {
    issueId: issue.id,
    humanExternalId: profile.externalId,
    linkedUserId,
    assignedAt: new Date().toISOString(),
    assignedByUserId: assignedBy,
    notificationState: "pending",
  };
  const transition = await ctx.issues.transitionAssigneeEntity({
    issueId: issue.id,
    companyId,
    expectedAssigneeAgentId: issue.assigneeAgentId ?? null,
    expectedAssigneeUserId: issue.assigneeUserId ?? null,
    expectedEntity: {
      id: observedEntity?.id ?? null,
      updatedAt: observedEntity?.updatedAt ?? null,
      status: observedEntity?.status ?? null,
      data: observedEntity?.data ?? null,
    },
    assigneeAgentId: null,
    assigneeUserId: linkedUserId,
    entity: {
      entityType: ASSIGNMENT_ENTITY,
      scopeKind: "company",
      scopeId: companyId,
      externalId: scopedExternalId(companyId, issue.id),
      title: `${profile.name}: ${issue.title}`,
      status: "active",
      data: assignment,
    },
    actor: assignedBy ? { actorUserId: assignedBy } : undefined,
  });
  const updatedIssue = transition.issue;
  const notification = await notifyMattermost(ctx, companyId, profile, updatedIssue);
  const notifiedAssignment: AssignmentRecord = {
    ...assignment,
    notificationState: notification.state,
  };
  try {
    const outcome = await ctx.issues.transitionAssigneeEntity({
      issueId: updatedIssue.id,
      companyId,
      expectedAssigneeAgentId: updatedIssue.assigneeAgentId ?? null,
      expectedAssigneeUserId: updatedIssue.assigneeUserId ?? null,
      expectedEntity: {
        id: transition.entity.id,
        updatedAt: transition.entity.updatedAt,
        status: transition.entity.status,
        data: transition.entity.data,
      },
      assigneeAgentId: updatedIssue.assigneeAgentId ?? null,
      assigneeUserId: updatedIssue.assigneeUserId ?? null,
      entity: {
        entityType: ASSIGNMENT_ENTITY,
        scopeKind: "company",
        scopeId: companyId,
        externalId: scopedExternalId(companyId, issue.id),
        title: `${profile.name}: ${issue.title}`,
        status: "active",
        data: notifiedAssignment,
      },
      actor: assignedBy ? { actorUserId: assignedBy } : undefined,
    });
    assignment = assignmentFromEntity(outcome.entity) ?? notifiedAssignment;
  } catch {
    assignment = { ...assignment, notificationState: "unknown" };
  }
  await ctx.activity.log({
    companyId,
    message: `Assigned ${issueIdentifier(updatedIssue)} to human profile ${profile.name}`,
    entityType: "issue",
    entityId: updatedIssue.id,
    metadata: {
      humanExternalId: profile.externalId,
      linkedToPaperclipUser: Boolean(linkedUserId),
      mattermostNotification: notification.state,
    },
  });
  return { issue: updatedIssue, assignment, notification };
}

function importRows(params: Record<string, unknown>): HumanProfile[] {
  if (typeof params.csv === "string") return parseOrgChartCsv(params.csv);
  if (typeof params.json === "string") {
    if (params.json.length > HUMAN_ORG_LIMITS.importCharacters) {
      throw new Error(`Org chart imports are limited to ${HUMAN_ORG_LIMITS.importCharacters.toLocaleString("en-US")} characters`);
    }
    return normalizeOrgChartRows(JSON.parse(params.json) as unknown);
  }
  if (params.rows !== undefined) return normalizeOrgChartRows(params.rows);
  throw new Error("Provide csv, json, or rows");
}

const plugin = definePlugin({
  async setup(ctx) {
    const createTaskInFlight = new Map<string, {
      humanExternalId: string;
      promise: Promise<unknown>;
    }>();
    ctx.data.register("human-roster", async (params) => {
      const companyId = requiredCompanyId(params);
      const profiles = await listProfiles(ctx, companyId, true);
      const activeProfiles = profiles.filter((profile) => profile.status === "active");
      return {
        profiles: activeProfiles,
        roots: buildOrgTree(activeProfiles),
        inactiveCount: profiles.length - activeProfiles.length,
      };
    });

    ctx.data.register("projects", async (params) => {
      const companyId = requiredCompanyId(params);
      return await listAllProjects(ctx, companyId);
    });

    ctx.data.register("integration-status", async (params) => {
      const companyId = requiredCompanyId(params);
      const config = await ctx.config.get(companyId) as HumanOrgConfig;
      return {
        mattermostConfigured: isSecretRef(config.mattermostWebhook),
        notificationsEnabled: config.notifyMattermost !== false,
        paperclipBaseUrlConfigured: Boolean(optionalString(config.paperclipBaseUrl)),
      };
    });

    ctx.data.register("human-work-board", async (params) => {
      const companyId = requiredCompanyId(params);
      const [profiles, assignments, issues] = await Promise.all([
        listProfiles(ctx, companyId, true),
        listAssignments(ctx, companyId),
        listAllIssues(ctx, companyId),
      ]);
      const profilesById = new Map(profiles.map((profile) => [profile.externalId, profile]));
      const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
      const columns: Record<string, Array<{ assignment: AssignmentRecord; human: HumanProfile; issue: Issue }>> = Object.fromEntries(
        ISSUE_STATUSES.map((status) => [status, []]),
      );
      for (const assignment of assignments) {
        const human = profilesById.get(assignment.humanExternalId);
        const issue = issuesById.get(assignment.issueId);
        if (!human || !issue) continue;
        (columns[issue.status] ??= []).push({ assignment, human, issue });
      }
      for (const cards of Object.values(columns)) {
        cards.sort((left, right) => left.issue.title.localeCompare(right.issue.title));
      }
      return { columns, total: assignments.length };
    });

    ctx.data.register("issue-human-assignment", async (params) => {
      const companyId = requiredCompanyId(params);
      const issueId = optionalString(params.issueId);
      if (!issueId) throw new Error("issueId is required");
      const [records, profiles] = await Promise.all([
        ctx.entities.list({
          entityType: ASSIGNMENT_ENTITY,
          scopeKind: "company",
          scopeId: companyId,
          externalId: scopedExternalId(companyId, issueId),
          limit: 2,
          offset: 0,
        }),
        listProfiles(ctx, companyId),
      ]);
      const record = records.find((candidate) => belongsToCompany(candidate, companyId));
      const assignment = record?.status === "inactive" ? null : (record ? assignmentFromEntity(record) : null);
      return {
        assignment,
        human: assignment ? profiles.find((profile) => profile.externalId === assignment.humanExternalId) ?? null : null,
        profiles,
      };
    });

    ctx.actions.register("import-org-chart", async (params, actionContext) => {
      const { companyId } = await authorizeMutation(ctx, actionContext);
      const rows = importRows(params);
      const existing = await listProfiles(ctx, companyId, true);
      const replace = params.replace === true;
      const incomingErrors = validateOrgChartRows(rows).filter(
        (error) => replace || error.code !== "unknown_manager",
      );
      const mergedProfiles = replace
        ? rows
        : [...new Map([
            ...existing.map((profile) => [profile.externalId, profile] as const),
            ...rows.map((profile) => [profile.externalId, profile] as const),
          ]).values()];
      const errors = [...incomingErrors, ...validateOrgChartRows(mergedProfiles)]
        .filter((error, index, all) => all.findIndex((candidate) => (
          candidate.code === error.code
          && candidate.externalId === error.externalId
          && candidate.message === error.message
        )) === index);
      if (errors.length > 0) {
        throw new Error(`Org chart validation failed: ${errors.map((error) => error.message).join("; ")}`);
      }

      const incomingIds = new Set(rows.map((row) => row.externalId));
      const entityUpserts = rows.map((profile) => ({
        entityType: PROFILE_ENTITY,
        scopeKind: "company" as const,
        scopeId: companyId,
        externalId: scopedExternalId(companyId, profile.externalId),
        title: profile.name,
        status: profile.status,
        data: { ...profile },
      }));

      let deactivated = 0;
      if (params.replace === true) {
        for (const profile of existing) {
          if (incomingIds.has(profile.externalId) || profile.status === "inactive") continue;
          const inactive = { ...profile, status: "inactive" as const };
          entityUpserts.push({
            entityType: PROFILE_ENTITY,
            scopeKind: "company" as const,
            scopeId: companyId,
            externalId: scopedExternalId(companyId, inactive.externalId),
            title: inactive.name,
            status: "inactive",
            data: inactive,
          });
          deactivated += 1;
        }
      }

      await ctx.entities.upsertMany(entityUpserts);

      await ctx.activity.log({
        companyId,
        message: `Imported ${rows.length} human org profiles`,
        entityType: "company",
        entityId: companyId,
        metadata: { imported: rows.length, deactivated },
      });
      return { imported: rows.length, deactivated, errors: [] };
    });

    ctx.actions.register("create-human-task", async (params, actionContext) => {
      const authorization = await authorizeMutation(ctx, actionContext);
      const requestIdForLock = optionalString(params.requestId) ?? "";
      const humanExternalIdForLock = optionalString(params.humanExternalId) ?? "";
      const lockKey = JSON.stringify([
        authorization.companyId,
        requestIdForLock,
      ]);
      const inFlight = createTaskInFlight.get(lockKey);
      if (inFlight) {
        if (inFlight.humanExternalId !== humanExternalIdForLock) {
          throw new Error("requestId was already used for a different human assignment");
        }
        return await inFlight.promise;
      }
      const run = Promise.resolve().then(async () => {
      const { companyId, userId } = authorization;
      const humanExternalId = optionalString(params.humanExternalId);
      const title = optionalString(params.title);
      if (!humanExternalId) throw new Error("humanExternalId is required");
      if (!title) throw new Error("title is required");
      const requestId = optionalString(params.requestId);
      if (!requestId) throw new Error("requestId is required for idempotent task creation");
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
        throw new Error("requestId must contain 1-128 letters, numbers, dots, underscores, colons, or hyphens");
      }
      if (humanExternalId.length > HUMAN_ORG_LIMITS.externalId) {
        throw new Error(`humanExternalId exceeds ${HUMAN_ORG_LIMITS.externalId} characters`);
      }
      if (title.length > HUMAN_ORG_LIMITS.taskTitle) {
        throw new Error(`title exceeds ${HUMAN_ORG_LIMITS.taskTitle} characters`);
      }
      const description = optionalString(params.description);
      if (description && description.length > HUMAN_ORG_LIMITS.taskDescription) {
        throw new Error(`description exceeds ${HUMAN_ORG_LIMITS.taskDescription.toLocaleString("en-US")} characters`);
      }
      const projectId = optionalString(params.projectId);
      if (projectId && projectId.length > HUMAN_ORG_LIMITS.externalId) {
        throw new Error(`projectId exceeds ${HUMAN_ORG_LIMITS.externalId} characters`);
      }
      const profile = await getProfile(ctx, companyId, humanExternalId);
      const linkedUserId = await resolveLinkedUserId(ctx, companyId, profile);
      const priority = params.priority === "critical" || params.priority === "high" || params.priority === "low"
        ? params.priority
        : "medium";
      const originId = `human-task:${requestId}:${profile.externalId}`;
      const idempotencyKey = `paperclipai.plugin-human-org:create:${requestId}`;
      let issue = (await ctx.issues.list({
        companyId,
        originKind: TASK_ORIGIN_KIND,
        originId,
        limit: 2,
        offset: 0,
      }))[0];
      if (issue) {
        const assignment = await getAssignment(ctx, companyId, issue.id);
        if (assignment) {
          if (assignment.humanExternalId !== profile.externalId) {
            throw new Error("requestId was already used for a different human assignment");
          }
          const deliveryUncertain = assignment.notificationState === "pending"
            || assignment.notificationState === "unknown";
          const reconciledAssignment = deliveryUncertain
            ? await reconcilePendingNotification(ctx, companyId, issue, profile, assignment)
            : assignment;
          return {
            issue,
            assignment: reconciledAssignment,
            notification: deliveryUncertain
              ? { state: "unknown", reason: "duplicate_request_delivery_unknown" }
              : { state: reconciledAssignment.notificationState, reason: "duplicate_request" },
          };
        }
      } else {
        issue = await ctx.issues.create({
          companyId,
          projectId,
          title,
          description,
          status: "todo",
          priority,
          assigneeUserId: linkedUserId,
          originKind: TASK_ORIGIN_KIND,
          originId,
          idempotencyKey,
        });
      }
      if (issue.originId !== originId) {
        throw new Error("requestId was already used for a different human task");
      }
      const assignedAt = new Date().toISOString();
      const pendingAssignment: AssignmentRecord = {
        issueId: issue.id,
        humanExternalId: profile.externalId,
        linkedUserId,
        assignedAt,
        assignedByUserId: userId,
        notificationState: "pending",
      };
      const assignmentClaim = await ctx.entities.create({
        entityType: ASSIGNMENT_ENTITY,
        scopeKind: "company",
        scopeId: companyId,
        externalId: scopedExternalId(companyId, issue.id),
        title: `${profile.name}: ${issueIdentifier(issue)}`,
        status: "active",
        data: pendingAssignment as unknown as Record<string, unknown>,
      });
      if (!assignmentClaim.created) {
        const existingAssignment = assignmentFromEntity(assignmentClaim.entity);
        if (!existingAssignment) {
          throw new Error("Existing human assignment record is invalid");
        }
        if (existingAssignment.humanExternalId !== profile.externalId) {
          throw new Error("requestId was already used for a different human assignment");
        }
        const deliveryUncertain = existingAssignment.notificationState === "pending"
          || existingAssignment.notificationState === "unknown";
        return {
          issue,
          assignment: existingAssignment,
          notification: deliveryUncertain
            ? { state: "unknown", reason: "concurrent_request_delivery_claimed" }
            : { state: existingAssignment.notificationState, reason: "duplicate_request" },
        };
      }

      let assignment = pendingAssignment;
      const notification = await notifyMattermost(ctx, companyId, profile, issue);
      assignment = await persistNotificationOutcome(
        ctx,
        companyId,
        issue,
        profile,
        assignment,
        notification.state,
      );
      await ctx.activity.log({
        companyId,
        message: `Created ${issueIdentifier(issue)} for ${profile.name}`,
        entityType: "issue",
        entityId: issue.id,
        metadata: {
          humanExternalId: profile.externalId,
          linkedToPaperclipUser: Boolean(linkedUserId),
          mattermostNotification: notification.state,
        },
      });
      return { issue, assignment, notification };
      });
      createTaskInFlight.set(lockKey, { humanExternalId: humanExternalIdForLock, promise: run });
      try {
        return await run;
      } finally {
        if (createTaskInFlight.get(lockKey)?.promise === run) createTaskInFlight.delete(lockKey);
      }
    });

    ctx.actions.register("assign-human-task", async (params, actionContext) => {
      const { companyId, userId } = await authorizeMutation(ctx, actionContext);
      const humanExternalId = optionalString(params.humanExternalId);
      const issueId = optionalString(params.issueId);
      if (!humanExternalId || !issueId) throw new Error("humanExternalId and issueId are required");
      const [profile, issue] = await Promise.all([
        getProfile(ctx, companyId, humanExternalId),
        ctx.issues.get(issueId, companyId),
      ]);
      if (!issue) throw new Error(`Issue not found: ${issueId}`);
      return await assignIssue(ctx, companyId, issue, profile, userId);
    });

    ctx.actions.register("update-human-task-status", async (params, actionContext) => {
      const { companyId } = await authorizeMutation(ctx, actionContext);
      const issueId = optionalString(params.issueId);
      const status = optionalString(params.status);
      if (!issueId || !status || !ISSUE_STATUSES.includes(status as (typeof ISSUE_STATUSES)[number])) {
        throw new Error("A valid issueId and status are required");
      }
      const records = await ctx.entities.list({
        entityType: ASSIGNMENT_ENTITY,
        scopeKind: "company",
        scopeId: companyId,
        externalId: scopedExternalId(companyId, issueId),
        limit: 2,
        offset: 0,
      });
      const activeAssignment = records.find((record) => (
        belongsToCompany(record, companyId)
        && record.status !== "inactive"
        && assignmentFromEntity(record) !== null
      ));
      const assignment = activeAssignment ? assignmentFromEntity(activeAssignment) : null;
      if (!assignment) {
        throw new Error(`Issue ${issueId} does not have an active human assignment`);
      }
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) throw new Error(`Issue not found: ${issueId}`);
      if (
        issue.assigneeAgentId !== null
        || issue.assigneeUserId !== assignment.linkedUserId
      ) {
        throw new Error(`Human assignment no longer owns issue ${issueId}`);
      }
      return await ctx.issues.update(issueId, { status: status as Issue["status"] }, companyId);
    });

    ctx.actions.register("unassign-human-task", async (params, actionContext) => {
      const { companyId, userId } = await authorizeMutation(ctx, actionContext);
      const issueId = optionalString(params.issueId);
      if (!issueId) throw new Error("issueId is required");
      const [record, issue] = await Promise.all([
        getAssignmentEntity(ctx, companyId, issueId),
        ctx.issues.get(issueId, companyId),
      ]);
      const assignment = record && record.status !== "inactive" ? assignmentFromEntity(record) : null;
      if (!assignment) return { unassigned: false };
      if (!issue) throw new Error(`Issue not found: ${issueId}`);
      const clearLinkedAssignee = Boolean(
        assignment.linkedUserId && issue.assigneeUserId === assignment.linkedUserId,
      );
      await ctx.issues.transitionAssigneeEntity({
        issueId,
        companyId,
        expectedAssigneeAgentId: issue.assigneeAgentId ?? null,
        expectedAssigneeUserId: issue.assigneeUserId ?? null,
        expectedEntity: {
          id: record!.id,
          updatedAt: record!.updatedAt,
          status: record!.status,
          data: record!.data,
        },
        assigneeAgentId: issue.assigneeAgentId ?? null,
        assigneeUserId: clearLinkedAssignee ? null : (issue.assigneeUserId ?? null),
        entity: {
          entityType: ASSIGNMENT_ENTITY,
          scopeKind: "company",
          scopeId: companyId,
          externalId: scopedExternalId(companyId, issueId),
          title: record!.title ?? issueId,
          status: "inactive",
          data: assignment,
        },
        actor: { actorUserId: userId },
      });
      return { unassigned: true };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
