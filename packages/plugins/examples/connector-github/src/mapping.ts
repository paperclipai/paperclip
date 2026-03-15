import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_NS } from "./constants.js";

type IssueMapping = { paperclipIssueId: string };
type PrMapping = { paperclipIssueId: string };

function issueKey(owner: string, repo: string, ghNumber: number): string {
  return `${STATE_NS}:issue:${owner}/${repo}:${ghNumber}`;
}

function prKey(owner: string, repo: string, prNumber: number): string {
  return `${STATE_NS}:pr:${owner}/${repo}:${prNumber}`;
}

export async function getIssueMapping(
  ctx: PluginContext,
  owner: string,
  repo: string,
  ghNumber: number,
): Promise<IssueMapping | null> {
  return await ctx.state.get({
    scopeKind: "instance",
    stateKey: issueKey(owner, repo, ghNumber),
  }) as IssueMapping | null;
}

export async function setIssueMapping(
  ctx: PluginContext,
  owner: string,
  repo: string,
  ghNumber: number,
  paperclipIssueId: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: issueKey(owner, repo, ghNumber) },
    { paperclipIssueId },
  );
}

export async function getPrMapping(
  ctx: PluginContext,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PrMapping | null> {
  return await ctx.state.get({
    scopeKind: "instance",
    stateKey: prKey(owner, repo, prNumber),
  }) as PrMapping | null;
}

export async function setPrMapping(
  ctx: PluginContext,
  owner: string,
  repo: string,
  prNumber: number,
  paperclipIssueId: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: prKey(owner, repo, prNumber) },
    { paperclipIssueId },
  );
}
