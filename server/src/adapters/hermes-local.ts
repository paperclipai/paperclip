import { homedir } from "node:os";
import {
  execute as hermesPackageExecute,
  sessionCodec as hermesSessionCodec,
  testEnvironment as hermesPackageTestEnvironment,
} from "hermes-paperclip-adapter/server";
import { renderTaskBindingGuard } from "@paperclipai/adapter-utils/server-utils";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterSessionCodec,
} from "./types.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function usesDeepSeekAnthropicEndpoint(config: Record<string, unknown>, env: Record<string, unknown>): boolean {
  const provider = readNonEmptyString(config.provider)?.toLowerCase();
  const model = readNonEmptyString(config.model)?.toLowerCase();
  const configuredBaseUrl =
    readNonEmptyString(config.base_url) ??
    readNonEmptyString(config.baseUrl) ??
    readNonEmptyString(env.ANTHROPIC_BASE_URL) ??
    readNonEmptyString(env.DEEPSEEK_BASE_URL) ??
    readNonEmptyString(process.env.BLUEPRINT_PAPERCLIP_HERMES_BASE_URL) ??
    readNonEmptyString(process.env.DEEPSEEK_BASE_URL);

  return (
    configuredBaseUrl?.toLowerCase().includes("api.deepseek.com") === true ||
    model?.startsWith("deepseek-") === true ||
    (provider === "anthropic" && model?.includes("deepseek") === true)
  );
}

function mergeAdapterConfig(
  adapterConfig: unknown,
  hydratedConfig: Record<string, unknown>,
): Record<string, unknown> {
  const base = asRecord(adapterConfig);
  const env = {
    ...asRecord(base.env),
    ...asRecord(hydratedConfig.env),
  };
  const merged = {
    ...base,
    ...hydratedConfig,
  };

  if (Object.keys(env).length > 0) {
    merged.env = env;
  }

  return merged;
}

export function hydrateHermesExecutionConfig(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
  authToken?: string,
): Record<string, unknown> {
  const next = { ...config };
  const env = asRecord(config.env);

  const taskId =
    readNonEmptyString(context.taskId) ??
    readNonEmptyString(context.issueId) ??
    readNonEmptyString(config.taskId);
  const taskTitle =
    readNonEmptyString(context.taskTitle) ??
    readNonEmptyString(context.issueTitle) ??
    readNonEmptyString(config.taskTitle);
  const taskBody =
    readNonEmptyString(context.taskBody) ??
    readNonEmptyString(context.issueBody) ??
    readNonEmptyString(context.issueDescription) ??
    readNonEmptyString(config.taskBody);
  const commentId =
    readNonEmptyString(context.wakeCommentId) ??
    readNonEmptyString(context.commentId) ??
    readNonEmptyString(config.commentId);
  const wakeReason =
    readNonEmptyString(context.wakeReason) ??
    readNonEmptyString(config.wakeReason);
  const companyName =
    readNonEmptyString(context.companyName) ??
    readNonEmptyString(config.companyName);
  const projectName =
    readNonEmptyString(context.projectName) ??
    readNonEmptyString(config.projectName);

  if (taskId) next.taskId = taskId;
  if (taskTitle) next.taskTitle = taskTitle;
  if (taskBody) next.taskBody = taskBody;
  if (commentId) next.commentId = commentId;
  if (wakeReason) next.wakeReason = wakeReason;
  if (companyName) next.companyName = companyName;
  if (projectName) next.projectName = projectName;

  const taskBindingGuard = renderTaskBindingGuard(context);
  if (taskBindingGuard) {
    if (taskId) {
      next.taskBody = [taskBindingGuard, readNonEmptyString(next.taskBody)].filter(Boolean).join("\n\n");
    } else if (readNonEmptyString(next.promptTemplate)) {
      next.promptTemplate = `${taskBindingGuard}\n\n${next.promptTemplate}`;
    }
  }

  if (!readNonEmptyString(env.PAPERCLIP_API_KEY) && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  if (!readNonEmptyString(env.HERMES_HOME)) {
    env.HERMES_HOME = process.env.HERMES_HOME ?? `${homedir()}/.hermes`;
  }

  if (usesDeepSeekAnthropicEndpoint(next, env)) {
    const deepseekApiKey =
      readNonEmptyString(env.DEEPSEEK_API_KEY) ??
      readNonEmptyString(process.env.DEEPSEEK_API_KEY);
    if (deepseekApiKey) {
      env.DEEPSEEK_API_KEY = deepseekApiKey;
      env.ANTHROPIC_API_KEY = deepseekApiKey;
      env.ANTHROPIC_TOKEN = deepseekApiKey;
    }
    if (!readNonEmptyString(env.ANTHROPIC_BASE_URL)) {
      env.ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
    }
  }

  if (Object.keys(env).length > 0) {
    next.env = env;
  }

  return next;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const hydratedConfig = hydrateHermesExecutionConfig(ctx.config, ctx.context, ctx.authToken);
  const agent = ctx.agent
    ? {
        ...ctx.agent,
        adapterConfig: mergeAdapterConfig(ctx.agent.adapterConfig, hydratedConfig),
      }
    : ctx.agent;

  return hermesPackageExecute({
    ...ctx,
    agent,
    config: hydratedConfig,
  } as AdapterExecutionContext);
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return hermesPackageTestEnvironment(ctx);
}

export const sessionCodec: AdapterSessionCodec = hermesSessionCodec;
