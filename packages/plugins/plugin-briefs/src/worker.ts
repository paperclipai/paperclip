import {
  definePlugin,
  runWorker,
  type Issue,
  type PluginBridgeRequestContext,
  type PluginContext,
  type PluginIssueRelationSummary,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  briefPreferencesSchema,
  dismissBriefCardInputSchema,
  listBriefCardsInputSchema,
  pinBriefCardInputSchema,
  updateBriefPreferencesInputSchema,
} from "./contracts.js";
import {
  buildDeterministicBriefCard,
  type BriefsApprovalInput,
  type BriefsCommentInput,
  type BriefsDocumentInput,
  type BriefsIssueInput,
  type BriefsRelationInput,
  type BriefsRunInput,
  type BriefsSourceBundle,
  type BriefsWorkProductInput,
  type DeterministicBriefOptions,
} from "./deterministic-card-service.js";
import {
  BRIEFING_ANALYST_AGENT_KEY,
  BRIEFS_MANAGED_ROUTINE_KEYS,
  BRIEFS_MANAGED_SKILL_KEYS,
  BRIEFS_PROJECT_KEY,
  MANUAL_REFRESH_ROUTINE_KEY,
  PLUGIN_ID,
} from "./manifest.js";
import {
  hardenGeneratedSummaryOptions,
  sanitizeBriefSourceBundle,
} from "./safety.js";
import { createBriefsStore } from "./store.js";

function objectParam(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function bridgeParams(value: unknown): Record<string, unknown> {
  const raw = objectParam(value, "params");
  const nested = raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
    ? raw.params as Record<string, unknown>
    : null;
  if (nested) {
    return {
      ...nested,
      ...(typeof raw.companyId === "string" && typeof nested.companyId !== "string" ? { companyId: raw.companyId } : {}),
    };
  }
  const { renderEnvironment: _renderEnvironment, ...params } = raw;
  return params;
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function assertTrustedBridgeUserScope(userId: string, request?: PluginBridgeRequestContext): void {
  const actorUserId = request?.actor?.userId;
  if (!actorUserId) {
    throw new Error("Briefs user-scoped UI calls require a signed-in user");
  }
  if (actorUserId !== userId) {
    throw new Error("Briefs user scope mismatch");
  }
}

function bridgeUserId(request?: PluginBridgeRequestContext): string {
  const actorUserId = request?.actor?.userId;
  if (!actorUserId) {
    throw new Error("Briefs user-scoped UI calls require a signed-in user");
  }
  return actorUserId;
}

function scopedUserId(input: Record<string, unknown>, request?: PluginBridgeRequestContext): string {
  const requested = typeof input.userId === "string" && input.userId.trim() ? input.userId.trim() : bridgeUserId(request);
  assertTrustedBridgeUserScope(requested, request);
  return requested;
}

function numberParam(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function oneParagraph(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 900);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 90);
}

function summaryFailureReason(value: unknown): DeterministicBriefOptions["summaryFailureReason"] {
  return value === "truncation_failed" || value === "budget_capped" || value === "safety_block" || value === "model_error"
    ? value
    : "model_error";
}

function routineVariablesParam(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      result[key] = entry;
    }
  }
  return result;
}

function codexManagedAgentNeedsRepoCheckBypass(agent: { adapterType?: string | null; adapterConfig?: unknown }) {
  if (agent.adapterType !== "codex_local") return false;
  const config = agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
    ? agent.adapterConfig as Record<string, unknown>
    : {};
  if (config.dangerouslyBypassApprovalsAndSandbox !== true && config.dangerouslyBypassSandbox !== true) {
    return true;
  }
  const args = Array.isArray(config.extraArgs)
    ? config.extraArgs
    : Array.isArray(config.args)
      ? config.args
      : [];
  return !args.includes("--skip-git-repo-check");
}

function managedAgentNeedsBriefsToolPermission(agent: { permissions?: unknown }) {
  if (!agent.permissions || typeof agent.permissions !== "object" || Array.isArray(agent.permissions)) return true;
  const pluginTools = (agent.permissions as Record<string, unknown>).pluginTools;
  return !Array.isArray(pluginTools) || !pluginTools.includes(PLUGIN_ID);
}

