import type { PluginContext, Issue, ScopeKey } from "@paperclipai/plugin-sdk";
import { GitHubClient, resolveApiHost } from "./github-client.js";

export const SYNC_FOOTER =
  "\n\n---\n\nSynced from Paperclip. Comments here are not read back into Paperclip — open a PR or contact the maintainer.";

const DEFAULT_DEBOUNCE_MS = 2_000;

/** Build GitHub issue title: `[GLA-NN] title` when identifier present. */
export function buildTitle(identifier: string | null, title: string): string {
  return identifier ? `[${identifier}] ${title}` : title;
}

/**
 * Sanitise Paperclip issue description for GitHub.
 *
 * - Rewrites internal Paperclip links `[label](/PREFIX/...)` → `label`
 * - Strips bare UUID v4 patterns
 * - Appends the outbound-only sync footer
 */
export function sanitiseBody(body: string | null): string {
  let text = body ?? "";
  // Rewrite internal links: [label](/GLA/issues/GLA-123) → label
  text = text.replace(/\[([^\]]*)\]\(\/[A-Z][A-Z0-9-]*\/[^)]+\)/g, "$1");
  // Strip bare UUID v4 (8-4-4-4-12 hex groups)
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "[id-redacted]",
  );
  return text + SYNC_FOOTER;
}

export interface GitHubStateAction {
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned";
}

/** Map Paperclip status to GitHub open/close. */
export function mapIssueStatus(status: Issue["status"]): GitHubStateAction {
  if (status === "done") return { state: "closed", state_reason: "completed" };
  if (status === "cancelled") return { state: "closed", state_reason: "not_planned" };
  return { state: "open" };
}

function mappingKey(issueId: string): ScopeKey {
  return {
    scopeKind: "issue",
    scopeId: issueId,
    namespace: "github-sync",
    stateKey: "gh-issue-number",
  };
}

export interface SyncEngineConfig {
  repo: string;
  host: string;
  secretRef: string;
  dryRun: boolean;
}

export interface SyncEngineOptions {
  /** Injectable fetch for unit tests. Defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Debounce window in ms. Pass 0 for test determinism. */
  debounceMs?: number;
}

export function createSyncEngine(options?: SyncEngineOptions) {
  const fetchFn = options?.fetchFn;
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function doSync(
    issueId: string,
    companyId: string,
    ctx: PluginContext,
    config: SyncEngineConfig,
  ): Promise<void> {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) {
      ctx.logger.warn("github-sync: issue not found, skipping", { issueId });
      return;
    }

    const existingRaw = await ctx.state.get(mappingKey(issueId));
    const existingGhNumber = typeof existingRaw === "number" ? existingRaw : null;

    const title = buildTitle(issue.identifier, issue.title);
    const body = sanitiseBody(issue.description);
    const { state, state_reason } = mapIssueStatus(issue.status);
    const ts = new Date().toISOString();

    if (config.dryRun) {
      ctx.logger.info("github-sync: dry-run — would sync to GitHub", {
        issueId,
        companyId,
        action: existingGhNumber === null ? "create" : "update",
        title,
        state,
        ...(state_reason ? { state_reason } : {}),
      });
      return;
    }

    const [owner, repo] = config.repo.split("/");
    const apiHost = resolveApiHost(config.host);
    const token = await ctx.secrets.resolve(config.secretRef);
    const client = new GitHubClient({ owner, repo, apiHost, token, fetchFn });

    if (existingGhNumber === null) {
      const { issue: ghIssue } = await client.createIssue({
        title,
        body,
        labels: ["paperclip-synced"],
      });

      if (state === "closed") {
        await client.closeIssue(ghIssue.number, state_reason ?? "completed");
      }

      await ctx.state.set(mappingKey(issueId), ghIssue.number);

      ctx.logger.info("github-sync: audit — created GH issue", {
        paperclipIssueId: issueId,
        githubIssueNumber: ghIssue.number,
        action: "create",
        ts,
      });
    } else {
      await client.updateIssue(existingGhNumber, {
        title,
        body,
        state,
        ...(state_reason ? { state_reason } : {}),
        labels: ["paperclip-synced"],
      });

      ctx.logger.info("github-sync: audit — updated GH issue", {
        paperclipIssueId: issueId,
        githubIssueNumber: existingGhNumber,
        action: "update",
        ts,
      });
    }
  }

  function scheduleSync(
    issueId: string,
    companyId: string,
    ctx: PluginContext,
    config: SyncEngineConfig,
  ): void {
    const existing = timers.get(issueId);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      timers.delete(issueId);
      doSync(issueId, companyId, ctx, config).catch((err) => {
        ctx.logger.error("github-sync: sync failed", {
          issueId,
          error: String(err),
        });
      });
    }, debounceMs);

    timers.set(issueId, timer);
  }

  return { scheduleSync, doSync };
}
