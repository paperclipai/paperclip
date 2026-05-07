import type { PluginConfig } from "./types.js";

export interface Handlers {
  issueOpened(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  issueEdited(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  issueClosed(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  commentCreated(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  workflowRun(payload: any, ctx: any, config: PluginConfig): Promise<void>;
  prMerged(payload: any, ctx: any, config: PluginConfig): Promise<void>;
}

export async function dispatch(
  event: string,
  payload: any,
  ctx: { config?: PluginConfig },
  handlers: Handlers,
): Promise<void> {
  if (event === "issues") {
    if (payload.action === "opened")  return handlers.issueOpened(payload, ctx, ctx.config as PluginConfig);
    if (payload.action === "edited")  return handlers.issueEdited(payload, ctx, ctx.config as PluginConfig);
    if (payload.action === "closed")  return handlers.issueClosed(payload, ctx, ctx.config as PluginConfig);
    return;
  }
  if (event === "issue_comment") {
    if (payload.action === "created") return handlers.commentCreated(payload, ctx, ctx.config as PluginConfig);
    return;
  }
  if (event === "workflow_run") {
    if (payload.action === "completed" && payload.workflow_run?.conclusion === "success") {
      return handlers.workflowRun(payload, ctx, ctx.config as PluginConfig);
    }
    return;
  }
  if (event === "pull_request") {
    if (payload.action === "closed" && payload.pull_request?.merged === true) {
      return handlers.prMerged(payload, ctx, ctx.config as PluginConfig);
    }
    return;
  }
}