function summaryOptions(input: Record<string, unknown>): DeterministicBriefOptions {
  if (input.budgetCapped === true) {
    return {
      summaryStatus: "fallback",
      summaryFailureReason: "budget_capped",
    };
  }
  const summary = typeof input.summary === "string" ? oneParagraph(input.summary) : "";
  if (!summary) {
    return {
      summaryStatus: "fallback",
      summaryFailureReason: summaryFailureReason(input.summaryFailureReason),
    };
  }
  return {
    title: typeof input.title === "string" ? oneLine(input.title) : null,
    summaryStatus: "ok",
    summaryParagraph: summary,
    summaryModel: typeof input.summaryModel === "string" && input.summaryModel.trim() ? input.summaryModel.trim() : "cheap-model",
    summaryTokensIn: numberParam(input.summaryTokensIn),
    summaryTokensOut: numberParam(input.summaryTokensOut),
    generatedByAgentId: typeof input.generatedByAgentId === "string" ? input.generatedByAgentId : null,
    generatedByRunId: typeof input.generatedByRunId === "string" ? input.generatedByRunId : null,
    allowGeneratedSummary: input.allowGeneratedSummary === true,
  };
}

async function saveBriefCard(
  ctx: PluginContext,
  store: ReturnType<typeof createBriefsStore>,
  bundle: BriefsSourceBundle,
  options: DeterministicBriefOptions,
) {
  const safeBundle = sanitizeBriefSourceBundle(bundle);
  const safeOptions = hardenGeneratedSummaryOptions(safeBundle, options);
  const card = await store.saveCard(buildDeterministicBriefCard(safeBundle, safeOptions));
  await ctx.activity.log({
    companyId: card.companyId,
    message: `Updated briefing card "${card.title}"`,
    entityType: "plugin:briefs:card",
    entityId: card.id,
    metadata: {
      userId: card.userId,
      state: card.state,
      rootIssueId: card.rootIssueId,
      summaryStatus: card.summaryStatus,
      summaryModel: card.snapshot.summaryModel,
      summaryTokensIn: card.snapshot.summaryTokensIn,
      summaryTokensOut: card.snapshot.summaryTokensOut,
      summaryFailureReason: card.snapshot.summaryFailureReason,
    },
  });
  return card;
}

function issueToBriefIssue(issue: Issue): BriefsIssueInput {
  return {
    id: issue.id,
    companyId: issue.companyId,
    parentId: issue.parentId,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.status,
    priority: issue.priority,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    createdByUserId: issue.createdByUserId,
    activeRecoveryAction: issue.activeRecoveryAction ?? null,
    blockerAttention: issue.blockerAttention ? { reason: issue.blockerAttention.reason } : null,
    executionState: issue.executionState ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    completedAt: issue.completedAt,
  };
}

function relationToBriefRelation(summary: PluginIssueRelationSummary | undefined): BriefsRelationInput {
  return {
    blockedBy: (summary?.blockedBy ?? []).map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      title: blocker.title,
      status: blocker.status,
    })),
  };
}

function runToBriefRun(run: BriefsRunInput | Awaited<ReturnType<PluginContext["issues"]["summaries"]["getOrchestration"]>>["runs"][number]): BriefsRunInput {
  return {
    id: run.id,
    companyId: "companyId" in run ? run.companyId : "",
    issueId: run.issueId,
    agentId: "agentId" in run ? run.agentId : null,
    status: run.status,
    error: run.error ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    createdAt: run.createdAt,
  };
}

