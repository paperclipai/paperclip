import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  PLUGIN_ID,
  STATE_KEYS,
  TOOL_NAMES,
} from "./constants.js";

type IssueLinksConfig = {
  openWith?: "vscode" | "finder";
};

type IssueLinksData = {
  localPath: string | null;
  githubPrUrl: string | null;
};

async function getConfig(ctx: PluginContext): Promise<IssueLinksConfig> {
  const config = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(config as IssueLinksConfig) };
}

async function readIssueLinks(ctx: PluginContext, issueId: string): Promise<IssueLinksData> {
  const [localPath, githubPrUrl] = await Promise.all([
    ctx.state.get({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath }),
    ctx.state.get({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl }),
  ]);
  return {
    localPath: typeof localPath === "string" ? localPath : null,
    githubPrUrl: typeof githubPrUrl === "string" ? githubPrUrl : null,
  };
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    // Data handler: read both link fields for an issue
    ctx.data.register("issue-links", async (params) => {
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      if (!issueId) return { localPath: null, githubPrUrl: null };
      return await readIssueLinks(ctx, issueId);
    });

    // Data handler: expose plugin config to UI
    ctx.data.register("plugin-config", async () => {
      return await getConfig(ctx);
    });

    // Action: set local path
    ctx.actions.register("set-local-path", async (params) => {
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      const value = typeof params.value === "string" ? params.value.trim() : null;
      if (!issueId) throw new Error("issueId is required");
      const normalized = value === "" || value === null ? null : value;
      if (normalized === null) {
        await ctx.state.delete({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath });
      } else {
        await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath }, normalized);
      }
      return { ok: true, issueId, localPath: normalized };
    });

    // Action: set GitHub PR URL
    ctx.actions.register("set-github-pr-url", async (params) => {
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      const value = typeof params.value === "string" ? params.value.trim() : null;
      if (!issueId) throw new Error("issueId is required");
      const normalized = value === "" || value === null ? null : value;
      if (normalized === null) {
        await ctx.state.delete({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl });
      } else {
        await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl }, normalized);
      }
      return { ok: true, issueId, githubPrUrl: normalized };
    });

    // Agent tool: set local path
    ctx.tools.register(
      TOOL_NAMES.setLocalPath,
      {
        displayName: "Set Issue Local Path",
        description: "Set the local filesystem path for an issue.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            value: { type: "string" },
          },
          required: ["issueId", "value"],
        },
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const payload = params as { issueId?: string; value?: string };
        if (!payload.issueId) return { error: "issueId is required" };
        const issueId = payload.issueId;
        const value = typeof payload.value === "string" ? payload.value.trim() : null;
        const normalized = value === "" || value === null ? null : value;
        if (normalized === null) {
          await ctx.state.delete({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath });
        } else {
          await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath }, normalized);
        }
        await ctx.activity.log({
          companyId: runCtx.companyId,
          entityType: "issue",
          entityId: issueId,
          message: normalized
            ? `Issue Links: set local path to "${normalized}"`
            : "Issue Links: cleared local path",
          metadata: { plugin: PLUGIN_ID },
        });
        return {
          content: normalized ? `Local path set to "${normalized}"` : "Local path cleared",
          data: { issueId, localPath: normalized },
        };
      },
    );

    // Agent tool: set GitHub PR URL
    ctx.tools.register(
      TOOL_NAMES.setGithubPrUrl,
      {
        displayName: "Set Issue GitHub PR URL",
        description: "Set the GitHub PR URL for an issue.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            value: { type: "string" },
          },
          required: ["issueId", "value"],
        },
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const payload = params as { issueId?: string; value?: string };
        if (!payload.issueId) return { error: "issueId is required" };
        const issueId = payload.issueId;
        const value = typeof payload.value === "string" ? payload.value.trim() : null;
        const normalized = value === "" || value === null ? null : value;
        if (normalized === null) {
          await ctx.state.delete({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl });
        } else {
          await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl }, normalized);
        }
        await ctx.activity.log({
          companyId: runCtx.companyId,
          entityType: "issue",
          entityId: issueId,
          message: normalized
            ? `Issue Links: set GitHub PR URL to "${normalized}"`
            : "Issue Links: cleared GitHub PR URL",
          metadata: { plugin: PLUGIN_ID },
        });
        return {
          content: normalized ? `GitHub PR URL set to "${normalized}"` : "GitHub PR URL cleared",
          data: { issueId, githubPrUrl: normalized },
        };
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "Issue Links plugin ready" };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const typed = config as IssueLinksConfig;
    if (typed.openWith !== undefined && typed.openWith !== "vscode" && typed.openWith !== "finder") {
      errors.push("openWith must be 'vscode' or 'finder'");
    }
    return { ok: errors.length === 0, errors, warnings: [] };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
