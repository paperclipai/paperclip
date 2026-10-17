import type { AdapterEnvironmentTestContext, AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, testEnvironment } from "@paperclipai/adapter-codex-local/server";
import { readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { asString, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { resolveCodexCommand } from "../vendor/paperclip-runner/index.js";

const unavailable = "Codex runtime unavailable. Restore Paperclip's runtime dependencies or configure a Codex command.";

function resolveContext<T extends AdapterEnvironmentTestContext | AdapterExecutionContext>(ctx: T): T {
  const engine = typeof ctx.config.engine === "string" ? ctx.config.engine.trim().toLowerCase() : "acp";
  if (engine !== "cli" || (typeof ctx.config.command === "string" && ctx.config.command.trim())) return ctx;
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: "executionTransport" in ctx ? ctx.executionTransport?.remoteExecution : undefined,
  });
  if (target?.kind === "remote" || process.platform === "win32") return ctx;
  const overrides = Object.fromEntries(Object.entries(parseObject(ctx.config.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const environment = ensurePathInEnv({ ...process.env, ...overrides });
  const configuredCwd = asString(ctx.config.cwd, "");
  const workspace = "context" in ctx ? parseObject(ctx.context?.paperclipWorkspace) : {};
  const workspaceCwd = target?.workspaceRealization?.mode === "in_place"
    ? target.workspaceRealization.authoritativeRoot
    : workspace.source === "agent_home" && configuredCwd ? "" : asString(workspace.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  const command = resolveCodexCommand(undefined, environment, cwd);
  return { ...ctx, config: { ...ctx.config, command } };
}

export async function executeWithLocalCodexCommand(ctx: AdapterExecutionContext) {
  let resolved: AdapterExecutionContext;
  try {
    resolved = resolveContext(ctx);
  } catch {
    return {
      exitCode: 1, signal: null, timedOut: false,
      errorCode: "codex_command_unresolvable", errorMessage: unavailable,
    };
  }
  return execute(resolved);
}

export async function testWithLocalCodexCommand(ctx: AdapterEnvironmentTestContext) {
  let resolved: AdapterEnvironmentTestContext;
  try {
    resolved = resolveContext(ctx);
  } catch {
    return {
      adapterType: ctx.adapterType, status: "fail" as const,
      testedAt: new Date().toISOString(),
      checks: [{ code: "codex_command_unresolvable", level: "error" as const, message: unavailable }],
    };
  }
  // PATH discovery resolves symlinks, whose targets may not be named codex.
  return resolved === ctx
    ? testEnvironment(resolved)
    : testEnvironment(resolved, { isResolvedCodexCommand: true });
}