async function buildBundleFromIssueTree(ctx: PluginContext, input: {
  companyId: string;
  userId: string;
  rootIssueId: string;
}): Promise<BriefsSourceBundle> {
  const subtree = await ctx.issues.getSubtree(input.rootIssueId, input.companyId, {
    includeRoot: true,
    includeRelations: true,
    includeDocuments: true,
    includeActiveRuns: true,
    includeAssignees: true,
  });
  const orchestration = await ctx.issues.summaries.getOrchestration({
    issueId: input.rootIssueId,
    companyId: input.companyId,
    includeSubtree: true,
    billingCode: "plugin-briefs:refresh",
  });
  const comments: BriefsCommentInput[] = [];
  const documents: BriefsDocumentInput[] = [];
  const workProducts: BriefsWorkProductInput[] = [];
  for (const issue of subtree.issues) {
    const issueComments = await ctx.issues.listComments(issue.id, input.companyId);
    comments.push(...issueComments.map((comment) => ({
      id: comment.id,
      companyId: comment.companyId,
      issueId: comment.issueId,
      authorUserId: comment.authorUserId,
      body: comment.body,
      createdAt: comment.createdAt,
    })));
    documents.push(...(subtree.documents?.[issue.id] ?? []).map((document) => ({
      id: document.id,
      companyId: document.companyId,
      issueId: document.issueId,
      key: document.key,
      title: document.title,
      createdByUserId: document.createdByUserId,
      updatedByUserId: document.updatedByUserId,
      updatedAt: document.updatedAt,
    })));
    workProducts.push(...(issue.workProducts ?? []).map((product) => ({
      id: product.id,
      companyId: issue.companyId,
      issueId: issue.id,
      title: product.title,
      status: product.status,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    })));
  }

  const activeRuns = Object.fromEntries(
    Object.entries(subtree.activeRuns ?? {}).map(([issueId, runs]) => [
      issueId,
      runs.map((run) => ({ ...runToBriefRun(run), companyId: input.companyId })),
    ]),
  );
  const root = subtree.issues.find((issue) => issue.id === input.rootIssueId) ?? subtree.issues[0];
  if (!root) throw new Error(`Issue tree is empty: ${input.rootIssueId}`);

  return {
    companyId: input.companyId,
    userId: input.userId,
    rootIssueId: input.rootIssueId,
    title: root.title,
    groupingDescription: `Issue tree rooted at ${root.identifier ?? root.id}: ${root.title}`,
    issues: subtree.issues.map(issueToBriefIssue),
    relations: Object.fromEntries(subtree.issues.map((issue) => [
      issue.id,
      relationToBriefRelation(subtree.relations?.[issue.id]),
    ])),
    activeRuns,
    runs: orchestration.runs.map((run) => ({ ...runToBriefRun(run), companyId: input.companyId })),
    comments,
    documents,
    approvals: orchestration.approvals.map((approval): BriefsApprovalInput => ({
      id: approval.id,
      companyId: input.companyId,
      issueId: approval.issueId,
      status: approval.status,
      reviewerUserId: null,
      decidedByUserId: approval.decidedByUserId,
      createdAt: approval.createdAt,
      decidedAt: approval.decidedAt,
    })),
    workProducts,
    relevantAgentIds: Object.keys(subtree.assignees ?? {}),
  };
}

async function refreshIssueTree(
  ctx: PluginContext,
  store: ReturnType<typeof createBriefsStore>,
  rawInput: Record<string, unknown>,
  request?: PluginBridgeRequestContext,
) {
  const companyId = stringParam(rawInput.companyId, "companyId");
  const userId = stringParam(rawInput.userId, "userId");
  if (request) assertTrustedBridgeUserScope(userId, request);
  const rootIssueId = stringParam(rawInput.rootIssueId, "rootIssueId");
  const card = await saveBriefCard(
    ctx,
    store,
    await buildBundleFromIssueTree(ctx, { companyId, userId, rootIssueId }),
    {
      ...summaryOptions(rawInput),
      generatedByAgentId: typeof rawInput.generatedByAgentId === "string" ? rawInput.generatedByAgentId : null,
      generatedByRunId: typeof rawInput.generatedByRunId === "string" ? rawInput.generatedByRunId : null,
    },
  );
  return { card };
}

