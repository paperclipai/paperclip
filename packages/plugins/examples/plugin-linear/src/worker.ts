import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginJobContext,
  type PluginWebhookInput,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, TOOL_NAMES, WEBHOOK_KEYS } from "./constants.js";
import { LinearClient, type LinearIssue } from "./linear-client.js";
import type { IssueRow, LinearSnapshot } from "./types.js";

// ---------------------------------------------------------------------------

interface PluginConfig {
  linearApiKeyRef: string;
  teamFilter: string[];
}

let currentCtx: PluginContext | null = null;
let lastSyncError: string | null = null;

const PRIORITY: Record<number, string> = { 0: "none", 1: "urgent", 2: "high", 3: "medium", 4: "low" };
const weekAgo = () => new Date(Date.now() - 7 * 86_400_000).toISOString();
const hoursBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
const daysUntil = (d: string) => Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000));
const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

function toRow(i: LinearIssue): IssueRow {
  return {
    identifier: i.identifier, title: i.title,
    priority: i.priority, priorityLabel: i.priorityLabel,
    state: i.state.name, stateType: i.state.type,
    assignee: i.assignee?.displayName ?? null, team: i.team.key,
    createdAt: i.createdAt, updatedAt: i.updatedAt,
    dueDate: i.dueDate, url: i.url,
  };
}

async function getConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = (await ctx.config.get()) as Partial<PluginConfig> | null;
  return { linearApiKeyRef: "", teamFilter: [], ...raw };
}

async function makeClient(ctx: PluginContext): Promise<LinearClient> {
  const cfg = await getConfig(ctx);
  if (!cfg.linearApiKeyRef) throw new Error("Linear API key secret reference not configured");
  const key = await ctx.secrets.resolve(cfg.linearApiKeyRef);
  if (!key) throw new Error("Resolved Linear API key is empty");
  return new LinearClient(ctx.http, key);
}

// ---------------------------------------------------------------------------

