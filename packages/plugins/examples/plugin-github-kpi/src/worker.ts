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
import {
  DEFAULT_CONFIG,
  JOB_KEYS,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";
import { GitHubClient, type GitHubPR, type GitHubRepo, type WorkflowRun } from "./github-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginConfig {
  orgName: string;
  githubTokenRef: string;
  repoFilter: string[];
  repoExclude: string[];
}

export interface RepoKpi {
  repo: string;
  openPRs: number;
  mergedPRsThisWeek: number;
  avgPRCycleMinutes: number;
  commitsThisWeek: number;
  linesChanged: number;
  openIssues: number;
  closedIssuesThisWeek: number;
  deploysThisWeek: number;
  latestRelease: string | null;
  contributors: Array<{ login: string; commits: number }>;
  ciRuns: number;
  ciPassed: number;
  ciFailed: number;
  ciPassRate: number;
}

export interface CicdKpis {
  totalRuns: number;
  passed: number;
  failed: number;
  cancelled: number;
  passRate: number;
  avgDurationMinutes: number;
  mttrMinutes: number;
  failuresByAuthor: Array<{ login: string; failures: number }>;
  failuresByWorkflow: Array<{ name: string; repo: string; failures: number; total: number; passRate: number }>;
  recentFailures: Array<{
    repo: string;
    workflow: string;
    branch: string;
    actor: string;
    conclusion: string;
    createdAt: string;
    runNumber: number;
  }>;
}

export interface KpiSnapshot {
  syncedAt: string;
  org: string;
  repoCount: number;
  // aggregate
  commitsThisWeek: number;
  commitActivitySpark: number[];
  linesChangedThisWeek: number;
  openPRs: number;
  mergedPRsThisWeek: number;
  avgPRCycleMinutes: number;
  openIssues: number;
  closedIssuesThisWeek: number;
  avgIssueResolutionHours: number;
  // team
  contributorsThisMonth: number;
  topContributors: Array<{ login: string; commits: number }>;
  // deploys
  deploysThisWeek: number;
  latestRelease: string | null;
  // derived
  velocityMultiplier: number;
  throughputPerDev: number;
  // CI/CD
  cicd: CicdKpis;
  // per-repo breakdown
  repos: RepoKpi[];
}

export interface PRRow {
  number: number;
  title: string;
  repo: string;
  author: string;
  branch: string;
  ageHours: number;
  draft: boolean;
  reviewers: string[];
  additions: number;
  deletions: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentCtx: PluginContext | null = null;
let lastSyncError: string | null = null;

async function getConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = await ctx.config.get();
  return {
    orgName: DEFAULT_CONFIG.orgName,
    githubTokenRef: DEFAULT_CONFIG.githubTokenRef,
    repoFilter: [...DEFAULT_CONFIG.repoFilter],
    repoExclude: [...DEFAULT_CONFIG.repoExclude],
    ...(raw as unknown as Partial<PluginConfig>),
  };
}

async function createClient(ctx: PluginContext): Promise<GitHubClient> {
  const config = await getConfig(ctx);
  if (!config.orgName) throw new Error("GitHub organisation name must be configured");
  let token = "";
  if (config.githubTokenRef) {
    try {
      token = await ctx.secrets.resolve(config.githubTokenRef);
    } catch {
      ctx.logger.warn("Could not resolve GitHub token — falling back to unauthenticated access");
    }
  }
  return new GitHubClient(ctx.http, config.orgName, token);
}

function filterRepos(repos: GitHubRepo[], config: PluginConfig): GitHubRepo[] {
  let filtered = repos.filter((r) => !r.archived);
  if (config.repoFilter.length > 0) {
    const allowed = new Set(config.repoFilter.map((n) => n.toLowerCase()));
    filtered = filtered.filter((r) => allowed.has(r.name.toLowerCase()));
  }
  if (config.repoExclude.length > 0) {
    const denied = new Set(config.repoExclude.map((n) => n.toLowerCase()));
    filtered = filtered.filter((r) => !denied.has(r.name.toLowerCase()));
  }
  return filtered;
}

function weekAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function hoursAgo(dateStr: string): number {
  return (Date.now() - new Date(dateStr).getTime()) / 3_600_000;
}

function prCycleMinutes(pr: GitHubPR): number | null {
  if (!pr.merged_at) return null;
  return (new Date(pr.merged_at).getTime() - new Date(pr.created_at).getTime()) / 60_000;
}