const plugin = definePlugin({
  async setup(ctx) {
    const store = createBriefsStore(ctx.db);

    ctx.data.register("cards", async (params, request) => {
      const raw = bridgeParams(params);
      const input = listBriefCardsInputSchema.parse({
        ...raw,
        userId: scopedUserId(raw, request),
      });
      return {
        cards: await store.listCards(input),
      };
    });

    ctx.data.register("preferences", async (params, request) => {
      const input = bridgeParams(params);
      const companyId = typeof input.companyId === "string" ? input.companyId : "";
      if (!companyId) {
        throw new Error("companyId is required");
      }
      const userId = scopedUserId(input, request);
      return {
        preferences: await store.loadPreferences({ companyId, userId }),
      };
    });

    ctx.data.register("page", async (params, request) => {
      const input = bridgeParams(params);
      const companyId = typeof input.companyId === "string" ? input.companyId : "";
      const includeHidden = Boolean(input.includeHidden);
      if (!companyId) {
        throw new Error("companyId is required");
      }
      const userId = scopedUserId(input, request);
      const [cards, preferences] = await Promise.all([
        store.listCards({ companyId, userId, includeHidden }),
        store.loadPreferences({ companyId, userId }),
      ]);
      return {
        cards,
        preferences,
        fetchedAt: new Date().toISOString(),
      };
    });

    ctx.data.register("settings", async (params, request) => {
      const input = bridgeParams(params);
      const companyId = stringParam(input.companyId, "companyId");
      const userId = scopedUserId(input, request);
      const [managedProject, managedAgent, managedSkills, managedRoutines, agentOptions, projectOptions, preferences] = await Promise.all([
        ctx.projects.managed.get(BRIEFS_PROJECT_KEY, companyId),
        ctx.agents.managed.get(BRIEFING_ANALYST_AGENT_KEY, companyId),
        Promise.all(BRIEFS_MANAGED_SKILL_KEYS.map((skillKey) => ctx.skills.managed.get(skillKey, companyId))),
        Promise.all(BRIEFS_MANAGED_ROUTINE_KEYS.map((routineKey) => ctx.routines.managed.get(routineKey, companyId))),
        ctx.agents.list({ companyId, limit: 200 }),
        ctx.projects.list({ companyId, limit: 200 }),
        store.loadPreferences({ companyId, userId }),
      ]);

      return {
        managedProject,
        managedAgent,
        managedSkills,
        managedRoutines,
        preferences,
        agentOptions: agentOptions.map((agent) => ({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          adapterType: agent.adapterType ?? null,
          icon: agent.icon ?? null,
        })),
        projectOptions: projectOptions.map((project) => ({
          id: project.id,
          name: project.name,
          status: project.status,
          color: "color" in project && typeof project.color === "string" ? project.color : null,
        })),
      };
    });

    ctx.actions.register("save-deterministic-card", async (params, request) => {
      const input = bridgeParams(params);
      const bundle = objectParam(input.bundle, "bundle") as BriefsSourceBundle;
      assertTrustedBridgeUserScope(stringParam(bundle.userId, "bundle.userId"), request);
      const options = (input.options && typeof input.options === "object" ? input.options : {}) as DeterministicBriefOptions;
      const card = await saveBriefCard(ctx, store, bundle, options);
      return { card };
    });

    ctx.actions.register("refresh-issue-tree", async (params, request) => {
      return refreshIssueTree(ctx, store, bridgeParams(params), request);
    });

    ctx.actions.register("reconcile-managed-agent", async (params) => {
      return ctx.agents.managed.reconcile(BRIEFING_ANALYST_AGENT_KEY, stringParam(params.companyId, "companyId"));
    });

    ctx.actions.register("reset-managed-agent", async (params) => {
      return ctx.agents.managed.reset(BRIEFING_ANALYST_AGENT_KEY, stringParam(params.companyId, "companyId"));
    });

    ctx.actions.register("reconcile-managed-project", async (params) => {
      return ctx.projects.managed.reconcile(BRIEFS_PROJECT_KEY, stringParam(params.companyId, "companyId"));
    });

    async function ensureBriefsProjectReady(companyId: string) {
      const managedProject = await ctx.projects.managed.reconcile(BRIEFS_PROJECT_KEY, companyId);
      if (!managedProject.projectId) {
        throw new Error("Briefs managed project is not available");
      }
      return { managedProject, projectId: managedProject.projectId };
    }

    function managedRoutineOverrides(input: { projectId: string; agentId?: string | null }) {
      return {
        projectId: input.projectId,
        ...(input.agentId ? { assigneeAgentId: input.agentId } : {}),
      };
    }

    async function reconcileBriefsRoutineRefs(companyId: string) {
      const [{ managedProject, projectId }, managedAgent] = await Promise.all([
        ensureBriefsProjectReady(companyId),
        ctx.agents.managed.reconcile(BRIEFING_ANALYST_AGENT_KEY, companyId),
      ]);
      return {
        managedProject,
        managedAgent,
        overrides: managedRoutineOverrides({ projectId, agentId: managedAgent.agentId }),
      };
    }

    async function reconcileBriefsRoutine(
      routineKey: string,
      companyId: string,
      overrides: { projectId: string; assigneeAgentId?: string },
    ) {
      const resolved = await ctx.routines.managed.reconcile(routineKey, companyId, overrides);
      const routine = resolved.routine;
      const wrongProject = routine && routine.projectId !== overrides.projectId;
      const wrongAssignee = routine && overrides.assigneeAgentId && routine.assigneeAgentId !== overrides.assigneeAgentId;
      if (wrongProject || wrongAssignee) {
        return ctx.routines.managed.reset(routineKey, companyId, overrides);
      }
      return resolved;
    }

    ctx.actions.register("reconcile-managed-skills", async (params) => {
      const companyId = stringParam(params.companyId, "companyId");
      return {
        managedSkills: await Promise.all(
          BRIEFS_MANAGED_SKILL_KEYS.map((skillKey) => ctx.skills.managed.reconcile(skillKey, companyId)),
        ),
      };
    });

    ctx.actions.register("reset-managed-skills", async (params) => {
      const companyId = stringParam(params.companyId, "companyId");
      return {
        managedSkills: await Promise.all(
          BRIEFS_MANAGED_SKILL_KEYS.map((skillKey) => ctx.skills.managed.reset(skillKey, companyId)),
        ),
      };
    });

    ctx.actions.register("reconcile-managed-routines", async (params) => {
      const companyId = stringParam(params.companyId, "companyId");
      const { managedProject, managedAgent, overrides } = await reconcileBriefsRoutineRefs(companyId);
      return {
        managedRoutines: await Promise.all(
          BRIEFS_MANAGED_ROUTINE_KEYS.map((routineKey) => reconcileBriefsRoutine(routineKey, companyId, overrides)),
        ),
        managedProject,
        managedAgent,
      };
    });

    ctx.actions.register("reconcile-managed-routine", async (params) => {
      const companyId = stringParam(params.companyId, "companyId");
      const { overrides } = await reconcileBriefsRoutineRefs(companyId);
      return reconcileBriefsRoutine(
        stringParam(params.routineKey, "routineKey"),
        companyId,
        overrides,
      );
    });

    ctx.actions.register("reset-managed-routine", async (params) => {
      const companyId = stringParam(params.companyId, "companyId");
      const { overrides } = await reconcileBriefsRoutineRefs(companyId);
      return ctx.routines.managed.reset(
        stringParam(params.routineKey, "routineKey"),
        companyId,
        overrides,
      );
    });

    ctx.actions.register("reconcile-managed-resources", async (params) => {
      const companyId = stringParam(params.companyId, "companyId");
      const [{ managedProject, projectId }, managedAgent, managedSkills] = await Promise.all([
        ensureBriefsProjectReady(companyId),
        ctx.agents.managed.reconcile(BRIEFING_ANALYST_AGENT_KEY, companyId),
        Promise.all(BRIEFS_MANAGED_SKILL_KEYS.map((skillKey) => ctx.skills.managed.reconcile(skillKey, companyId))),
      ]);
      const overrides = managedRoutineOverrides({ projectId, agentId: managedAgent.agentId });
      const managedRoutines = await Promise.all(
        BRIEFS_MANAGED_ROUTINE_KEYS.map((routineKey) => reconcileBriefsRoutine(routineKey, companyId, overrides)),
      );
      return { managedProject, managedSkills, managedAgent, managedRoutines };
    });

    ctx.actions.register("update-managed-routine-status", async (params) => {
      return ctx.routines.managed.update(
        stringParam(params.routineKey, "routineKey"),
        stringParam(params.companyId, "companyId"),
        { status: stringParam(params.status, "status") },
      );
    });

    async function ensureBriefingAnalystReady(companyId: string, assigneeAgentId: string | null) {
      if (assigneeAgentId) return assigneeAgentId;
      let managedAgent = await ctx.agents.managed.reconcile(BRIEFING_ANALYST_AGENT_KEY, companyId);
      if (
        managedAgent.agent &&
        (
          codexManagedAgentNeedsRepoCheckBypass(managedAgent.agent) ||
          managedAgentNeedsBriefsToolPermission(managedAgent.agent)
        )
      ) {
        managedAgent = await ctx.agents.managed.reset(BRIEFING_ANALYST_AGENT_KEY, companyId);
      }
      const agent = managedAgent.agent;
      if (!agent) {
        throw new Error("Briefing Analyst managed agent is not available");
      }
      if (agent.status === "pending_approval") {
        throw new Error("Briefing Analyst is pending approval and cannot run yet");
      }
      if (agent.status === "terminated") {
        throw new Error("Briefing Analyst has been terminated and cannot run");
      }
      if (agent.status === "paused" || agent.status === "error") {
        const resumed = await ctx.agents.resume(agent.id, companyId);
        return resumed.id;
      }
      return agent.id;
    }

    ctx.actions.register("run-managed-routine", async (params, request) => {
      const input = bridgeParams(params);
      const routineKey = stringParam(input.routineKey, "routineKey");
      const companyId = stringParam(input.companyId, "companyId");
      const variables = routineVariablesParam(input.variables);
      const userId = "userId" in variables && typeof variables.userId === "string" && variables.userId.trim()
        ? variables.userId.trim()
        : scopedUserId(input, request);
      assertTrustedBridgeUserScope(userId, request);
      const nextVariables: Record<string, string | number | boolean> = { ...variables, userId };
      if (routineKey === MANUAL_REFRESH_ROUTINE_KEY && typeof nextVariables.rootIssueId !== "string") {
        throw new Error("rootIssueId is required for manual card refresh");
      }
      const assigneeAgentId = await ensureBriefingAnalystReady(
        companyId,
        typeof input.assigneeAgentId === "string" ? input.assigneeAgentId : null,
      );
      const { projectId } = await ensureBriefsProjectReady(companyId);
      return ctx.routines.managed.run(routineKey, companyId, {
        assigneeAgentId,
        projectId,
        variables: nextVariables,
      });
    });

    ctx.actions.register("run-briefing-routines", async (params, request) => {
      const input = bridgeParams(params);
      const companyId = stringParam(input.companyId, "companyId");
      const userId = scopedUserId(input, request);
      const assigneeAgentId = await ensureBriefingAnalystReady(
        companyId,
        typeof input.assigneeAgentId === "string" ? input.assigneeAgentId : null,
      );
      const { projectId } = await ensureBriefsProjectReady(companyId);
      const routineKeys = BRIEFS_MANAGED_ROUTINE_KEYS.filter((routineKey) => routineKey !== MANUAL_REFRESH_ROUTINE_KEY);
      const runs = [];
      for (const routineKey of routineKeys) {
        runs.push(await ctx.routines.managed.run(routineKey, companyId, {
          assigneeAgentId,
          projectId,
          variables: { userId },
        }));
      }
      return { runs };
    });

    ctx.actions.register("run-manual-refresh-routine", async (params, request) => {
      const input = bridgeParams(params);
      const rootIssueId = stringParam(input.rootIssueId, "rootIssueId");
      const companyId = stringParam(input.companyId, "companyId");
      const assigneeAgentId = await ensureBriefingAnalystReady(
        companyId,
        typeof input.assigneeAgentId === "string" ? input.assigneeAgentId : null,
      );
      const { projectId } = await ensureBriefsProjectReady(companyId);
      return ctx.routines.managed.run(MANUAL_REFRESH_ROUTINE_KEY, companyId, {
        assigneeAgentId,
        projectId,
        variables: {
          userId: scopedUserId(input, request),
          rootIssueId,
        },
      });
    });

    ctx.actions.register("pin-card", async (params, request) => {
      const raw = bridgeParams(params);
      const input = pinBriefCardInputSchema.parse({
        ...raw,
        userId: scopedUserId(raw, request),
      });
      await store.setPinned(input);
      await ctx.activity.log({
        companyId: input.companyId,
        message: `${input.pinned ? "Pinned" : "Unpinned"} briefing card`,
        entityType: "plugin:briefs:card",
        entityId: input.cardId,
        metadata: { userId: input.userId, pinned: input.pinned },
      });
      return { ok: true };
    });

    ctx.actions.register("dismiss-card", async (params, request) => {
      const raw = bridgeParams(params);
      const input = dismissBriefCardInputSchema.parse({
        ...raw,
        userId: scopedUserId(raw, request),
      });
      await store.dismissCard(input);
      await ctx.activity.log({
        companyId: input.companyId,
        message: "Dismissed briefing card",
        entityType: "plugin:briefs:card",
        entityId: input.cardId,
        metadata: { userId: input.userId },
      });
      return { ok: true };
    });

    ctx.actions.register("update-preferences", async (params, request) => {
      const raw = bridgeParams(params);
      const input = updateBriefPreferencesInputSchema.parse({
        ...raw,
        userId: scopedUserId(raw, request),
      });
      const preferences = briefPreferencesSchema.parse(input);
      await store.upsertPreferences(preferences);
      await ctx.activity.log({
        companyId: preferences.companyId,
        message: "Updated briefing preferences",
        entityType: "plugin:briefs:preferences",
        entityId: preferences.userId,
        metadata: preferences,
      });
      return { preferences };
    });

    ctx.tools.register("briefs_list_cards", {
      displayName: "List Briefing Cards",
      description: "List current Briefing cards for a company/user pair.",
      parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "briefs_list_cards")?.parametersSchema ?? { type: "object" },
    }, async (params): Promise<ToolResult> => {
      const input = bridgeParams(params);
      const cards = await store.listCards(listBriefCardsInputSchema.parse(input));
      return {
        content: cards.length ? cards.map((card) => `${card.slug}: ${card.state} (${card.summaryStatus})`).join("\n") : "No Briefing cards found.",
        data: { cards },
      };
    });

    ctx.tools.register("briefs_save_card", {
      displayName: "Save Briefing Card",
      description: "Save a deterministic or generated Briefing card from a source bundle.",
      parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "briefs_save_card")?.parametersSchema ?? { type: "object" },
    }, async (params, runCtx): Promise<ToolResult> => {
      const input = bridgeParams(params);
      const bundle = objectParam(input.bundle, "bundle") as BriefsSourceBundle;
      const rawOptions = input.options && typeof input.options === "object" ? input.options as Record<string, unknown> : {};
      const card = await saveBriefCard(ctx, store, bundle, {
        ...summaryOptions(rawOptions),
        generatedByAgentId: runCtx.agentId,
        generatedByRunId: runCtx.runId,
      });
      return {
        content: `Saved Briefing card ${card.slug} with ${card.state}/${card.summaryStatus}.`,
        data: { card },
      };
    });

    ctx.tools.register("briefs_refresh_issue_tree", {
      displayName: "Refresh Briefing Issue Tree",
      description: "Build and save a Briefing card for one Paperclip issue tree. Call once to inspect deterministic rows, then again with title, summary, and allowGeneratedSummary: true.",
      parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "briefs_refresh_issue_tree")?.parametersSchema ?? { type: "object" },
    }, async (params, runCtx): Promise<ToolResult> => {
      const input = bridgeParams(params);
      const result = await refreshIssueTree(ctx, store, {
        ...input,
        generatedByAgentId: runCtx.agentId,
        generatedByRunId: runCtx.runId,
      });
      return {
        content: `Refreshed Briefing card ${result.card.slug} with ${result.card.state}/${result.card.summaryStatus}.`,
        data: result,
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Briefs deterministic card service ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
