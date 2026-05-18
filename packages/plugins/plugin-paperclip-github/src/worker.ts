import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginConfigValidationResult,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { resolveConfig, type ResolvedConfig } from "./config.js";
import { createGitHubClient, type GitHubClient } from "./auth.js";
import { wrapTool } from "./audit.js";
import { ISSUE_TOOL_SCHEMA, TOOL } from "./manifest.js";
import {
  openPr,
  getPr,
  updatePr,
  closePr,
  updatePrBody,
  convertPrToDraft,
  markPrReadyForReview,
  repairPrHead,
} from "./tools/pr.js";
import { getCheckRuns, createCheckRun } from "./tools/checks.js";
import { enqueueMerge } from "./tools/merge.js";
import { listIssues } from "./tools/issues.js";
import { createIssue, updateIssue, labelIssue } from "./tools/issue_mutations.js";

/**
 * Worker entrypoint for the paperclip GitHub plugin.
 *
 * On setup:
 *   1. Read instance config and resolve all three GitHub App secret refs.
 *   2. Build a single Octokit client whose auth strategy caches the
 *      installation token across calls (auth.ts).
 *   3. Register each tool — every handler is wrapped so that:
 *        - success and failure both write to ctx.activity.log
 *        - thrown RefusalError becomes ToolResult { error } not a crash
 *
 * Config changes are handled by the host restarting the worker (we do not
 * implement onConfigChanged; the SDK's default is restart-on-change which
 * gives us a clean reload of the App credentials).
 */
interface WorkerState {
  cfg: ResolvedConfig;
  client: GitHubClient;
}

let state: WorkerState | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    state = await buildState(ctx);
    registerTools(ctx);
    ctx.logger.info("plugin-paperclip-github setup complete", { repo: state.cfg.repo });
  },

  async onValidateConfig(rawConfig): Promise<PluginConfigValidationResult> {
    // Validation cannot resolve secrets (no ctx.secrets here). Check shape
    // only; deep validation happens in setup() when secrets are available.
    if (typeof rawConfig !== "object" || rawConfig === null) {
      return { ok: false, errors: ["config must be an object"] };
    }
    const cfg = rawConfig as Record<string, unknown>;
    const errors: string[] = [];
    for (const k of ["appId", "privateKeyPem", "installationId", "repo"]) {
      if (typeof cfg[k] !== "string" || (cfg[k] as string).trim() === "") {
        errors.push(`${k} is required`);
      }
    }
    if (typeof cfg.repo === "string" && !cfg.repo.includes("/")) {
      errors.push(`repo must be owner/name`);
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    if (!state) return { status: "degraded", message: "config not yet resolved" };
    return { status: "ok", message: `wired to ${state.cfg.repo}` };
  },
});

async function buildState(ctx: PluginContext): Promise<WorkerState> {
  const raw = await ctx.config.get();
  const cfg = await resolveConfig(raw, (ref) => ctx.secrets.resolve(ref));
  const client = createGitHubClient(cfg);
  return { cfg, client };
}

