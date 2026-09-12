import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { type Db, connectionGrants } from "@paperclipai/db";
import {
  AI_CONNECTION_CAPABILITIES,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";
import { secretService } from "./secrets.js";
import { decideCodexAuthMerge } from "@paperclipai/adapter-codex-local/server";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { decideGrokAuthMerge } from "@paperclipai/adapter-grok-local/server";

// Blank values intentionally override inherited credentials in CLI child environments.
export const AI_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "CODEX_HOME",
  "GROK_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_AUTH_JSON",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PAPERCLIP_OPENCODE_PROVIDERS",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "XAI_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;
export function stripAiAuthBindings(env: unknown): Record<string, unknown> {
  const result = {
    ...(env && typeof env === "object" ? (env as Record<string, unknown>) : {}),
  };
  for (const key of AI_AUTH_ENV_KEYS)
    if (
      ![
        "ANTHROPIC_BASE_URL",
        "OPENAI_BASE_URL",
        "XAI_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "PAPERCLIP_OPENCODE_PROVIDERS",
      ].includes(key)
    )
      delete result[key];
  return result;
}
export async function assertManagedAiProjectAuth(
  config: Record<string, unknown>,
  provider: AiConnectionBinding["provider"],
  target?: AdapterExecutionTarget | null,
) {
  const extraArgs = [
    ...(Array.isArray(config.extraArgs) ? config.extraArgs : []),
    ...(Array.isArray(config.args) ? config.args : []),
  ];
  if (
    extraArgs.some(
      (arg) =>
        typeof arg === "string" &&
        /^(--config|-c|--settings|--setting-sources|--api-key|--auth-token)(=|$)/.test(
          arg,
        ),
    )
  ) {
    throw unprocessable(
      "Remove authentication/configuration overrides before selecting a managed AI connection",
      { code: "ai_connection_incompatible" },
    );
  }
  const files =
    provider === "anthropic"
      ? [".claude/settings.json", ".claude/settings.local.json"]
      : provider === "openai"
        ? [".codex/config.toml"]
        : [];
  const pattern =
    "apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider[[:space:]]*=|env_key[[:space:]]*=|experimental_bearer_token|cli_auth_credentials_store";
  if (target?.kind === "remote" && files.length) {
    // Only inspect for conflicting keys; never return configuration or credential values.
    const result = await runAdapterExecutionTargetProcess(
      `ai-auth-check-${Date.now()}`,
      target,
      "sh",
      [
        "-c",
        `
directory=$1; pattern=$2; shift 2
while :; do
  for relative in "$@"; do
    file="$directory/$relative"
    if test -f "$file"; then
      grep -Eq "$pattern" "$file"
      result=$?
      if test "$result" -eq 0; then exit 42; fi
      if test "$result" -ne 1; then exit 43; fi
    fi
  done
  parent=$(dirname "$directory")
  if test "$parent" = "$directory"; then break; fi
  directory=$parent
done`,
        "ai-auth-check",
        target.remoteCwd,
        pattern,
        ...files,
      ],
      {
        cwd: target.remoteCwd,
        env: {},
        timeoutSec: 15,
        graceSec: 1,
        onLog: async () => {},
      },
    );
    if (result.exitCode !== 0)
      throw unprocessable(
        "The environment's project authentication settings must be checked before using this AI connection",
        { code: "ai_connection_incompatible" },
      );
    return;
  }
  let directory =
    typeof config.cwd === "string" ? path.resolve(config.cwd) : process.cwd();
  for (;;) {
    for (const relative of files) {
      try {
        const content = await readFile(path.join(directory, relative), "utf8");
        if (
          /apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider\s*=|env_key\s*=|experimental_bearer_token|cli_auth_credentials_store/.test(
            content,
          )
        ) {
          throw unprocessable(
            "Project authentication settings conflict with the selected AI connection",
            { code: "ai_connection_incompatible" },
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

async function acquireCredentialLease(db: Db, grantId: string) {
  const client = await db.$client.reserve();
  try {
    // A reserved client pins our connection to PgBouncer, not its backend.
    // Keep the lease in one transaction so transaction-pooling deployments
    // cannot acquire and release it on different PostgreSQL sessions.
    await client`begin`;
    await client`set local idle_in_transaction_session_timeout = 0`;
    const [result] =
      await client`select pg_try_advisory_xact_lock(hashtextextended(${`ai-runtime:${grantId}`}, 0)) as acquired`;
    if (!result.acquired)
      throw unprocessable(
        "This subscription is in use. Retry when its current execution finishes.",
        { code: "ai_connection_busy" },
      );
  } catch (error) {
    try {
      await client`rollback`;
    } finally {
      client.release();
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client`rollback`;
    } finally {
      client.release();
    }
  };
}

export async function prepareManagedAiRuntime(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string | null;
    adapterType: string;
    binding: AiConnectionBinding;
    allowUninstalledPersonal?: boolean;
    allowUninstalledShared?: boolean;
    allowLegacyValidation?: boolean;
    config: Record<string, unknown>;
  },
) {
  const configuredEnv =
    input.config.env && typeof input.config.env === "object"
      ? (input.config.env as Record<string, unknown>)
      : {};
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "XAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "PAPERCLIP_OPENCODE_PROVIDERS",
  ]) {
    if (configuredEnv[key])
      throw unprocessable(
        "The configured provider routing is incompatible with this AI connection",
        { code: "ai_connection_incompatible" },
      );
  }
  await assertManagedAiProjectAuth(input.config, input.binding.provider);
  const service = aiConnectionService(db);
  let selection = await service.select({
    ...input,
    userId: input.responsibleUserId,
    model: input.config.model,
    runnerProvider: input.config.provider,
    acpxAgent: input.config.acpxAgent,
  });
  const release =
    input.binding.method === "subscription"
      ? await acquireCredentialLease(db, selection.grant.id)
      : async () => {};
  let home: string | undefined;
  try {
    const selectedGrantId = selection.grant.id;
    selection = await service.select({
      ...input,
      userId: input.responsibleUserId,
      model: input.config.model,
      runnerProvider: input.config.provider,
      acpxAgent: input.config.acpxAgent,
    });
    if (selection.grant.id !== selectedGrantId)
      throw unprocessable(
        "The selected default changed. Retry this execution.",
      );
    const value = await service.credential(selection);
    home = await mkdtemp(
      path.join(
        os.tmpdir(),
        `paperclip-ai-${input.companyId}-${selection.grant.id}-`,
      ),
    );
    const providerHome = path.join(home, "provider");
    await mkdir(providerHome, { mode: 0o700 });
    const env: Record<string, unknown> = {
      ...stripAiAuthBindings(input.config.env),
      ...Object.fromEntries(AI_AUTH_ENV_KEYS.map((key) => [key, ""])),
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      CODEX_HOME: providerHome,
      GROK_HOME: providerHome,
      CLAUDE_CONFIG_DIR: providerHome,
    };
    const capability =
      AI_CONNECTION_CAPABILITIES[input.binding.provider].methods[
        input.binding.method
      ]!;
    const authFile = path.join(providerHome, "auth.json");
    if (input.binding.provider === "openai")
      await writeFile(
        path.join(providerHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
    const subscriptionFile =
      input.binding.method === "subscription" &&
      input.binding.provider !== "anthropic";
    if (subscriptionFile) await writeFile(authFile, value, { mode: 0o600 });
    else env[capability.envKey] = value;
    if (
      input.binding.provider === "openai" &&
      input.binding.method === "api_key"
    ) {
      env.CODEX_API_KEY = value;
      await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: value }), {
        mode: 0o600,
      });
    }
    if (input.binding.provider === "openrouter") {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: { openrouter: { options: { apiKey: value } } },
      });
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    }
    const generation = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16);
    const identity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${generation}`;
    return {
      config: {
        ...input.config,
        env,
        managedAiConnection: { ...selection.attribution, identity },
      },
      attribution: selection.attribution,
      accountName: selection.connection.name,
      accountOwnerUserId: selection.grant.subjectUserId,
      identity,
      cleanup: async () => {
        try {
          if (subscriptionFile) {
            const refreshed = await readFile(authFile, "utf8");
            if (refreshed !== value)
              await db.transaction(async (tx) => {
                const [grant] = await tx
                  .select()
                  .from(connectionGrants)
                  .where(
                    and(
                      eq(connectionGrants.id, selection.grant.id),
                      eq(connectionGrants.companyId, input.companyId),
                    ),
                  )
                  .for("update");
                // Reconnect/revocation wins over a process holding an older credential.
                if (
                  !grant ||
                  grant.status !== "active" ||
                  grant.updatedAt.getTime() !==
                    selection.grant.updatedAt.getTime()
                )
                  return;
                const current = await service.credential({
                  ...selection,
                  grant,
                });
                const destination = path.join(
                  providerHome,
                  "current-auth.json",
                );
                await writeFile(destination, current, { mode: 0o600 });
                const decision =
                  input.binding.provider === "openai"
                    ? await decideCodexAuthMerge(authFile, destination, {
                        errorLabel: "AI account refresh",
                      })
                    : await decideGrokAuthMerge(authFile, destination, {
                        errorLabel: "AI account refresh",
                      });
                if (decision !== 10) return;
                const ref = grant.credentialSecretRefs.find(
                  (r) => r.configPath === "ai.credential",
                )!;
                await secretService(tx).rotate(
                  ref.secretId,
                  { value: refreshed },
                  { userId: grant.subjectUserId },
                );
                await tx
                  .update(connectionGrants)
                  .set({ updatedAt: new Date() })
                  .where(eq(connectionGrants.id, grant.id));
              });
          }
        } finally {
          try {
            if (home) await rm(home, { recursive: true, force: true });
          } finally {
            await release();
          }
        }
      },
    };
  } catch (error) {
    try {
      if (home) await rm(home, { recursive: true, force: true });
    } finally {
      await release();
    }
    throw error;
  }
}
