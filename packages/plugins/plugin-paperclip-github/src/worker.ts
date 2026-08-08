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
import { TOOL } from "./manifest.js";
import { openPr, getPr } from "./tools/pr.js";
import { getCheckRuns, createCheckRun } from "./tools/checks.js";
import { enqueueMerge } from "./tools/merge.js";
import { listIssues } from "./tools/issues.js";

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

export default plugin;
runWorker(plugin, import.meta.url);