async function sync(ctx: PluginContext): Promise<LinearSnapshot> {
  const cfg = await getConfig(ctx);
  const client = await makeClient(ctx);
  const since = new Date(weekAgo());

  const v = await client.verify();
  if (!v.ok) throw new Error("Cannot connect to Linear — check your API key");

  const [allTeams, cycles, projects] = await Promise.all([
    client.teams(), client.activeCycles(), client.projects(),
  ]);

  const teams = cfg.teamFilter.length
    ? allTeams.filter((t) => cfg.teamFilter.some((f) =>
        [t.name, t.id, t.key].some((v) => v.toLowerCase() === f.toLowerCase())))
    : allTeams;
  const teamIds = teams.map((t) => t.id);

  ctx.logger.info(`Syncing ${teams.length} teams for ${v.name}`);

  const all: LinearIssue[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < 10; p++) {
    const r = await client.issues({ teamIds: teamIds.length ? teamIds : undefined, after: cursor });
    all.push(...r.issues);
    if (!r.hasMore || !r.endCursor) break;
    cursor = r.endCursor;
  }

  const open = all.filter((i) => !i.completedAt && !i.cancelledAt);
  const doneWeek = all.filter((i) => i.completedAt && new Date(i.completedAt) >= since);
  const createdWeek = all.filter((i) => new Date(i.createdAt) >= since);
  const wip = all.filter((i) => i.state.type === "started");

  const prioDist: Record<string, number> = { none: 0, urgent: 0, high: 0, medium: 0, low: 0 };
  open.forEach((i) => { prioDist[PRIORITY[i.priority] ?? "none"]++; });

  const teamSnaps = teams.map((t) => {
    const tOpen = open.filter((i) => i.team.id === t.id);
    const tWip = wip.filter((i) => i.team.id === t.id);
    const tDone = doneWeek.filter((i) => i.team.id === t.id);
    const hrs = tDone.filter((i) => i.completedAt).map((i) => hoursBetween(i.createdAt, i.completedAt!));
    return {
      name: t.name, key: t.key,
      openIssues: tOpen.length, inProgressIssues: tWip.length,
      completedThisWeek: tDone.length, avgResolutionHours: Math.round(avg(hrs) * 10) / 10,
    };
  });

  const assigneeMap = new Map<string, { completed: number; inProgress: number }>();
  const bump = (name: string, field: "completed" | "inProgress") => {
    const e = assigneeMap.get(name) ?? { completed: 0, inProgress: 0 };
    e[field]++;
    assigneeMap.set(name, e);
  };
  doneWeek.forEach((i) => bump(i.assignee?.displayName ?? "Unassigned", "completed"));
  wip.forEach((i) => bump(i.assignee?.displayName ?? "Unassigned", "inProgress"));

  const activeStates = new Set(["planned", "started", "paused", "backlog"]);

  const snapshot: LinearSnapshot = {
    syncedAt: new Date().toISOString(),
    workspace: v.name!,
    teamCount: teams.length,
    totalOpenIssues: open.length,
    issuesCreatedThisWeek: createdWeek.length,
    issuesCompletedThisWeek: doneWeek.length,
    avgResolutionHours: Math.round(avg(doneWeek.filter((i) => i.completedAt).map((i) => hoursBetween(i.createdAt, i.completedAt!))) * 10) / 10,
    priorityDistribution: prioDist,
    activeCycles: cycles
      .filter((c) => !teamIds.length || teamIds.includes(c.team.id))
      .map((c) => ({
        teamKey: c.team.key, teamName: c.team.name,
        number: c.number, name: c.name,
        progress: Math.round(c.progress * 100),
        startsAt: c.startsAt, endsAt: c.endsAt,
        daysRemaining: daysUntil(c.endsAt),
        scopeHistory: c.scopeHistory, completedScopeHistory: c.completedScopeHistory,
      })),
    activeProjects: projects
      .filter((p) => activeStates.has(p.state.toLowerCase()))
      .map((p) => ({
        name: p.name, state: p.state, progress: Math.round(p.progress * 100),
        lead: p.lead?.displayName ?? null, targetDate: p.targetDate, url: p.url,
      })),
    teams: teamSnaps.sort((a, b) => b.completedThisWeek - a.completedThisWeek),
    topAssignees: [...assigneeMap.entries()]
      .map(([name, v]) => ({ name, completedThisWeek: v.completed, inProgress: v.inProgress }))
      .sort((a, b) => b.completedThisWeek - a.completedThisWeek)
      .slice(0, 15),
  };

  const rows: IssueRow[] = open.concat(doneWeek).map(toRow)
    .sort((a, b) => a.priority - b.priority || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 500);

  await ctx.state.set({ scopeKind: "instance", stateKey: "linear-snapshot" }, snapshot);
  await ctx.state.set({ scopeKind: "instance", stateKey: "issue-list" }, rows);

  for (const [k, v] of Object.entries({
    "linear.open_issues": snapshot.totalOpenIssues,
    "linear.completed_week": snapshot.issuesCompletedThisWeek,
    "linear.avg_resolution_hours": snapshot.avgResolutionHours,
    "linear.active_cycles": snapshot.activeCycles.length,
  })) await ctx.metrics.write(k, v);

  return snapshot;
}

// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentCtx = ctx;
    ctx.logger.info("Linear plugin starting");

    ctx.jobs.register(JOB_KEYS.sync, async (job: PluginJobContext) => {
      ctx.logger.info("Linear sync", { runId: job.runId, trigger: job.trigger });
      try { await sync(ctx); lastSyncError = null; }
      catch (err) { lastSyncError = String(err instanceof Error ? err.message : err); ctx.logger.error("Sync failed", { error: lastSyncError }); }
    });

    ctx.data.register("linear-summary", async () => {
      const s = await ctx.state.get({ scopeKind: "instance", stateKey: "linear-snapshot" });
      return s ? { status: "ok", snapshot: s } : { status: "pending", message: "Waiting for first sync…" };
    });

    ctx.data.register("issue-list", async () =>
      (await ctx.state.get({ scopeKind: "instance", stateKey: "issue-list" })) ?? [],
    );

    ctx.actions.register("sync-now", async () => {
      const s = await sync(ctx); lastSyncError = null;
      return { ok: true, snapshot: s };
    });

    ctx.tools.register(TOOL_NAMES.stats, {
      displayName: "Linear Workspace Stats",
      description: "Returns current snapshot for the connected Linear workspace.",
      parametersSchema: { type: "object", properties: {} },
    }, async (): Promise<ToolResult> => {
      const s = await ctx.state.get({ scopeKind: "instance", stateKey: "linear-snapshot" }) as LinearSnapshot | null;
      if (!s) return { error: "No data synced yet. Trigger a sync first." };
      return {
        content: [
          `${s.workspace} (${s.teamCount} teams, synced ${s.syncedAt})`,
          `Open: ${s.totalOpenIssues} | Created 7d: ${s.issuesCreatedThisWeek} | Completed 7d: ${s.issuesCompletedThisWeek} | Avg res: ${s.avgResolutionHours}h`,
          `Cycles: ${s.activeCycles.length} | Projects: ${s.activeProjects.length}`,
          ...s.teams.map((t) => `  ${t.key}: ${t.openIssues} open, ${t.completedThisWeek} done`),
        ].join("\n"),
        data: s,
      };
    });

    ctx.tools.register(TOOL_NAMES.issueList, {
      displayName: "Linear Issue List",
      description: "Lists issues with optional filters.",
      parametersSchema: { type: "object", properties: {
        team: { type: "string" }, assignee: { type: "string" },
        state: { type: "string" }, priority: { type: "number" }, limit: { type: "number" },
      }},
    }, async (params): Promise<ToolResult> => {
      const { team, assignee, state, priority, limit } = params as Record<string, string | number | undefined>;
      let rows = ((await ctx.state.get({ scopeKind: "instance", stateKey: "issue-list" })) ?? []) as IssueRow[];
      if (team) rows = rows.filter((r) => r.team.toLowerCase() === String(team).toLowerCase());
      if (assignee) rows = rows.filter((r) => r.assignee?.toLowerCase() === String(assignee).toLowerCase());
      if (state) rows = rows.filter((r) => r.state.toLowerCase() === String(state).toLowerCase());
      if (priority !== undefined) rows = rows.filter((r) => r.priority === Number(priority));
      rows = rows.slice(0, Number(limit) || 50);
      return {
        content: rows.length ? rows.map((r) => `${r.identifier} [${r.priorityLabel}] ${r.title} (${r.state}, ${r.assignee ?? "—"}, ${r.team})`).join("\n") : "No issues found.",
        data: rows,
      };
    });
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    if (!currentCtx) return { status: "error", message: "Not initialized" };
    const s = await currentCtx.state.get({ scopeKind: "instance", stateKey: "linear-snapshot" }) as LinearSnapshot | null;
    if (lastSyncError) return { status: "degraded", message: `Sync failed: ${lastSyncError}`, details: { lastSync: s?.syncedAt ?? null } };
    return s
      ? { status: "ok", message: `${s.workspace} (${s.teamCount} teams) — synced ${s.syncedAt}`, details: { teams: s.teamCount, openIssues: s.totalOpenIssues } }
      : { status: "degraded", message: "Waiting for first sync" };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const typed = config as unknown as PluginConfig;
    if (!typed.linearApiKeyRef) { errors.push("Linear API key secret reference is required"); return { ok: false, warnings: [], errors }; }
    if (currentCtx) {
      try {
        const key = await currentCtx.secrets.resolve(typed.linearApiKeyRef);
        if (key) { const r = await new LinearClient(currentCtx.http, key).verify(); if (!r.ok) errors.push("Cannot connect — check API key"); }
      } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
    }
    return { ok: errors.length === 0, warnings: [], errors };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.events) throw new Error(`Unknown endpoint "${input.endpointKey}"`);
    if (!currentCtx) return;
    const body = input.parsedBody as Record<string, unknown> | undefined;
    const type = String(body?.type ?? "unknown");
    if (["Issue", "Project", "Cycle"].includes(type)) {
      try { await sync(currentCtx); lastSyncError = null; } catch (e) { lastSyncError = String(e instanceof Error ? e.message : e); }
    }
  },

  async onConfigChanged() {
    if (!currentCtx) return;
    try { await sync(currentCtx); lastSyncError = null; } catch (e) { lastSyncError = String(e instanceof Error ? e.message : e); }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
