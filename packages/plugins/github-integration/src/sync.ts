/**
 * Sync logic between GitHub Issues and Paperclip issues.
 * Manages link state in plugin state storage and handles
 * bidirectional status + comment syncing.
 *
 * SDK fix applied: removed `scopeId: "default"` from all `{ scopeKind: "instance" }` state
 * calls — `scopeId` must be omitted for instance-scoped keys per current SDK contract.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as github from "./github.js";

const LINK_PREFIX = "link:";
const GH_PREFIX = "gh:";

export interface IssueLink {
  paperclipIssueId: string;
  paperclipCompanyId: string;
  ghOwner: string;
  ghRepo: string;
  ghNumber: number;
  ghHtmlUrl: string;
  syncDirection: "bidirectional" | "github-to-paperclip" | "paperclip-to-github";
  lastSyncAt: string;
  lastGhState: "open" | "closed";
  lastCommentSyncAt: string | null;
}

function linkStateKey(paperclipIssueId: string): string {
  return `${LINK_PREFIX}${paperclipIssueId}`;
}

function ghStateKey(owner: string, repo: string, number: number): string {
  return `${GH_PREFIX}${owner}/${repo}#${number}`;
}

export async function getLink(
  ctx: PluginContext,
  paperclipIssueId: string,
): Promise<IssueLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: linkStateKey(paperclipIssueId),
  });
  if (!raw) return null;
  return JSON.parse(String(raw)) as IssueLink;
}

export async function getLinkByGitHub(
  ctx: PluginContext,
  owner: string,
  repo: string,
  number: number,
): Promise<IssueLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: ghStateKey(owner, repo, number),
  });
  if (!raw) return null;
  const paperclipIssueId = String(raw);
  return getLink(ctx, paperclipIssueId);
}

export async function createLink(
  ctx: PluginContext,
  params: {
    paperclipIssueId: string;
    paperclipCompanyId: string;
    ghOwner: string;
    ghRepo: string;
    ghNumber: number;
    ghHtmlUrl: string;
    ghState: "open" | "closed";
    syncDirection: IssueLink["syncDirection"];
  },
): Promise<IssueLink> {
  const link: IssueLink = {
    paperclipIssueId: params.paperclipIssueId,
    paperclipCompanyId: params.paperclipCompanyId,
    ghOwner: params.ghOwner,
    ghRepo: params.ghRepo,
    ghNumber: params.ghNumber,
    ghHtmlUrl: params.ghHtmlUrl,
    syncDirection: params.syncDirection,
    lastSyncAt: new Date().toISOString(),
    lastGhState: params.ghState,
    lastCommentSyncAt: null,
  };

  await ctx.state.set(
    { scopeKind: "instance", stateKey: linkStateKey(params.paperclipIssueId) },
    JSON.stringify(link),
  );

  await ctx.state.set(
    { scopeKind: "instance", stateKey: ghStateKey(params.ghOwner, params.ghRepo, params.ghNumber) },
    params.paperclipIssueId,
  );

  return link;
}

export async function updateLink(
  ctx: PluginContext,
  paperclipIssueId: string,
  patch: Partial<Pick<IssueLink, "lastSyncAt" | "lastGhState" | "lastCommentSyncAt" | "syncDirection">>,
): Promise<IssueLink | null> {
  const existing = await getLink(ctx, paperclipIssueId);
  if (!existing) return null;

  const updated: IssueLink = { ...existing, ...patch };

  await ctx.state.set(
    { scopeKind: "instance", stateKey: linkStateKey(paperclipIssueId) },
    JSON.stringify(updated),
  );

  return updated;
}

export async function deleteLink(
  ctx: PluginContext,
  paperclipIssueId: string,
): Promise<void> {
  const existing = await getLink(ctx, paperclipIssueId);
  if (!existing) return;

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: linkStateKey(paperclipIssueId),
  });

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: ghStateKey(existing.ghOwner, existing.ghRepo, existing.ghNumber),
  });
}

/**
 * Sync a GitHub issue state change to the linked Paperclip issue.
 */
export async function syncGitHubStateToPaperclip(
  ctx: PluginContext,
  link: IssueLink,
  ghState: "open" | "closed",
): Promise<void> {
  if (link.syncDirection === "paperclip-to-github") return;
  if (link.lastGhState === ghState) return;

  const paperclipStatus = ghState === "closed" ? "done" : "in_progress";
  await ctx.issues.update(
    link.paperclipIssueId,
    { status: paperclipStatus },
    link.paperclipCompanyId,
  );

  await updateLink(ctx, link.paperclipIssueId, {
    lastSyncAt: new Date().toISOString(),
    lastGhState: ghState,
  });
}

/**
 * Sync new GitHub comments to the linked Paperclip issue.
 */
export async function syncGitHubCommentsToPaperclip(
  ctx: PluginContext,
  link: IssueLink,
  fetch: PluginContext["http"]["fetch"],
  token: string,
): Promise<void> {
  if (link.syncDirection === "paperclip-to-github") return;

  const comments = await github.listComments(
    fetch,
    token,
    link.ghOwner,
    link.ghRepo,
    link.ghNumber,
    link.lastCommentSyncAt ?? undefined,
  );

  for (const comment of comments) {
    const body = `**[${comment.user.login} on GitHub](${comment.html_url}):**\n\n${comment.body}`;
    await ctx.issues.createComment(link.paperclipIssueId, body, link.paperclipCompanyId);
  }

  if (comments.length > 0) {
    await updateLink(ctx, link.paperclipIssueId, {
      lastCommentSyncAt: new Date().toISOString(),
    });
  }
}
