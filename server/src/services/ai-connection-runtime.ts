import { AsyncLocalStorage } from "node:async_hooks";
import { environmentTaskResultSchema } from "@paperclipai/plugin-sdk";
import type { PluginTaskCredentialWritebackBinding } from "./plugin-task-credential-writeback.js";
import { OPENROUTER_ATTRIBUTION_HEADERS, openRouterClaudeHeaders } from "@paperclipai/shared/openrouter-attribution";
import { createHash } from "node:crypto";
import { HttpError, unprocessable } from "../errors.js";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { type Db, companySecrets, connectionGrants } from "@paperclipai/db";
import {
  AI_CONNECTION_CAPABILITIES,
  aiConnectionMetadataSchema, aiRoutingHarness,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import { managedProviderRouting } from "./ai-provider-routing.js";
import { aiConnectionService } from "./ai-connections.js";
import { subscriptionService } from "./subscriptions.js";
import { refreshSubscriptionConnection } from "./subscription-refresh.js";
import { secretService } from "./secrets.js";
import { decideCodexAuthMerge, withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { decideGrokAuthMerge } from "@paperclipai/adapter-grok-local/server";
import { NativeEnvironmentProbeCleanupError, sanitizeAntigravityCredential } from "../vendor/paperclip-runner/index.js";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";
import { prepareAntigravityCredentialWriteback } from "./native-runtime/antigravity-runner-credentials.js";
import { quotaCredentialHash, quotaCredentialRecovery, RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";
import { assertAiCredentialCleanupSettled, bindRetainedAiCredentialHome, reconcileRetainedAiCleanup, retainAiCredentialCleanup, type RetainedAiCleanupScope } from "./retained-ai-credential-cleanup.js";

export function isAiConnectionBusy(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 422 &&
    (error.details as { code?: unknown } | undefined)?.code === "ai_connection_busy";
}

// Blank values intentionally override inherited credentials in CLI child environments.
export const AI_AUTH_ENV_KEYS = [
  "COPILOT_GITHUB_TOKEN",
  "PAPERCLIP_AI_PROVIDER_KEY", "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_CODEX_PROVIDERS",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI",
  "GEMINI_HOME", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_ACCESS_TOKEN", "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET",
  "HERMES_HOME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",

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
  "PAPERCLIP_PI_PROVIDERS",
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
  if (target?.kind === "remote" && target.transport === "sandbox" && target.runnerTask && files.length) {
    const description = environmentTaskResultSchema.parse(await target.runnerTask({ kind: "describe" }));
    if (description.kind !== "description" || description.projectAuthCheckVersion !== 1) {
      throw unprocessable("The plugin environment cannot validate managed project authentication", { code: "ai_connection_incompatible" });
    }
    // The process owner checks the exact prepared configuration before it can submit credentials.
    return;
  }
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

function managedAiHomeEnvironment(home: string): Record<string, string> {
  const providerHome = path.join(home, "provider");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    CODEX_HOME: providerHome,
    GROK_HOME: providerHome,
    CLAUDE_CONFIG_DIR: providerHome,
    HERMES_HOME: providerHome,
  };
}

/** Only the server-created credential home is volatile; retain all other config. */
export function managedAiSessionFingerprintConfig(
  config: Record<string, unknown>,
  managedHome: string | undefined,
): Record<string, unknown> {
  if (!managedHome) return config;
  const env = { ...(config.env as Record<string, unknown> | undefined) };
  const stable = managedAiHomeEnvironment("<managed-ai-home>");
  for (const [key, value] of Object.entries(managedAiHomeEnvironment(managedHome))) {
    if (env[key] === value) env[key] = stable[key];
  }
  if (env.GEMINI_HOME === path.join(managedHome, "provider")) env.GEMINI_HOME = path.join("<managed-ai-home>", "provider");
  const managed = config.managedAiConnection as Record<string, unknown> | undefined;
  if (managed?.sessionIdentity) {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_AUTH_JSON", "OPENCODE_CONFIG_CONTENT"]) {
      if (env[key]) env[key] = "<managed-ai-credential>";
    }
  }
  return { ...config, env, ...(managed?.sessionIdentity ? { managedAiConnection: { ...managed, identity: managed.sessionIdentity } } : {}) };
}

const managedProbeCredentialLocks = new AsyncLocalStorage<{ companyId: string; active: boolean }>();
async function reconcileManagedCredentialCleanup(scope: RetainedAiCleanupScope): Promise<void> {
  const ownership = managedProbeCredentialLocks.getStore();
  if (ownership?.active && ownership.companyId === scope.companyId) assertAiCredentialCleanupSettled(scope);
  else await reconcileRetainedAiCleanup(scope);
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
    "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_CODEX_PROVIDERS", "PAPERCLIP_PI_PROVIDERS", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "GOOGLE_GEMINI_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
  ]) {
    if (configuredEnv[key])
      throw unprocessable(
        "The configured provider routing is incompatible with this AI connection",
        { code: "ai_connection_incompatible" },
      );
  }
  const harness = aiRoutingHarness(input.adapterType, input.config.provider, input.config.acpxAgent);
  await assertManagedAiProjectAuth(input.config, harness === "claude_local" ? "anthropic" : harness === "codex_local" ? "openai" : input.binding.provider);
  const service = aiConnectionService(db);
  let selection = await service.select({
    ...input,
    userId: input.responsibleUserId,
    model: input.config.model,
    runnerProvider: input.config.provider,
    acpxAgent: input.config.acpxAgent,
  });
  const retainedCleanupScope = { companyId: input.companyId, accountKey: selection.grant.id };
  await reconcileManagedCredentialCleanup(retainedCleanupScope);
  const subscriptionFile =
    selection.attribution.method === "subscription" &&
    input.binding.provider !== "anthropic";
  let home: string | undefined;
  let releaseCredentialHome: (() => void) | undefined;
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
    const credentialRef = selection.grant.credentialSecretRefs.find((ref) => ref.configPath === "ai.credential");
    const routing = aiConnectionMetadataSchema.parse(selection.connection.config.ai).routing;
    const noAuth = routing?.auth === "none";
    if (!noAuth && !credentialRef) throw unprocessable("The selected AI credential is unavailable");
    const readFreshness = async () => {
      if (!credentialRef) return undefined;
      const [currentGrant] = await db.select({ refs: connectionGrants.credentialSecretRefs, status: connectionGrants.status })
        .from(connectionGrants).where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.id, selection.grant.id)));
      const currentRef = currentGrant?.refs.find(ref => ref.configPath === "ai.credential");
      if (currentGrant?.status !== "active" || currentRef?.secretId !== credentialRef.secretId || currentRef.versionSelector !== credentialRef.versionSelector) return undefined;
      return (await db.select({ epoch: companySecrets.aiSessionEpoch, version: companySecrets.latestVersion })
        .from(companySecrets).where(and(eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, credentialRef.secretId))).limit(1))[0];
    };
    const { value, freshness } = await (async () => {
      if (noAuth) return { value: "", freshness: undefined };
      // Recovering a rotated quota token can advance the secret version during
      // the first read. Re-read the saved credential, retaining the epoch guard
      // against a concurrent reconnect or explicit rotation.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await readFreshness();
        const ownership = managedProbeCredentialLocks.getStore();
        const value = await service.runtimeCredential(selection,
          ownership?.active && ownership.companyId === input.companyId ? { credentialLockHeld: true } : undefined);
        const after = await readFreshness();
        if (before && after && before.version === after.version && before.epoch === after.epoch) {
          return { value, freshness: after };
        }
        if (!before || before.epoch !== after?.epoch) break;
      }
      throw unprocessable("The AI credential changed during preparation; retry this execution");
    })();
    const antigravitySubscription = harness === "antigravity_runtime" && selection.attribution.method === "subscription";
    const originalCredential = antigravitySubscription ? sanitizeAntigravityCredential(value) : value;
    home = await mkdtemp(
      path.join(
        os.tmpdir(),
        `paperclip-ai-${input.companyId}-${selection.grant.id}-`,
      ),
    );
    if (harness === "antigravity_runtime") home = await realpath(home);
    const providerHome = path.join(home, "provider");
    await mkdir(providerHome, { mode: 0o700 });
    if (retainedCleanupScope) releaseCredentialHome = bindRetainedAiCredentialHome(providerHome, retainedCleanupScope);
    const env: Record<string, unknown> = {
      ...stripAiAuthBindings(input.config.env),
      ...Object.fromEntries(AI_AUTH_ENV_KEYS.map((key) => [key, ""])),
      ...managedAiHomeEnvironment(home),
      ...(input.binding.provider === "github" ? { GH_TOKEN: "", GITHUB_TOKEN: "" } : {}),
    };
    const capability =
      AI_CONNECTION_CAPABILITIES[input.binding.provider].methods[
        selection.attribution.method
      ]!;
    const authFile = antigravitySubscription
      ? path.join(providerHome, "antigravity-acp", "acp_token.json")
      : path.join(providerHome, "auth.json");
    if (harness === "codex_local")
      await writeFile(
        path.join(providerHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
    if (!routing && subscriptionFile && !antigravitySubscription) await writeFile(authFile, value, { mode: 0o600 });
    else if (!routing && !subscriptionFile) env[capability.envKey] = value;
    if (
      !routing && input.binding.provider === "openai" && harness === "codex_local" &&
      selection.attribution.method === "api_key"
    ) {
      env.CODEX_API_KEY = value;
      await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: value }), {
        mode: 0o600,
      });
    }
    if (!routing && input.binding.provider === "openrouter" && harness === "opencode_local") {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: { openrouter: { options: { apiKey: value, headers: OPENROUTER_ATTRIBUTION_HEADERS } } },
      });
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    }
    if (!routing && input.binding.provider === "google" && harness === "gemini_local") {
      // Gemini headless CLI requires an explicit auth choice even with an API key.
      // Seed only the disposable connection home, never the operator's settings.
      const geminiHome = path.join(home, ".gemini");
      await mkdir(geminiHome, { mode: 0o700 });
      await writeFile(path.join(geminiHome, "settings.json"), JSON.stringify({
        selectedAuthType: "gemini-api-key",
        security: { auth: { selectedType: "gemini-api-key" } },
      }), { mode: 0o600 });
    }
    if (harness === "antigravity_runtime") {
      // Native Antigravity reads this explicit auth selection beneath GEMINI_HOME.
      // The selected AI connection owns this disposable home, not a browser login.
      env.GEMINI_HOME = providerHome;
      const antigravityHome = path.join(providerHome, "antigravity-acp");
      await mkdir(antigravityHome, { mode: 0o700 });
      await writeFile(path.join(antigravityHome, "settings.json"), JSON.stringify({
        auth: { type: antigravitySubscription ? "oauth-personal" : "gemini-api-key" },
      }), { mode: 0o600 });
      if (antigravitySubscription) await writeFile(authFile, originalCredential, { mode: 0o600 });
    }
    const projected = routing ? managedProviderRouting(routing, harness, value, typeof input.config.model === "string" ? input.config.model : "") : undefined;
    if (projected) {
      const customHeaders = env.ANTHROPIC_CUSTOM_HEADERS ?? process.env.ANTHROPIC_CUSTOM_HEADERS;
      Object.assign(env, projected.env);
      if (projected.env.ANTHROPIC_CUSTOM_HEADERS && customHeaders !== undefined) {
        // Preserve secret references until adapter resolution; the adapter merges
        // attribution after resolving them. Ordinary gateway headers survive too.
        env.ANTHROPIC_CUSTOM_HEADERS = typeof customHeaders === "string"
          ? openRouterClaudeHeaders(customHeaders)
          : customHeaders;
      }
      if (projected.hermesConfig) await writeFile(path.join(providerHome, "config.yaml"), projected.hermesConfig, { mode: 0o600 });
      if (projected.codexConfig) await writeFile(path.join(providerHome, "config.toml"), 'cli_auth_credentials_store = "file"\n' + projected.codexConfig, { mode: 0o600 });
    }
    const attribution = { ...selection.attribution } as typeof selection.attribution & { subscriptionId?: string };
    if (attribution.method === "subscription") {
      const subscription = {
        companyId: input.companyId, connectionId: selection.connection.id, grantId: selection.grant.id,
        provider: selection.attribution.provider, name: selection.connection.name,
        ownerUserId: selection.grant.subjectUserId, credential: value,
        session: credentialRef && freshness ? { secretId: credentialRef.secretId, epoch: freshness.epoch } : null,
      };
      attribution.subscriptionId = await subscriptionService(db).register(subscription);
      void refreshSubscriptionConnection(db, subscription, attribution.subscriptionId);
    }
    const generation = createHash("sha256")
      .update(originalCredential)
      .digest("hex")
      .slice(0, 16);
    const identity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${generation}`;
    const sessionIdentity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${noAuth ? "no-auth" : `${credentialRef!.secretId}:${freshness!.epoch}`}`;
    let homeRemoved = false;
    let ownsGoogleRecovery = false;
    let removalOnly = false;
    let deferredWriteback: { cause: unknown } | undefined;
    const removeHome = async () => {
      if (home) await rm(home, { recursive: true, force: true });
      homeRemoved = true;
      releaseCredentialHome?.();
    };
    const cleanupRuntime = async () => {
      if (homeRemoved) return;
      await reconcileManagedCredentialCleanup(retainedCleanupScope);
      if (homeRemoved) return;
      const cleanup = async () => {
        if (removalOnly) {
          await removeHome();
          if (deferredWriteback) throw new RetiredCredentialRecoveryError(deferredWriteback.cause);
          return;
        }
        let googleRecovery: ReturnType<typeof quotaCredentialRecovery> | undefined;
        let durableGoogleRefresh = false;
        try {
          if (subscriptionFile) {
            const incoming = antigravitySubscription
              ? sanitizeAntigravityCredential(await readLocalAiCredentialFile(authFile)) : undefined;
            if (antigravitySubscription && incoming !== originalCredential) {
              const accountEmail = selection.grant.providerTenant?.name;
              if (!credentialRef || !freshness || !accountEmail) throw new Error("The selected Google credential recovery authority is unavailable");
              googleRecovery = quotaCredentialRecovery(input.companyId, selection.grant.id);
              const prior = await googleRecovery.read();
              if (prior && prior.value !== incoming && !ownsGoogleRecovery) {
                // A previous retired owner keeps its first recoverable refresh.
                // Settle it before this owner can stage another generation.
                await aiConnectionService(db).runtimeCredential(selection, { credentialLockHeld: true });
              }
              // Physical retirement is the caller's cleanup precondition. Save
              // before network verification or a database write can fail; only
              // this exact grant generation may later consume the encrypted copy.
              await googleRecovery.write({ companyId: input.companyId, grantId: selection.grant.id,
                connectionId: selection.connection.id, secretId: credentialRef.secretId,
                baseHash: quotaCredentialHash(value), value: incoming!, provider: "google",
                google: { sessionEpoch: freshness.epoch, baseVersion: freshness.version,
                  versionSelector: credentialRef.versionSelector ?? "latest", accountEmail, verified: false } });
              ownsGoogleRecovery = true;
            }
            // Verification itself can consume a rotating refresh. Until its
            // newest result is durably journaled, the private home owns it.
            durableGoogleRefresh = false;
            const refreshed = antigravitySubscription
              ? await prepareAntigravityCredentialWriteback({ originalCredential,
                  refreshedCredential: incoming!, managedHome: providerHome,
                  accountEmail: selection.grant.providerTenant?.name,
                })
              : await readFile(authFile, "utf8");
            if (googleRecovery) {
              const pending = await googleRecovery.read();
              if (!pending?.google) throw new Error("The Google credential recovery journal is unavailable");
              await googleRecovery.write({ ...pending, value: refreshed, google: { ...pending.google, verified: true } });
              durableGoogleRefresh = true;
            }
            if (refreshed !== originalCredential) {
              // A quota exchange can hold this company lock for 60 seconds.
              // Retry its 30-second acquisition timeout without discarding the
              // provider's only copy of a rotated, single-use refresh token.
              const writeBack = () => withAccountHomeSecretMutationLock(undefined, input.companyId, () => db.transaction(async (tx) => {
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
                // A missing or revoked grant blocks the write-back. Among
                // active copies, the merge decision below keeps the
                // credential with the newest provider freshness field.
                if (!grant || grant.status !== "active") return;
                const ref = grant.credentialSecretRefs.find(
                  (r) => r.configPath === "ai.credential",
                );
                if (!ref) return;
                if (antigravitySubscription && (!credentialRef || ref.secretId !== credentialRef.secretId
                  || ref.versionSelector !== credentialRef.versionSelector
                  || grant.providerTenant?.name?.toLowerCase() !== selection.grant.providerTenant?.name?.toLowerCase())) return;
                // Lock the referenced secret row for the rest of this
                // transaction. The grant-row lock above does not cover it,
                // so an authorized rotation of this secret could otherwise
                // land between the read and the write below and be
                // overwritten by this stale write-back.
                const [currentSecret] = await tx
                  .select({ id: companySecrets.id, epoch: companySecrets.aiSessionEpoch, version: companySecrets.latestVersion })
                  .from(companySecrets)
                  .where(
                    and(
                      eq(companySecrets.id, ref.secretId),
                      eq(companySecrets.companyId, input.companyId),
                    ),
                  )
                  .for("update");
                if (antigravitySubscription && (!freshness || !currentSecret || currentSecret.epoch !== freshness.epoch
                  || currentSecret.version !== freshness.version)) return;
                const current = await aiConnectionService(
                  tx as unknown as Db,
                ).credential({ ...selection, grant });
                if (antigravitySubscription) {
                  // Google refresh tokens have no provider freshness counter. Only
                  // the exact selected generation may replace itself; a reconnect,
                  // rotation, grant remap or concurrent refresh wins over this run.
                  if (sanitizeAntigravityCredential(current) !== originalCredential) return;
                  await secretService(tx).rotate(ref.secretId,
                    { value: refreshed, preserveAiSessionEpoch: true }, { userId: grant.subjectUserId });
                  return;
                }
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
                await secretService(tx).rotate(
                  ref.secretId,
                  { value: refreshed, preserveAiSessionEpoch: true },
                  { userId: grant.subjectUserId },
                );
                // Keep grant.updatedAt for explicit account/access changes.
                // The rotated secret revision invalidates quota caches without
                // rejecting an otherwise valid in-flight reconnect.
              }));
              for (let attempt = 0; ; attempt++) {
                try { await writeBack(); break; }
                catch (error) {
                  if (attempt >= 2 || (error as NodeJS.ErrnoException)?.code !== WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) throw error;
                }
              }
            }
          }
          await googleRecovery?.clear();
          // A committed save, intentional generation discard, or encrypted
          // recovery handoff must own the refresh before deleting its home.
          removalOnly = true;
          await removeHome();
        } catch (error) {
          if (!durableGoogleRefresh && !removalOnly) throw error;
          // Once native retirement and encrypted fsync transfer ownership, the
          // original controller/home is unnecessary for next-use recovery.
          if (!removalOnly) {
            removalOnly = true;
            deferredWriteback = { cause: error };
          }
          await removeHome();
          if (deferredWriteback) throw new RetiredCredentialRecoveryError(deferredWriteback.cause);
        }
      };
      // Journal writes and generation checks share the same reconnect fence.
      try {
        return await (antigravitySubscription
          ? withAccountHomeSecretMutationLock(undefined, input.companyId, cleanup) : cleanup());
      } catch (error) {
        if (retainedCleanupScope && !homeRemoved) retainAiCredentialCleanup({ scope: retainedCleanupScope, cleanup: cleanupRuntime });
        throw error;
      }
    };
    return {
      sessionIdentity,
      ...(retainedCleanupScope ? { retainedCleanupScope } : {}),
      ...(subscriptionFile && input.binding.provider === "openai" && credentialRef && freshness ? {
        credentialWriteback: { grantId: selection.grant.id, secretId: credentialRef.secretId, sessionEpoch: freshness.epoch,
          versionSelector: credentialRef.versionSelector ?? "latest" } satisfies PluginTaskCredentialWritebackBinding,
      } : {}),
      config: {
        ...input.config,
        ...projected?.config,
        ...(routing ? { managedAiRouting: routing } : {}),
        env,
        managedAiConnection: { ...attribution, identity, sessionIdentity },
      },
      attribution,
      accountName: selection.connection.name,
      accountOwnerUserId: selection.grant.subjectUserId,
      identity,
      home,
      cleanup: cleanupRuntime,
    };
  } catch (error) {
    if (home) await rm(home, { recursive: true, force: true });
    releaseCredentialHome?.();
    throw error;
  }
}

