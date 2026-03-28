import type { PluginContext } from "@paperclipai/plugin-sdk";

export async function getIssueMapping(ctx: PluginContext, githubRef: string): Promise<string | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: `issue:${githubRef}:paperclipId` })) as string | null;
}

export async function setIssueMapping(ctx: PluginContext, githubRef: string, paperclipId: string): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: `issue:${githubRef}:paperclipId` }, paperclipId);
  await ctx.state.set({ scopeKind: "instance", stateKey: `issue:${paperclipId}:githubRef` }, githubRef);
}

export async function getGithubRefForIssue(ctx: PluginContext, paperclipId: string): Promise<string | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: `issue:${paperclipId}:githubRef` })) as string | null;
}

export async function setPRMapping(ctx: PluginContext, prRef: string, paperclipIssueId: string): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: `pr:${prRef}:paperclipIssueId` }, paperclipIssueId);
  await ctx.state.set({ scopeKind: "instance", stateKey: `issue:${paperclipIssueId}:prRef` }, prRef);
}

export async function getIssueForPR(ctx: PluginContext, prRef: string): Promise<string | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: `pr:${prRef}:paperclipIssueId` })) as string | null;
}

export async function getProjectIdForRepo(ctx: PluginContext, repoFullName: string): Promise<string | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: `repo:${repoFullName}:projectId` })) as string | null;
}

export async function setProjectIdForRepo(ctx: PluginContext, repoFullName: string, projectId: string): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: `repo:${repoFullName}:projectId` }, projectId);
}

export async function getRepoCursor(ctx: PluginContext, repoFullName: string): Promise<{ lastPollAt: string } | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: `repo:${repoFullName}:cursor` })) as { lastPollAt: string } | null;
}

export async function setRepoCursor(ctx: PluginContext, repoFullName: string, lastPollAt: string): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: `repo:${repoFullName}:cursor` }, { lastPollAt });
}

export async function getIssueUpdatedAt(ctx: PluginContext, githubRef: string): Promise<string | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: `issue:${githubRef}:updatedAt` })) as string | null;
}

export async function setIssueUpdatedAt(ctx: PluginContext, githubRef: string, updatedAt: string): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: `issue:${githubRef}:updatedAt` }, updatedAt);
}
