import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "./types.js";
import { execute as claudeExecute, testEnvironment as claudeTestEnvironment } from "@paperclipai/adapter-claude-local/server";
import { execute as codexExecute, testEnvironment as codexTestEnvironment } from "@paperclipai/adapter-codex-local/server";

/**
 * `auto_rotation` adapter — a runtime dispatcher.
 *
 * An agent on this adapter rotates across the COMBINED set of Claude pool +
 * Codex pool + local default. The heartbeat (server-side, where the DB, the
 * decryption, and the balancer live) decides the globally-best account each run
 * and attaches it as `config.paperclipPoolAccount = { provider, accountId,
 * credentialsJson }`. This module reads that decision, reshapes the config for
 * the winning provider, and delegates to the real claude-local / codex-local
 * `execute()`.
 *
 * The agent stores BOTH provider sub-configs under its adapterConfig:
 *   { preferredProvider?, claude: {command,model,effort,…}, codex: {…} }
 * The winning provider's sub-config is flattened onto the top-level config so the
 * sub-adapter reads `config.command`/`config.model`/`config.effort` where it
 * already looks.
 */

type Provider = "claude" | "codex";

function readProvider(value: unknown): Provider | null {
  return value === "claude" || value === "codex" ? value : null;
}

interface PoolSeed {
  provider: Provider | null;
  accountId: string | null;
  credentialsJson: string | null;
}

function parsePoolSeed(value: unknown): PoolSeed {
  if (typeof value !== "object" || value === null) return { provider: null, accountId: null, credentialsJson: null };
  const record = value as Record<string, unknown>;
  return {
    provider: readProvider(record.provider),
    accountId: typeof record.accountId === "string" && record.accountId.trim().length > 0 ? record.accountId : null,
    credentialsJson: typeof record.credentialsJson === "string" && record.credentialsJson.trim().length > 0 ? record.credentialsJson : null,
  };
}

/** Pick the provider this run executes as: seed winner, else the configured preference, else claude. */
export function resolveAutoRotationProvider(config: Record<string, unknown>): Provider {
  const seed = parsePoolSeed(config.paperclipPoolAccount);
  if (seed.provider) return seed.provider;
  return readProvider(config.preferredProvider) ?? "claude";
}

/** Reshape an auto_rotation config for the chosen provider's sub-adapter. */
function buildSubConfig(config: Record<string, unknown>, provider: Provider): Record<string, unknown> {
  const sub = (typeof config[provider] === "object" && config[provider] !== null ? config[provider] : {}) as Record<string, unknown>;
  // Provider sub-config wins over any shared top-level keys.
  const cloned: Record<string, unknown> = { ...config, ...sub };
  // Drop the auto_rotation-only holders so the sub-adapter sees a normal config.
  delete cloned.claude;
  delete cloned.codex;
  delete cloned.preferredProvider;

  // Map the pool seed into the 2-field shape the sub-adapters expect. When a
  // provider's on-disk DEFAULT won (no decrypted blob), drop the seed entirely so
  // the sub-adapter falls back to its shared on-disk credentials.
  const seed = parsePoolSeed(config.paperclipPoolAccount);
  if (seed.accountId && seed.credentialsJson) {
    cloned.paperclipPoolAccount = { accountId: seed.accountId, credentialsJson: seed.credentialsJson };
  } else {
    delete cloned.paperclipPoolAccount;
  }
  return cloned;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const provider = resolveAutoRotationProvider(config);
  const subCtx: AdapterExecutionContext = { ...ctx, config: buildSubConfig(config, provider) };
  return provider === "codex" ? codexExecute(subCtx) : claudeExecute(subCtx);
}

/** Aggregate both providers' environment checks so operators see Claude AND Codex readiness. */
export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const [claude, codex] = await Promise.all([
    claudeTestEnvironment(ctx).catch((err) => null),
    codexTestEnvironment(ctx).catch((err) => null),
  ]);
  const checks = [
    ...(claude?.checks.map((c) => ({ ...c, code: `claude.${c.code}` })) ?? []),
    ...(codex?.checks.map((c) => ({ ...c, code: `codex.${c.code}` })) ?? []),
  ];
  // auto_rotation is usable if EITHER provider passes (the balancer routes to the
  // healthy one). Fail only when both providers fail.
  const statuses = [claude?.status, codex?.status];
  const anyPass = statuses.includes("pass");
  const anyWarn = statuses.includes("warn");
  const status: AdapterEnvironmentTestResult["status"] = anyPass ? "pass" : anyWarn ? "warn" : "fail";
  return { adapterType: "auto_rotation", status, checks, testedAt: new Date().toISOString() };
}
