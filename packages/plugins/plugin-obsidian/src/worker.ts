import { definePlugin, runWorker, type PluginContext, type PluginJobContext } from "@paperclipai/plugin-sdk";
import type { Goal, Issue } from "@paperclipai/shared";
import {
  ACTION_KEYS,
  DATA_KEYS,
  DEFAULT_CONFIG,
  JOB_KEYS,
  STATE_KEYS,
  type ObsidianPluginConfig,
  type SyncEntityType,
} from "./constants.js";
import { commitAndPush, ensureRepo } from "./lib/git-sync.js";
import { mapGoalToNote, mapIssueToNote, type MapperContext, type ObsidianNote } from "./lib/mapper.js";
import { writeNotesToVault } from "./lib/vault-writer.js";

interface SyncCursor {
  lastSyncAt: string;
  issueCount: number;
  goalCount: number;
}

interface SyncResult {
  success: boolean;
  issuesSynced: number;
  goalsSynced: number;
  filesWritten: number;
  gitCommitted: boolean;
  gitPushed: boolean;
  error?: string;
  syncedAt: string;
}

async function getConfig(ctx: PluginContext): Promise<ObsidianPluginConfig> {
  const raw = (await ctx.config.get()) as Partial<ObsidianPluginConfig>;
  return { ...DEFAULT_CONFIG, ...raw };
}

async function getVaultPath(config: ObsidianPluginConfig): Promise<string> {
  if (config.vaultPath) return config.vaultPath;
  if (config.gitRemoteUrl) {
    // Derive vault path from git URL
    const repoName =
      config.gitRemoteUrl
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") ?? "obsidian-vault";
    return `/tmp/paperclip-obsidian-vaults/${repoName}`;
  }
  throw new Error("Either vaultPath or gitRemoteUrl must be configured");
}

async function buildMapperContext(
  ctx: PluginContext,
  config: ObsidianPluginConfig,
  companyId: string,
  issues: Issue[],
): Promise<MapperContext> {
  // Collect goal IDs to resolve titles
  const goalIds = new Set<string>();
  for (const issue of issues) {
    if (issue.goalId) goalIds.add(issue.goalId);
  }

  // Resolve names in parallel
  const projectNames = new Map<string, string>();
  const agentNames = new Map<string, string>();
  const goalTitles = new Map<string, string>();
  const commentsByIssue = new Map<string, Array<{ body: string; createdAt: string; authorName: string }>>();

  const [projects, agents] = await Promise.all([ctx.projects.list({ companyId }), ctx.agents.list({ companyId })]);

  for (const p of projects) {
    projectNames.set(p.id, p.name);
  }
  for (const a of agents) {
    agentNames.set(a.id, a.name);
  }

  // Fetch goals for title resolution
  if (goalIds.size > 0) {
    const goals = await ctx.goals.list({ companyId });
    for (const g of goals) {
      goalTitles.set(g.id, g.title);
    }
  }

  // Fetch comments if configured
  if (config.includeComments) {
    // Fetch in batches to avoid overwhelming the API
    for (const issue of issues) {
      try {
        const comments = await ctx.issues.listComments(issue.id, issue.companyId);
        commentsByIssue.set(
          issue.id,
          comments.map((c: { body?: string; createdAt: Date | string; authorAgentId?: string | null }) => ({
            body: c.body ?? "",
            createdAt: typeof c.createdAt === "string" ? c.createdAt : new Date(c.createdAt).toISOString(),
            authorName: c.authorAgentId ? (agentNames.get(c.authorAgentId) ?? "Agent") : "User",
          })),
        );
      } catch {
        // Skip comments on error
      }
    }
  }

  return {
    projectNames,
    agentNames,
    goalTitles,
    commentsByIssue,
    folderStructure: config.folderStructure,
    includeComments: config.includeComments,
    maxCommentsPerIssue: config.maxCommentsPerIssue,
  };
}