function toPRRow(pr: GitHubPR, repoName: string): PRRow {
  return {
    number: pr.number,
    title: pr.title,
    repo: repoName,
    author: pr.user.login,
    branch: pr.head.ref,
    ageHours: Math.round(hoursAgo(pr.created_at) * 10) / 10,
    draft: pr.draft,
    reviewers: pr.requested_reviewers.map((r) => r.login),
    additions: pr.additions,
    deletions: pr.deletions,
    updatedAt: pr.updated_at,
  };
}

// Pre-AI baseline commits/week (used for velocity multiplier)
const PRE_AI_BASELINE_COMMITS_WEEK = 42;

// ---------------------------------------------------------------------------
// Org-wide sync — iterates repos, aggregates KPIs
// ---------------------------------------------------------------------------

async function syncGitHubData(ctx: PluginContext): Promise<KpiSnapshot> {
  const config = await getConfig(ctx);
  const client = await createClient(ctx);
  const since = weekAgo();

  const allRepos = await client.listOrgRepos();
  const repos = filterRepos(allRepos, config);
  ctx.logger.info(`Syncing ${repos.length} repos for org ${config.orgName}`);

  // Per-repo fetch (parallelised in batches of 5)
  const repoKpis: RepoKpi[] = [];
  const allPRRows: PRRow[] = [];
  const contributorMap = new Map<string, number>();
  const weeklyActivityAgg = new Array<number>(8).fill(0);
  let totalLinesChanged = 0;
  let totalCycleMinutes: number[] = [];
  let totalIssueResolutionHours: number[] = [];
  let totalDeploys = 0;
  let latestReleaseGlobal: { tag: string; date: string } | null = null;

  // CI/CD aggregation
  const allWorkflowRuns: (WorkflowRun & { _repo: string })[] = [];
  const ciFailuresByAuthor = new Map<string, number>();
  const ciWorkflowStats = new Map<string, { name: string; repo: string; passed: number; failed: number; total: number }>();

  const batchSize = 5;
  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);
    await Promise.all(batch.map(async (repo) => {
      try {
        const [openPRs, closedPRs, commits, openIssues, closedIssues, activity, contributors, releases, workflowRuns] =
          await Promise.all([
            client.listPullRequests(repo.name, "open", 100).catch(() => []),
            client.listPullRequests(repo.name, "closed", 50).catch(() => []),
            client.listCommits(repo.name, since, 100).catch(() => []),
            client.listIssues(repo.name, "open", undefined, 100).catch(() => []),
            client.listIssues(repo.name, "closed", since, 100).catch(() => []),
            client.getCommitActivity(repo.name).catch(() => []),
            client.getContributorStats(repo.name).catch(() => []),
            client.listReleases(repo.name, 5).catch(() => []),
            client.listWorkflowRuns(repo.name, { created: `>=${since.slice(0, 10)}`, perPage: 100 }).catch(() => []),
          ]);

        // PRs
        openPRs.forEach((pr) => allPRRows.push(toPRRow(pr, repo.name)));
        const mergedThisWeek = closedPRs.filter(
          (pr) => pr.merged_at && new Date(pr.merged_at).getTime() > Date.now() - 7 * 86_400_000,
        );
        const cycles = mergedThisWeek.map((pr) => prCycleMinutes(pr)!).filter(Boolean);
        totalCycleMinutes.push(...cycles);

        // Commits + lines
        let repoLines = 0;
        const repoContribs = new Map<string, number>();
        commits.forEach((c) => {
          const login = c.author?.login ?? c.commit.author.name;
          contributorMap.set(login, (contributorMap.get(login) ?? 0) + 1);
          repoContribs.set(login, (repoContribs.get(login) ?? 0) + 1);
        });
        // Estimate lines from merged PRs (GitHub doesn't give per-commit line stats cheaply)
        mergedThisWeek.forEach((pr) => {
          repoLines += pr.additions + pr.deletions;
          totalLinesChanged += pr.additions + pr.deletions;
        });

        // Issues
        const closedTimes = closedIssues
          .filter((i) => i.closed_at)
          .map((i) => (new Date(i.closed_at!).getTime() - new Date(i.created_at).getTime()) / 3_600_000);
        totalIssueResolutionHours.push(...closedTimes);

        // Activity spark
        const spark = activity.slice(-8);
        spark.forEach((w, idx) => { weeklyActivityAgg[idx] = (weeklyActivityAgg[idx] ?? 0) + w.total; });

        // Releases
        const nonDraftReleases = releases.filter((r) => !r.draft);
        const releasesThisWeek = nonDraftReleases.filter(
          (r) => new Date(r.published_at).getTime() > Date.now() - 7 * 86_400_000,
        );
        totalDeploys += releasesThisWeek.length;
        if (nonDraftReleases.length > 0) {
          const latest = nonDraftReleases[0]!;
          if (!latestReleaseGlobal || new Date(latest.published_at) > new Date(latestReleaseGlobal.date)) {
            latestReleaseGlobal = { tag: `${repo.name}@${latest.tag_name}`, date: latest.published_at };
          }
        }

        const avgCycle = cycles.length > 0 ? cycles.reduce((a, b) => a + b, 0) / cycles.length : 0;

        // CI/CD per-repo
        const completedRuns = workflowRuns.filter((r) => r.status === "completed");
        const repoCiPassed = completedRuns.filter((r) => r.conclusion === "success").length;
        const repoCiFailed = completedRuns.filter((r) => r.conclusion === "failure").length;

        completedRuns.forEach((run) => {
          allWorkflowRuns.push({ ...run, _repo: repo.name });

          const wfKey = `${repo.name}::${run.name}`;
          const wfEntry = ciWorkflowStats.get(wfKey) ?? { name: run.name, repo: repo.name, passed: 0, failed: 0, total: 0 };
          wfEntry.total++;
          if (run.conclusion === "success") wfEntry.passed++;
          if (run.conclusion === "failure") wfEntry.failed++;
          ciWorkflowStats.set(wfKey, wfEntry);

          if (run.conclusion === "failure") {
            const actor = run.triggering_actor?.login ?? run.actor?.login ?? "unknown";
            ciFailuresByAuthor.set(actor, (ciFailuresByAuthor.get(actor) ?? 0) + 1);
          }
        });

        const repoContributors = Array.from(repoContribs.entries())
          .map(([login, commits]) => ({ login, commits }))
          .sort((a, b) => b.commits - a.commits)
          .slice(0, 10);

        repoKpis.push({
          repo: repo.name,
          openPRs: openPRs.length,
          mergedPRsThisWeek: mergedThisWeek.length,
          avgPRCycleMinutes: Math.round(avgCycle),
          commitsThisWeek: commits.length,
          linesChanged: repoLines,
          openIssues: openIssues.length,
          closedIssuesThisWeek: closedIssues.length,
          deploysThisWeek: releasesThisWeek.length,
          latestRelease: nonDraftReleases[0]?.tag_name ?? null,
          contributors: repoContributors,
          ciRuns: completedRuns.length,
          ciPassed: repoCiPassed,
          ciFailed: repoCiFailed,
          ciPassRate: completedRuns.length > 0 ? Math.round((repoCiPassed / completedRuns.length) * 100) : 100,
        });
      } catch (err) {
        ctx.logger.warn(`Skipping repo ${repo.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
  }

  // Aggregate
  const totalCommits = repoKpis.reduce((s, r) => s + r.commitsThisWeek, 0);
  const avgCycleAll = totalCycleMinutes.length > 0
    ? totalCycleMinutes.reduce((a, b) => a + b, 0) / totalCycleMinutes.length
    : 0;
  const avgIssueRes = totalIssueResolutionHours.length > 0
    ? totalIssueResolutionHours.reduce((a, b) => a + b, 0) / totalIssueResolutionHours.length
    : 0;

  const topContributors = Array.from(contributorMap.entries())
    .map(([login, commits]) => ({ login, commits }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 15);

  const activeContributors = contributorMap.size || 1;

  // ── Aggregate CI/CD ──────────────────────────────────────────────
  const ciCompleted = allWorkflowRuns.filter((r) => r.status === "completed");
  const ciPassed = ciCompleted.filter((r) => r.conclusion === "success").length;
  const ciFailed = ciCompleted.filter((r) => r.conclusion === "failure").length;
  const ciCancelled = ciCompleted.filter((r) => r.conclusion === "cancelled").length;

  // Duration: time from run_started_at to updated_at
  const ciDurations = ciCompleted
    .filter((r) => r.run_started_at && r.updated_at)
    .map((r) => (new Date(r.updated_at).getTime() - new Date(r.run_started_at).getTime()) / 60_000)
    .filter((d) => d > 0 && d < 180);
  const avgCiDuration = ciDurations.length > 0
    ? ciDurations.reduce((a, b) => a + b, 0) / ciDurations.length
    : 0;

  // MTTR: for each failure, find the next success on the same branch+workflow and measure gap
  const mttrSamples: number[] = [];
  const failedRuns = ciCompleted
    .filter((r) => r.conclusion === "failure")
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const fail of failedRuns) {
    const recovery = ciCompleted.find(
      (r) =>
        r.conclusion === "success" &&
        r._repo === fail._repo &&
        r.name === fail.name &&
        r.head_branch === fail.head_branch &&
        new Date(r.created_at).getTime() > new Date(fail.created_at).getTime(),
    );
    if (recovery) {
      const gap = (new Date(recovery.created_at).getTime() - new Date(fail.created_at).getTime()) / 60_000;
      if (gap > 0 && gap < 1440) mttrSamples.push(gap);
    }
  }
  const mttrAvg = mttrSamples.length > 0 ? mttrSamples.reduce((a, b) => a + b, 0) / mttrSamples.length : 0;

  const failuresByWorkflow = Array.from(ciWorkflowStats.values())
    .filter((w) => w.failed > 0)
    .map((w) => ({ name: w.name, repo: w.repo, failures: w.failed, total: w.total, passRate: Math.round((w.passed / w.total) * 100) }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 10);

  const failuresByAuthor = Array.from(ciFailuresByAuthor.entries())
    .map(([login, failures]) => ({ login, failures }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 10);

  const recentFailures = ciCompleted
    .filter((r) => r.conclusion === "failure")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10)
    .map((r) => ({
      repo: r._repo,
      workflow: r.name,
      branch: r.head_branch,
      actor: r.triggering_actor?.login ?? r.actor?.login ?? "unknown",
      conclusion: r.conclusion ?? "failure",
      createdAt: r.created_at,
      runNumber: r.run_number,
    }));

  const cicd: CicdKpis = {
    totalRuns: ciCompleted.length,
    passed: ciPassed,
    failed: ciFailed,
    cancelled: ciCancelled,
    passRate: ciCompleted.length > 0 ? Math.round((ciPassed / ciCompleted.length) * 100) : 100,
    avgDurationMinutes: Math.round(avgCiDuration * 10) / 10,
    mttrMinutes: Math.round(mttrAvg),
    failuresByAuthor,
    failuresByWorkflow,
    recentFailures,
  };

  const snapshot: KpiSnapshot = {
    syncedAt: new Date().toISOString(),
    org: config.orgName,
    repoCount: repos.length,
    commitsThisWeek: totalCommits,
    commitActivitySpark: weeklyActivityAgg,
    linesChangedThisWeek: totalLinesChanged,
    openPRs: repoKpis.reduce((s, r) => s + r.openPRs, 0),
    mergedPRsThisWeek: repoKpis.reduce((s, r) => s + r.mergedPRsThisWeek, 0),
    avgPRCycleMinutes: Math.round(avgCycleAll),
    openIssues: repoKpis.reduce((s, r) => s + r.openIssues, 0),
    closedIssuesThisWeek: repoKpis.reduce((s, r) => s + r.closedIssuesThisWeek, 0),
    avgIssueResolutionHours: Math.round(avgIssueRes * 10) / 10,
    contributorsThisMonth: activeContributors,
    topContributors,
    deploysThisWeek: totalDeploys,
    latestRelease: (latestReleaseGlobal as { tag: string } | null)?.tag ?? null,
    velocityMultiplier: Math.round((totalCommits / PRE_AI_BASELINE_COMMITS_WEEK) * 10) / 10,
    throughputPerDev: Math.round(totalCommits / activeContributors),
    cicd,
    repos: repoKpis.sort((a, b) => b.commitsThisWeek - a.commitsThisWeek),
  };

  await ctx.state.set({ scopeKind: "instance", stateKey: "kpi-snapshot" }, snapshot);
  await ctx.state.set({ scopeKind: "instance", stateKey: "pr-list" }, allPRRows);

  await ctx.metrics.write("github.org.repos_tracked", snapshot.repoCount);
  await ctx.metrics.write("github.org.open_prs", snapshot.openPRs);
  await ctx.metrics.write("github.org.merged_prs_week", snapshot.mergedPRsThisWeek);
  await ctx.metrics.write("github.org.commits_week", snapshot.commitsThisWeek);
  await ctx.metrics.write("github.org.avg_pr_cycle_minutes", snapshot.avgPRCycleMinutes);
  await ctx.metrics.write("github.org.open_issues", snapshot.openIssues);
  await ctx.metrics.write("github.org.contributors_month", snapshot.contributorsThisMonth);
  await ctx.metrics.write("github.org.velocity_multiplier", snapshot.velocityMultiplier);
  await ctx.metrics.write("github.org.deploys_week", snapshot.deploysThisWeek);
  await ctx.metrics.write("github.org.ci_pass_rate", snapshot.cicd.passRate);
  await ctx.metrics.write("github.org.ci_total_runs", snapshot.cicd.totalRuns);
  await ctx.metrics.write("github.org.ci_failures", snapshot.cicd.failed);
  await ctx.metrics.write("github.org.ci_mttr_minutes", snapshot.cicd.mttrMinutes);
  await ctx.metrics.write("github.org.ci_avg_duration_minutes", snapshot.cicd.avgDurationMinutes);

  return snapshot;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentCtx = ctx;
    ctx.logger.info("GitHub Org KPI plugin starting");

    ctx.jobs.register(JOB_KEYS.sync, async (job: PluginJobContext) => {
      ctx.logger.info("Running GitHub org sync job", { runId: job.runId, trigger: job.trigger });
      try {
        const snapshot = await syncGitHubData(ctx);
        lastSyncError = null;
        ctx.logger.info("GitHub org sync complete", {
          repos: snapshot.repoCount,
          commits: snapshot.commitsThisWeek,
        });
      } catch (err) {
        lastSyncError = err instanceof Error ? err.message : String(err);
        ctx.logger.error("GitHub org sync failed", { error: lastSyncError });
      }
    });

    ctx.data.register("kpi-summary", async () => {
      const snapshot = await ctx.state.get({ scopeKind: "instance", stateKey: "kpi-snapshot" });
      if (!snapshot) return { status: "pending", message: "Waiting for first sync…" };
      return { status: "ok", snapshot };
    });

    ctx.data.register("pr-list", async () => {
      const list = await ctx.state.get({ scopeKind: "instance", stateKey: "pr-list" });
      return list ?? [];
    });

    ctx.actions.register("sync-now", async () => {
      const snapshot = await syncGitHubData(ctx);
      lastSyncError = null;
      return { ok: true, snapshot };
    });

    ctx.tools.register(
      TOOL_NAMES.stats,
      {
        displayName: "GitHub Org Stats",
        description: "Returns current KPI snapshot for the configured GitHub organisation.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (): Promise<ToolResult> => {
        const snapshot = (await ctx.state.get({
          scopeKind: "instance",
          stateKey: "kpi-snapshot",
        })) as KpiSnapshot | null;
        if (!snapshot) {
          return { error: "No GitHub data synced yet. Trigger a sync first." };
        }
        const lines = [
          `GitHub Org KPI snapshot for ${snapshot.org} (${snapshot.repoCount} repos, synced ${snapshot.syncedAt}):`,
          `  Velocity: ${snapshot.velocityMultiplier}x baseline`,
          `  Commits (7d): ${snapshot.commitsThisWeek}`,
          `  Lines changed (7d): ${snapshot.linesChangedThisWeek}`,
          `  PRs merged (7d): ${snapshot.mergedPRsThisWeek}`,
          `  Avg PR cycle: ${snapshot.avgPRCycleMinutes}m`,
          `  Open PRs: ${snapshot.openPRs}`,
          `  Open issues: ${snapshot.openIssues}`,
          `  Closed issues (7d): ${snapshot.closedIssuesThisWeek}`,
          `  Contributors (30d): ${snapshot.contributorsThisMonth}`,
          `  Deploys (7d): ${snapshot.deploysThisWeek}`,
          snapshot.latestRelease ? `  Latest release: ${snapshot.latestRelease}` : null,
          "",
          "CI/CD:",
          `  Build pass rate: ${snapshot.cicd.passRate}%`,
          `  Total runs (7d): ${snapshot.cicd.totalRuns}`,
          `  Failures: ${snapshot.cicd.failed}`,
          `  Avg pipeline duration: ${snapshot.cicd.avgDurationMinutes}m`,
          `  MTTR: ${snapshot.cicd.mttrMinutes}m`,
          "",
          "Top repos by commits:",
          ...snapshot.repos.slice(0, 5).map((r) => `  ${r.repo}: ${r.commitsThisWeek} commits, ${r.mergedPRsThisWeek} PRs merged, CI ${r.ciPassRate}%`),
        ].filter(Boolean);
        return { content: lines.join("\n"), data: snapshot };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.prList,
      {
        displayName: "GitHub Org Open PRs",
        description: "Lists open pull requests across all organisation repos.",
        parametersSchema: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["open", "closed", "all"] },
            limit: { type: "number" },
            repo: { type: "string" },
          },
        },
      },
      async (params): Promise<ToolResult> => {
        const { limit, repo } = params as { state?: string; limit?: number; repo?: string };
        let rows = ((await ctx.state.get({ scopeKind: "instance", stateKey: "pr-list" })) ?? []) as PRRow[];
        if (repo) rows = rows.filter((r) => r.repo.toLowerCase() === repo.toLowerCase());
        if (limit) rows = rows.slice(0, limit);
        const lines = rows.map(
          (r) =>
            `#${r.number} [${r.repo}] ${r.title} (${r.author}, ${Math.round(r.ageHours)}h old, +${r.additions}/-${r.deletions})`,
        );
        return {
          content: lines.length > 0 ? lines.join("\n") : "No pull requests found.",
          data: rows,
        };
      },
    );

    ctx.logger.info("GitHub Org KPI plugin setup complete");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentCtx;
    if (!ctx) return { status: "error", message: "Plugin not initialized" };

    const snapshot = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: "kpi-snapshot",
    })) as KpiSnapshot | null;

    if (lastSyncError) {
      return {
        status: "degraded",
        message: `Last sync failed: ${lastSyncError}`,
        details: { lastSync: snapshot?.syncedAt ?? null },
      };
    }

    return {
      status: snapshot ? "ok" : "degraded",
      message: snapshot
        ? `Tracking org ${snapshot.org} (${snapshot.repoCount} repos) — last synced ${snapshot.syncedAt}`
        : "Waiting for first sync",
      details: snapshot
        ? { repos: snapshot.repoCount, commitsThisWeek: snapshot.commitsThisWeek, syncedAt: snapshot.syncedAt }
        : {},
    };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const typed = config as unknown as PluginConfig;

    if (!typed.orgName) errors.push("GitHub organisation name is required");
    if (!typed.githubTokenRef) {
      warnings.push(
        "No GitHub token configured — API rate limits will be very restrictive (60 req/hr). A token with org read scope is strongly recommended for org-wide sync.",
      );
    }

    if (errors.length === 0 && typed.orgName) {
      try {
        const ctx = currentCtx;
        if (ctx) {
          let token = "";
          if (typed.githubTokenRef) {
            try {
              token = await ctx.secrets.resolve(typed.githubTokenRef);
            } catch {
              warnings.push("Could not resolve GitHub token secret reference");
            }
          }
          const client = new (await import("./github-client.js")).GitHubClient(ctx.http, typed.orgName, token);
          const ok = await client.verifyOrg();
          if (!ok) errors.push(`Cannot access GitHub organisation "${typed.orgName}". Check the name and token permissions.`);
        }
      } catch (err) {
        errors.push(`Cannot reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { ok: errors.length === 0, warnings, errors };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.events) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }
    const ctx = currentCtx;
    if (!ctx) return;

    const event = (input.headers["x-github-event"] ?? "unknown") as string;
    ctx.logger.info(`Received GitHub webhook: ${event}`, { requestId: input.requestId });

    const interestingEvents = ["push", "pull_request", "issues", "release", "workflow_run", "check_run"];
    if (interestingEvents.includes(event)) {
      try {
        await syncGitHubData(ctx);
        lastSyncError = null;
      } catch (err) {
        lastSyncError = err instanceof Error ? err.message : String(err);
        ctx.logger.error("Webhook-triggered sync failed", { error: lastSyncError });
      }
    }

    const body = input.parsedBody as Record<string, unknown> | undefined;
    await ctx.state.set({ scopeKind: "instance", stateKey: "last-webhook" }, {
      event,
      action: body?.action ?? null,
      receivedAt: new Date().toISOString(),
      requestId: input.requestId,
    });
  },

  async onConfigChanged() {
    const ctx = currentCtx;
    if (!ctx) return;
    ctx.logger.info("Config changed — triggering re-sync");
    try {
      await syncGitHubData(ctx);
      lastSyncError = null;
    } catch (err) {
      lastSyncError = err instanceof Error ? err.message : String(err);
      ctx.logger.error("Config-change sync failed", { error: lastSyncError });
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
