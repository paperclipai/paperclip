/**
 * Agent tools for GitHub issue search, link, and unlink.
 *
 * SDK fix applied: ctx.tools.register requires 3 args (name, declaration, fn).
 * The original mvanhorn plugin used 2-arg form which no longer matches the SDK.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { TOOL_NAMES } from "./constants.js";
import * as github from "./github.js";
import * as sync from "./sync.js";

export function registerTools(ctx: PluginContext): void {
  // -----------------------------------------------------------------------
  // github_search_issues
  // -----------------------------------------------------------------------
  ctx.tools.register(
    TOOL_NAMES.searchIssues,
    {
      displayName: "Search GitHub Issues",
      description: "Search GitHub issues in a repository. Returns matching issue titles, states, URLs, and labels.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string" },
          repo: { type: "string", description: "Repository in owner/repo format (optional, uses default if configured)" },
        },
        required: ["query"],
      },
    },
    async (params, runCtx) => {
      const p = params as Record<string, unknown>;
      const config = (await ctx.config.get()) as Record<string, unknown>;
      const tokenRef = config.githubTokenRef as string | undefined;
      if (!tokenRef) return { error: "githubTokenRef not configured" };

      const token = await ctx.secrets.resolve(tokenRef);
      const defaultRepo = config.defaultRepo as string | undefined;
      const repo = (p.repo as string | undefined) || defaultRepo || "";
      if (!repo) {
        return {
          error: "No repository specified. Pass repo parameter or configure a default repository.",
        };
      }

      try {
        const results = await github.searchIssues(
          ctx.http.fetch.bind(ctx.http),
          token,
          repo,
          p.query as string,
        );
        return {
          content: `Found ${results.total_count} issues`,
          data: {
            total_count: results.total_count,
            issues: results.items.map((issue) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              url: issue.html_url,
              labels: issue.labels.map((l) => l.name),
              assignees: issue.assignees.map((a) => a.login),
              updated_at: issue.updated_at,
            })),
          },
        };
      } catch (err) {
        return { error: String(err) };
      }
    },
  );

  // -----------------------------------------------------------------------
  // github_link_issue
  // -----------------------------------------------------------------------
  ctx.tools.register(
    TOOL_NAMES.linkIssue,
    {
      displayName: "Link GitHub Issue",
      description: "Link a GitHub issue to the current Paperclip issue for bidirectional sync.",
      parametersSchema: {
        type: "object",
        properties: {
          ghIssueUrl: {
            type: "string",
            description: "GitHub issue URL, owner/repo#number, or #number (with a configured default repo)",
          },
          syncDirection: {
            type: "string",
            enum: ["bidirectional", "github-to-paperclip", "paperclip-to-github"],
            description: "Sync direction (defaults to bidirectional)",
          },
        },
        required: ["ghIssueUrl"],
      },
    },
    async (params, runCtx) => {
      const p = params as Record<string, unknown>;
      const config = (await ctx.config.get()) as Record<string, unknown>;
      const tokenRef = config.githubTokenRef as string | undefined;
      if (!tokenRef) return { error: "githubTokenRef not configured" };

      const token = await ctx.secrets.resolve(tokenRef);
      const defaultRepo = config.defaultRepo as string | undefined;

      const ref = github.parseGitHubIssueRef(p.ghIssueUrl as string, defaultRepo);
      if (!ref) return { error: "Could not parse GitHub issue reference." };

      const issueId = runCtx.issueId;
      const companyId = runCtx.companyId;
      if (!issueId || !companyId) return { error: "No issue context available. The agent must be working on a Paperclip issue to use this tool." };

      try {
        const ghIssue = await github.getIssue(
          ctx.http.fetch.bind(ctx.http),
          token,
          ref.owner,
          ref.repo,
          ref.number,
        );

        const syncDirection =
          (p.syncDirection as sync.IssueLink["syncDirection"] | undefined) ?? "bidirectional";

        const link = await sync.createLink(ctx, {
          paperclipIssueId: issueId,
          paperclipCompanyId: companyId,
          ghOwner: ref.owner,
          ghRepo: ref.repo,
          ghNumber: ref.number,
          ghHtmlUrl: ghIssue.html_url,
          ghState: ghIssue.state,
          syncDirection,
        });

        return {
          content: `Linked to GitHub issue #${ref.number} in ${ref.owner}/${ref.repo}`,
          data: { link },
        };
      } catch (err) {
        return { error: String(err) };
      }
    },
  );

  // -----------------------------------------------------------------------
  // github_unlink_issue
  // -----------------------------------------------------------------------
  ctx.tools.register(
    TOOL_NAMES.unlinkIssue,
    {
      displayName: "Unlink GitHub Issue",
      description: "Remove the GitHub issue link from the current Paperclip issue.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    async (_params, runCtx) => {
      const issueId = runCtx.issueId;
      const companyId = runCtx.companyId;
      if (!issueId || !companyId) return { error: "No issue context available. The agent must be working on a Paperclip issue to use this tool." };

      const existing = await sync.getLink(ctx, issueId);
      if (!existing) return { error: "No GitHub link found for this issue." };

      await sync.deleteLink(ctx, issueId);
      return { content: `Unlinked GitHub issue #${existing.ghNumber} from ${existing.ghOwner}/${existing.ghRepo}` };
    },
  );
}