async function performSync(ctx: PluginContext): Promise<SyncResult> {
  const syncedAt = new Date().toISOString();
  const config = await getConfig(ctx);

  if (!config.vaultPath && !config.gitRemoteUrl) {
    return {
      success: false,
      issuesSynced: 0,
      goalsSynced: 0,
      filesWritten: 0,
      gitCommitted: false,
      gitPushed: false,
      error: "No vault path or git remote URL configured",
      syncedAt,
    };
  }

  // Resolve company ID
  const companies = await ctx.companies.list();
  const companyId = companies[0]?.id;
  if (!companyId) {
    return {
      success: false,
      issuesSynced: 0,
      goalsSynced: 0,
      filesWritten: 0,
      gitCommitted: false,
      gitPushed: false,
      error: "No company found",
      syncedAt,
    };
  }

  const vaultPath = await getVaultPath(config);

  // Ensure git repo is ready if using git
  if (config.gitRemoteUrl) {
    const repoResult = await ensureRepo({
      vaultPath,
      gitRemoteUrl: config.gitRemoteUrl,
      gitBranch: config.gitBranch,
    });
    if (repoResult.error) {
      ctx.logger.warn("Git repo setup issue", { error: repoResult.error });
    }
  }

  const notes: ObsidianNote[] = [];
  let issuesSynced = 0;
  let goalsSynced = 0;

  // Fetch and map issues
  if (config.syncEntities.includes("issues")) {
    const issues = await ctx.issues.list({ companyId });
    const mapperCtx = await buildMapperContext(ctx, config, companyId, issues);

    for (const issue of issues) {
      notes.push(mapIssueToNote(issue, mapperCtx));
      issuesSynced++;
    }
  }

  // Fetch and map goals
  if (config.syncEntities.includes("goals")) {
    const goals = await ctx.goals.list({ companyId });
    const agentNames = new Map<string, string>();
    const agents = await ctx.agents.list({ companyId });
    for (const a of agents) {
      agentNames.set(a.id, a.name);
    }

    const goalMapperCtx: MapperContext = {
      projectNames: new Map(),
      agentNames,
      goalTitles: new Map(),
      commentsByIssue: new Map(),
      folderStructure: config.folderStructure,
      includeComments: false,
      maxCommentsPerIssue: 0,
    };

    for (const goal of goals) {
      notes.push(mapGoalToNote(goal, goalMapperCtx));
      goalsSynced++;
    }
  }

  // Write notes to vault
  const writtenPaths = await writeNotesToVault(vaultPath, notes);
  ctx.logger.info("Notes written to vault", {
    count: writtenPaths.length,
    vaultPath,
  });

  // Commit and push if git is configured
  let gitCommitted = false;
  let gitPushed = false;

  if (config.gitRemoteUrl) {
    const gitResult = await commitAndPush({
      vaultPath,
      gitRemoteUrl: config.gitRemoteUrl,
      gitBranch: config.gitBranch,
      message: `sync: ${issuesSynced} issues, ${goalsSynced} goals [${syncedAt}]`,
    });
    gitCommitted = gitResult.committed;
    gitPushed = gitResult.pushed;
    if (gitResult.error) {
      ctx.logger.warn("Git sync issue", { error: gitResult.error });
    }
  }

  // Update sync cursor state
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: companyId,
      stateKey: STATE_KEYS.lastSyncCursor,
    },
    {
      lastSyncAt: syncedAt,
      issueCount: issuesSynced,
      goalCount: goalsSynced,
    } satisfies SyncCursor,
  );

  return {
    success: true,
    issuesSynced,
    goalsSynced,
    filesWritten: writtenPaths.length,
    gitCommitted,
    gitPushed,
    syncedAt,
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Obsidian Vault Sync plugin starting");

    // --- Scheduled sync job ---
    ctx.jobs.register(JOB_KEYS.sync, async (_job: PluginJobContext) => {
      ctx.logger.info("Starting scheduled Obsidian sync");
      const result = await performSync(ctx);
      ctx.logger.info("Sync completed", { result });
    });

    // --- Event subscriptions for incremental awareness ---
    ctx.events.on("issue.created", async (event) => {
      ctx.logger.debug("Issue created event received", {
        entityId: event.entityId,
      });
    });

    ctx.events.on("issue.updated", async (event) => {
      ctx.logger.debug("Issue updated event received", {
        entityId: event.entityId,
      });
    });

    ctx.events.on("goal.created", async (event) => {
      ctx.logger.debug("Goal created event received", {
        entityId: event.entityId,
      });
    });

    ctx.events.on("goal.updated", async (event) => {
      ctx.logger.debug("Goal updated event received", {
        entityId: event.entityId,
      });
    });

    // --- Data handlers for UI ---
    ctx.data.register(DATA_KEYS.syncHealth, async () => {
      const companies = await ctx.companies.list();
      const companyId = companies[0]?.id;
      if (!companyId) {
        return { status: "unconfigured", lastSync: null };
      }

      const cursor = (await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.lastSyncCursor,
      })) as SyncCursor | null;

      const config = await getConfig(ctx);
      const hasVault = Boolean(config.vaultPath || config.gitRemoteUrl);

      return {
        status: hasVault ? "configured" : "unconfigured",
        lastSync: cursor,
        vaultPath: config.vaultPath || "(git remote)",
        gitRemoteUrl: config.gitRemoteUrl || null,
        syncEntities: config.syncEntities,
      };
    });

    ctx.data.register(DATA_KEYS.syncLog, async () => {
      const companies = await ctx.companies.list();
      const companyId = companies[0]?.id;
      if (!companyId) return { entries: [] };

      const cursor = (await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.lastSyncCursor,
      })) as SyncCursor | null;

      return {
        entries: cursor
          ? [
              {
                syncedAt: cursor.lastSyncAt,
                issueCount: cursor.issueCount,
                goalCount: cursor.goalCount,
              },
            ]
          : [],
      };
    });

    // --- Action handlers ---
    ctx.actions.register(ACTION_KEYS.triggerSync, async () => {
      ctx.logger.info("Manual sync triggered from UI");
      const result = await performSync(ctx);
      return result;
    });
  },

  async onHealth() {
    return { status: "ok", message: "Obsidian Vault Sync plugin is healthy" };
  },

  async onConfigChanged(newConfig) {
    // Config changes are handled on next sync run
  },

  async onValidateConfig(config) {
    const c = config as Partial<ObsidianPluginConfig>;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!c.vaultPath && !c.gitRemoteUrl) {
      warnings.push("Either vault path or git remote URL should be configured for sync to work.");
    }

    if (c.syncIntervalMinutes !== undefined && (c.syncIntervalMinutes < 1 || c.syncIntervalMinutes > 1440)) {
      errors.push("Sync interval must be between 1 and 1440 minutes.");
    }

    if (c.maxCommentsPerIssue !== undefined && (c.maxCommentsPerIssue < 0 || c.maxCommentsPerIssue > 100)) {
      errors.push("Max comments per issue must be between 0 and 100.");
    }

    return { ok: errors.length === 0, warnings, errors };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