function registerTools(ctx: PluginContext): void {
  const wrap = (name: string, fn: Parameters<typeof wrapTool>[2]) =>
    wrapTool({ activity: ctx.activity, logger: ctx.logger }, name, fn);

  const requireState = () => {
    if (!state) throw new Error("plugin not yet initialized — onConfigChanged in flight");
    return state;
  };

  ctx.tools.register(
    TOOL.OPEN_PR,
    {
      displayName: "Open Pull Request",
      description: "Open a draft PR; refuses without an issue reference.",
      parametersSchema: openPrSchema,
    },
    wrap(TOOL.OPEN_PR, async (params, runCtx, env) => {
      const s = requireState();
      return openPr(s.client, s.cfg, params, runCtx, env);
    }),
  );

  ctx.tools.register(
    TOOL.GET_PR,
    {
      displayName: "Get Pull Request Status",
      description: "Aggregate PR readiness signal in one round-trip.",
      parametersSchema: prNumberSchema,
    },
    wrap(TOOL.GET_PR, async (params, runCtx) => {
      const s = requireState();
      return getPr(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.GET_CHECK_RUNS,
    {
      displayName: "Get Check Runs",
      description: "List check runs on a PR's head commit.",
      parametersSchema: getCheckRunsSchema,
    },
    wrap(TOOL.GET_CHECK_RUNS, async (params, runCtx) => {
      const s = requireState();
      return getCheckRuns(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.CREATE_CHECK_RUN,
    {
      displayName: "Create Check Run",
      description: "Publish a check run; refuses thin evidence.",
      parametersSchema: createCheckRunSchema,
    },
    wrap(TOOL.CREATE_CHECK_RUN, async (params, runCtx) => {
      const s = requireState();
      return createCheckRun(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.ENQUEUE_MERGE,
    {
      displayName: "Enqueue PR into Merge Queue",
      description: "Add PR to merge queue; refuses on failing checks or draft.",
      parametersSchema: prNumberSchema,
    },
    wrap(TOOL.ENQUEUE_MERGE, async (params, runCtx) => {
      const s = requireState();
      return enqueueMerge(s.client, s.cfg, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.LIST_ISSUES,
    {
      displayName: "List Issues",
      description: "List issues with label/state filters; excludes PRs.",
      parametersSchema: listIssuesSchema,
    },
    wrap(TOOL.LIST_ISSUES, async (params, runCtx) => {
      const s = requireState();
      return listIssues(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.CREATE_ISSUE,
    {
      displayName: "Create Issue",
      description: "Create a GitHub issue in the configured repository with readback.",
      parametersSchema: ISSUE_TOOL_SCHEMA.CREATE,
    },
    wrap(TOOL.CREATE_ISSUE, async (params, runCtx) => {
      const s = requireState();
      return createIssue(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.UPDATE_ISSUE,
    {
      displayName: "Update Issue",
      description: "Update a GitHub issue title, body, or state with readback.",
      parametersSchema: ISSUE_TOOL_SCHEMA.UPDATE,
    },
    wrap(TOOL.UPDATE_ISSUE, async (params, runCtx) => {
      const s = requireState();
      return updateIssue(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.LABEL_ISSUE,
    {
      displayName: "Label Issue",
      description: "Apply labels to a GitHub issue and verify label readback.",
      parametersSchema: ISSUE_TOOL_SCHEMA.LABEL,
    },
    wrap(TOOL.LABEL_ISSUE, async (params, runCtx) => {
      const s = requireState();
      return labelIssue(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.UPDATE_PR,
    {
      displayName: "Update Pull Request",
      description: "Update an existing PR title and/or body with expected head/base guards and readback.",
      parametersSchema: updatePrSchema,
    },
    wrap(TOOL.UPDATE_PR, async (params, runCtx) => {
      const s = requireState();
      return updatePr(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.CLOSE_PR,
    {
      displayName: "Close Pull Request",
      description: "Close an existing PR with expected head/base guards, audit comment, and readback.",
      parametersSchema: closePrSchema,
    },
    wrap(TOOL.CLOSE_PR, async (params, runCtx) => {
      const s = requireState();
      return closePr(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.UPDATE_PR_BODY,
    {
      displayName: "Update Pull Request Body",
      description: "Update an existing PR body with expected head/base guards and readback.",
      parametersSchema: updatePrBodySchema,
    },
    wrap(TOOL.UPDATE_PR_BODY, async (params, runCtx) => {
      const s = requireState();
      return updatePrBody(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.CONVERT_PR_TO_DRAFT,
    {
      displayName: "Convert Pull Request To Draft",
      description: "Convert an existing PR to draft with expected head/base guards and readback.",
      parametersSchema: prMutationGuardSchema,
    },
    wrap(TOOL.CONVERT_PR_TO_DRAFT, async (params, runCtx) => {
      const s = requireState();
      return convertPrToDraft(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.MARK_PR_READY_FOR_REVIEW,
    {
      displayName: "Mark Pull Request Ready For Review",
      description: "Mark an existing PR ready for review with expected head/base guards and readback.",
      parametersSchema: prMutationGuardSchema,
    },
    wrap(TOOL.MARK_PR_READY_FOR_REVIEW, async (params, runCtx) => {
      const s = requireState();
      return markPrReadyForReview(s.client, params, runCtx);
    }),
  );

  ctx.tools.register(
    TOOL.REPAIR_PR_HEAD,
    {
      displayName: "Repair Pull Request Head",
      description: "Update an existing PR head branch with expected head/base guards and readback.",
      parametersSchema: repairPrHeadSchema,
    },
    wrap(TOOL.REPAIR_PR_HEAD, async (params, runCtx) => {
      const s = requireState();
      return repairPrHead(s.client, params, runCtx);
    }),
  );
}

// Schemas duplicated from manifest.ts so worker registration is independent
// of bundler ordering. The host enforces manifest at install; these are the
// run-time schemas the SDK passes to the agent runtime.
const openPrSchema = {
  type: "object",
  properties: {
    issueId: { type: "string" },
    branch: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    draft: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
  },
  required: ["issueId", "branch", "title", "body"],
} as const;

const prNumberSchema = {
  type: "object",
  properties: { prNumber: { type: "number" } },
  required: ["prNumber"],
} as const;

const getCheckRunsSchema = {
  type: "object",
  properties: {
    prNumber: { type: "number" },
    name: { type: "string" },
  },
  required: ["prNumber"],
} as const;

const createCheckRunSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    headSha: { type: "string" },
    status: { type: "string", enum: ["queued", "in_progress", "completed"] },
    conclusion: {
      type: "string",
      enum: ["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped"],
    },
    summary: { type: "string" },
    details: { type: "string" },
    externalId: { type: "string" },
  },
  required: ["name", "headSha", "status"],
} as const;

const listIssuesSchema = {
  type: "object",
  properties: {
    labels: { type: "array", items: { type: "string" } },
    state: { type: "string", enum: ["open", "closed", "all"] },
    since: { type: "string" },
    perPage: { type: "number" },
  },
} as const;

const prMutationGuardProperties = {
  repository: { type: "string" },
  prNumber: { type: "number" },
  expectedHeadSha: { type: "string" },
  expectedBaseSha: { type: "string" },
} as const;

const prMutationGuardSchema = {
  type: "object",
  properties: prMutationGuardProperties,
  required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha"],
} as const;

const updatePrBodySchema = {
  type: "object",
  properties: {
    ...prMutationGuardProperties,
    body: { type: "string" },
    expectedCurrentBody: { type: "string" },
  },
  required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha", "body"],
} as const;

const updatePrSchema = {
  type: "object",
  properties: {
    ...prMutationGuardProperties,
    title: { type: "string" },
    body: { type: "string" },
    base: { type: "string" },
    expectedCurrentTitle: { type: "string" },
    expectedCurrentBody: { type: "string" },
  },
  required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha"],
} as const;

const closePrSchema = {
  type: "object",
  properties: {
    ...prMutationGuardProperties,
    reason: { type: "string" },
    commentBody: { type: "string" },
  },
  required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha", "reason"],
} as const;

const repairPrHeadSchema = {
  type: "object",
  properties: {
    ...prMutationGuardProperties,
    targetHeadSha: { type: "string" },
    sourceRepository: { type: "string" },
    force: { type: "boolean" },
  },
  required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha", "targetHeadSha"],
} as const;

export default plugin;
runWorker(plugin, import.meta.url);