/** Manual tests/adoption have no heartbeat row for quota's active-run guard.
 * Hold the shared credential lock from resolution through the provider probe
 * and write-back. Nested credential writes reuse this lock's async ownership. */
export async function withManagedAiProbe<T>(
  db: Db,
  input: Parameters<typeof prepareManagedAiRuntime>[1],
  probe: (runtime: Awaited<ReturnType<typeof prepareManagedAiRuntime>>) => Promise<T>,
): Promise<T> {
  const run = async () => {
    const runtime = await prepareManagedAiRuntime(db, input);
    let retained = false;
    try {
      assertAiCredentialCleanupSettled(runtime.retainedCleanupScope!);
      return await probe(runtime);
    }
    catch (error) {
      if (error instanceof NativeEnvironmentProbeCleanupError) {
        // Keep the selected credential generation until the native owner has
        // retired and completed its refresh handoff. HTTP need not wait for it.
        retained = true;
        const retryCleanup = (error as { retryCleanup?: () => Promise<void> }).retryCleanup;
        retainAiCredentialCleanup({ scope: runtime.retainedCleanupScope!, cleanup: runtime.cleanup, retired: error.retired,
          ...(typeof retryCleanup === "function" ? { retryRetirement: () => retryCleanup.call(error) } : {}) });
        throw unprocessable("The native account test is still cleaning up. Retry after runtime cleanup completes.", { code: "native_probe_cleanup_pending" });
      }
      throw error;
    } finally {
      if (!retained) {
        try { await runtime.cleanup(); }
        catch (error) {
          if (runtime.retainedCleanupScope && !(error instanceof RetiredCredentialRecoveryError)) {
            retainAiCredentialCleanup({ scope: runtime.retainedCleanupScope, cleanup: runtime.cleanup });
          }
          throw error;
        }
      }
    }
  };
  if (input.binding.provider !== "openai") return run();
  // A retirement callback may need the company lock. Join it before taking
  // the probe's outer lock; preparation rechecks this scope synchronously.
  const selected = await aiConnectionService(db).select({ ...input, userId: input.responsibleUserId,
    model: input.config.model, runnerProvider: input.config.provider, acpxAgent: input.config.acpxAgent });
  await reconcileRetainedAiCleanup({ companyId: input.companyId, accountKey: selected.grant.id });
  return withAccountHomeSecretMutationLock(undefined, input.companyId, async () => {
    const ownership = { companyId: input.companyId, active: true };
    try { return await managedProbeCredentialLocks.run(ownership, run); }
    finally { ownership.active = false; }
  }).catch(error => {
    if ((error as NodeJS.ErrnoException)?.code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) {
      throw unprocessable("AI credentials are being updated. Retry shortly.", { code: "ai_connection_busy" });
    }
    throw error;
  });
}
