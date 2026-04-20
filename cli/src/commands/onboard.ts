import * as p from "@clack/prompts";
import path from "node:path";
import pc from "picocolors";
import {
  AUTH_BASE_URL_MODES,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  inferBindModeFromHost,
  resolveRuntimeBind,
  type BindMode,
  type AuthBaseUrlMode,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
} from "@paperclipai/shared";
import { configExists, readConfig, resolveConfigPath, writeConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";
import { ensureAgentJwtSecret, resolveAgentJwtEnvFile } from "../config/env.js";
import { ensureLocalSecretsKeyFile } from "../config/secrets-key.js";
import { promptDatabase } from "../prompts/database.js";
import { promptLlm } from "../prompts/llm.js";
import { promptLogging } from "../prompts/logging.js";
import { defaultSecretsConfig } from "../prompts/secrets.js";
import { defaultStorageConfig, promptStorage } from "../prompts/storage.js";
import { promptServer } from "../prompts/server.js";
import { buildPresetServerConfig } from "../config/server-bind.js";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import {
  getTelemetryClient,
  trackInstallStarted,
  trackInstallCompleted,
} from "../telemetry.js";

type SetupMode = "quickstart" | "advanced";

type OnboardOptions = {
  config?: string;
  run?: boolean;
  yes?: boolean;
  invokedByRun?: boolean;
  bind?: BindMode;
};

type OnboardDefaults = Pick<PaperclipConfig, "database" | "logging" | "server" | "auth" | "storage" | "secrets">;

const TAILNET_BIND_WARNING =
  "No Tailscale address was detected during setup. The saved config will stay on loopback until Tailscale is available or PAPERCLIP_TAILNET_BIND_HOST is set.";

const ONBOARD_ENV_KEYS = [
  "PAPERCLIP_PUBLIC_URL",
  "DATABASE_URL",
  "PAPERCLIP_DB_BACKUP_ENABLED",
  "PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES",
  "PAPERCLIP_DB_BACKUP_RETENTION_DAYS",
  "PAPERCLIP_DB_BACKUP_DIR",
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "PAPERCLIP_BIND",
  "PAPERCLIP_BIND_HOST",
  "PAPERCLIP_TAILNET_BIND_HOST",
  "HOST",
  "PORT",
  "SERVE_UI",
  "PAPERCLIP_ALLOWED_HOSTNAMES",
  "PAPERCLIP_AUTH_BASE_URL_MODE",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "PAPERCLIP_STORAGE_PROVIDER",
  "PAPERCLIP_STORAGE_LOCAL_DIR",
  "PAPERCLIP_STORAGE_S3_BUCKET",
  "PAPERCLIP_STORAGE_S3_REGION",
  "PAPERCLIP_STORAGE_S3_ENDPOINT",
  "PAPERCLIP_STORAGE_S3_PREFIX",
  "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
  "PAPERCLIP_SECRETS_PROVIDER",
  "PAPERCLIP_SECRETS_STRICT_MODE",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
] as const;

function parseBooleanFromEnv(rawValue: string | undefined): boolean | null {
  if (rawValue === undefined) return null;
  const lower = rawValue.trim().toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return null;
}

function parseNumberFromEnv(rawValue: string | undefined): number | null {
  if (!rawValue) return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseEnumFromEnv<T extends string>(rawValue: string | undefined, allowedValues: readonly T[]): T | null {
  if (!rawValue) return null;
  return allowedValues.includes(rawValue as T) ? (rawValue as T) : null;
}

function resolvePathFromEnv(rawValue: string | undefined): string | null {
  if (!rawValue || rawValue.trim().length === 0) return null;
  return path.resolve(expandHomePrefix(rawValue.trim()));
}

function describeServerBinding(server: Pick<PaperclipConfig["server"], "bind" | "customBindHost" | "host" | "port">): string {
  const bind = server.bind ?? inferBindModeFromHost(server.host);
  const detail =
    bind === "custom"
      ? server.customBindHost ?? server.host
      : bind === "tailnet"
        ? "detected tailscale address"
        : server.host;
  return `${bind}${detail ? ` (${detail})` : ""}:${server.port}`;
}

function quickstartDefaultsFromEnv(opts?: { preferTrustedLocal?: boolean }): {
  defaults: OnboardDefaults;
  usedEnvKeys: string[];
  ignoredEnvKeys: Array<{ key: string; reason: string }>;
} {
  const preferTrustedLocal = opts?.preferTrustedLocal ?? false;
  const instanceId = resolvePaperclipInstanceId();
  const defaultStorage = defaultStorageConfig();
  const defaultSecrets = defaultSecretsConfig();
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const publicUrl = preferTrustedLocal
    ? undefined
    : (
      process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
      process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
      process.env.BETTER_AUTH_URL?.trim() ||
      process.env.BETTER_AUTH_BASE_URL?.trim() ||
      undefined
    );
  const deploymentMode = preferTrustedLocal
    ? "local_trusted"
    : (parseEnumFromEnv<DeploymentMode>(process.env.PAPERCLIP_DEPLOYMENT_MODE, DEPLOYMENT_MODES) ?? "local_trusted");
  const deploymentExposureFromEnv = parseEnumFromEnv<DeploymentExposure>(
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
    DEPLOYMENT_EXPOSURES,
  );
  const deploymentExposure =
    deploymentMode === "local_trusted" ? "private" : (deploymentExposureFromEnv ?? "private");
  const bindFromEnv = parseEnumFromEnv<BindMode>(process.env.PAPERCLIP_BIND, BIND_MODES);
  const customBindHostFromEnv = process.env.PAPERCLIP_BIND_HOST?.trim() || undefined;
  const hostFromEnv = process.env.HOST?.trim() || undefined;
  const configuredBindHost = customBindHostFromEnv ?? hostFromEnv;
  const bind = preferTrustedLocal
    ? "loopback"
    : (
      deploymentMode === "local_trusted"
        ? "loopback"
        : (bindFromEnv ?? (configuredBindHost ? inferBindModeFromHost(configuredBindHost) : "lan"))
    );
  const resolvedBind = resolveRuntimeBind({
    bind,
    host: hostFromEnv ?? (bind === "loopback" ? "127.0.0.1" : "0.0.0.0"),
    customBindHost: customBindHostFromEnv,
    tailnetBindHost: process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim(),
  });
  const authPublicBaseUrl = publicUrl;
  const authBaseUrlModeFromEnv = parseEnumFromEnv<AuthBaseUrlMode>(
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE,
    AUTH_BASE_URL_MODES,
  );
  const authBaseUrlMode = authBaseUrlModeFromEnv ?? (authPublicBaseUrl ? "explicit" : "auto");
  const allowedHostnamesFromEnv = process.env.PAPERCLIP_ALLOWED_HOSTNAMES
    ? process.env.PAPERCLIP_ALLOWED_HOSTNAMES
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : [];
  const hostnameFromPublicUrl = publicUrl
    ? (() => {
      try {
        return new URL(publicUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const storageProvider =
    parseEnumFromEnv<StorageProvider>(process.env.PAPERCLIP_STORAGE_PROVIDER, STORAGE_PROVIDERS) ??
    defaultStorage.provider;
  const secretsProvider =
    parseEnumFromEnv<SecretProvider>(process.env.PAPERCLIP_SECRETS_PROVIDER, SECRET_PROVIDERS) ??
    defaultSecrets.provider;
  const databaseBackupEnabled = parseBooleanFromEnv(process.env.PAPERCLIP_DB_BACKUP_ENABLED) ?? true;
  const databaseBackupIntervalMinutes = Math.max(
    1,
    parseNumberFromEnv(process.env.PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES) ?? 60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    parseNumberFromEnv(process.env.PAPERCLIP_DB_BACKUP_RETENTION_DAYS) ?? 30,
  );
  const defaults: OnboardDefaults = {
    database: {
      mode: databaseUrl ? "postgres" : "embedded-postgres",
      ...(databaseUrl ? { connectionString: databaseUrl } : {}),
      embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(instanceId),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: databaseBackupEnabled,
        intervalMinutes: databaseBackupIntervalMinutes,
        retentionDays: databaseBackupRetentionDays,
        dir: resolvePathFromEnv(process.env.PAPERCLIP_DB_BACKUP_DIR) ?? resolveDefaultBackupDir(instanceId),
      },
    },
    logging: {
      mode: "file",
      logDir: resolveDefaultLogsDir(instanceId),
    },
    server: {
      deploymentMode,
      exposure: deploymentExposure,
      bind: resolvedBind.bind,
      ...(resolvedBind.customBindHost ? { customBindHost: resolvedBind.customBindHost } : {}),
      host: resolvedBind.host,
      port: Number(process.env.PORT) || 3100,
      allowedHostnames: Array.from(new Set([...allowedHostnamesFromEnv, ...(hostnameFromPublicUrl ? [hostnameFromPublicUrl] : [])])),
      serveUi: parseBooleanFromEnv(process.env.SERVE_UI) ?? true,
    },
    auth: {
      baseUrlMode: authBaseUrlMode,
      disableSignUp: false,
      ...(authPublicBaseUrl ? { publicBaseUrl: authPublicBaseUrl } : {}),
    },
    storage: {
      provider: storageProvider,
      localDisk: {
        baseDir:
          resolvePathFromEnv(process.env.PAPERCLIP_STORAGE_LOCAL_DIR) ?? defaultStorage.localDisk.baseDir,
      },
      s3: {
        bucket: process.env.PAPERCLIP_STORAGE_S3_BUCKET ?? defaultStorage.s3.bucket,
        region: process.env.PAPERCLIP_STORAGE_S3_REGION ?? defaultStorage.s3.region,
        endpoint: process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ?? defaultStorage.s3.endpoint,
        prefix: process.env.PAPERCLIP_STORAGE_S3_PREFIX ?? defaultStorage.s3.prefix,
        forcePathStyle:
          parseBooleanFromEnv(process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE) ??
          defaultStorage.s3.forcePathStyle,
      },
    },
    secrets: {
      provider: secretsProvider,
      strictMode: parseBooleanFromEnv(process.env.PAPERCLIP_SECRETS_STRICT_MODE) ?? defaultSecrets.strictMode,
      localEncrypted: {
        keyFilePath:
          resolvePathFromEnv(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE) ??
          defaultSecrets.localEncrypted.keyFilePath,
      },
    },
  };
  const ignoredEnvKeys: Array<{ key: string; reason: string }> = [];
  if (preferTrustedLocal) {
    const forcedLocalReason = "Ignored because --yes quickstart forces trusted local loopback defaults";
    for (const key of [
      "PAPERCLIP_DEPLOYMENT_MODE",
      "PAPERCLIP_DEPLOYMENT_EXPOSURE",
      "PAPERCLIP_BIND",
      "PAPERCLIP_BIND_HOST",
      "HOST",
      "PAPERCLIP_AUTH_BASE_URL_MODE",
      "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
      "PAPERCLIP_PUBLIC_URL",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_BASE_URL",
    ] as const) {
      if (process.env[key] !== undefined) {
        ignoredEnvKeys.push({ key, reason: forcedLocalReason });
      }
    }
  }
  if (deploymentMode === "local_trusted" && process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE !== undefined) {
    ignoredEnvKeys.push({
      key: "PAPERCLIP_DEPLOYMENT_EXPOSURE",
      reason: "Ignored because deployment mode local_trusted always forces private exposure",
    });
  }
  if (deploymentMode === "local_trusted" && process.env.PAPERCLIP_BIND !== undefined) {
    ignoredEnvKeys.push({
      key: "PAPERCLIP_BIND",
      reason: "Ignored because deployment mode local_trusted always uses loopback reachability",
    });
  }
  if (deploymentMode === "local_trusted" && process.env.PAPERCLIP_BIND_HOST !== undefined) {
    ignoredEnvKeys.push({
      key: "PAPERCLIP_BIND_HOST",
      reason: "Ignored because deployment mode local_trusted always uses loopback reachability",
    });
  }
  if (deploymentMode === "local_trusted" && process.env.HOST !== undefined) {
    ignoredEnvKeys.push({
      key: "HOST",
      reason: "Ignored because deployment mode local_trusted always uses loopback reachability",
    });
  }

  const ignoredKeySet = new Set(ignoredEnvKeys.map((entry) => entry.key));
  const usedEnvKeys = ONBOARD_ENV_KEYS.filter(
    (key) => process.env[key] !== undefined && !ignoredKeySet.has(key),
  );
  return { defaults, usedEnvKeys, ignoredEnvKeys };
}

function canCreateBootstrapInviteImmediately(config: Pick<PaperclipConfig, "database" | "server">): boolean {
  return config.server.deploymentMode === "authenticated" && config.database.mode !== "embedded-postgres";
}

export async function onboard(opts: OnboardOptions): Promise<void> {
  if (opts.bind && !["loopback", "lan", "tailnet"].includes(opts.bind)) {
    throw new Error(`Unsupported bind preset for onboard: ${opts.bind}. Use loopback, lan, or tailnet.`);
  }

  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclipai onboard ")));
  const configPath = resolveConfigPath(opts.config);
  const instance = describeLocalInstancePaths(resolvePaperclipInstanceId());
  p.log.message(
    pc.dim(
      `Local home: ${instance.homeDir} | instance: ${instance.instanceId} | config: ${configPath}`,
    ),
  );

  let existingConfig: PaperclipConfig | null = null;
  if (configExists(opts.config)) {
    p.log.message(pc.dim(`${configPath} exists`));

    try {
      existingConfig = readConfig(opts.config);
    } catch (err) {
      p.log.message(
        pc.yellow(
          `Existing config appears invalid and will be updated.\n${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  if (existingConfig) {
    p.log.message(
      pc.dim("Existing Paperclip install detected; keeping the current configuration unchanged."),
    );
    p.log.message(pc.dim(`Use ${pc.cyan("paperclipai configure")} if you want to change settings.`));

    const jwtSecret = ensureAgentJwtSecret(configPath);
    const envFilePath = resolveAgentJwtEnvFile(configPath);
    if (jwtSecret.created) {
      p.log.success(`Created ${pc.cyan("PAPERCLIP_AGENT_JWT_SECRET")} in ${pc.dim(envFilePath)}`);
    } else if (process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()) {
      p.log.info(`Using existing ${pc.cyan("PAPERCLIP_AGENT_JWT_SECRET")} from environment`);
    } else {
      p.log.info(`Using existing ${pc.cyan("PAPERCLIP_AGENT_JWT_SECRET")} in ${pc.dim(envFilePath)}`);
    }

    const keyResult = ensureLocalSecretsKeyFile(existingConfig, configPath);
    if (keyResult.status === "created") {
      p.log.success(`Created local secrets key file at ${pc.dim(keyResult.path)}`);
    } else if (keyResult.status === "existing") {
      p.log.message(pc.dim(`Using existing local secrets key file at ${keyResult.path}`));
    }

    p.note(
      [
        "Existing config preserved",
        `Database: ${existingConfig.database.mode}`,
        existingConfig.llm ? `LLM: ${existingConfig.llm.provider}` : "LLM: not configured",
        `Logging: ${existingConfig.logging.mode} -> ${existingConfig.logging.logDir}`,
        `Server: ${existingConfig.server.deploymentMode}/${existingConfig.server.exposure} @ ${describeServerBinding(existingConfig.server)}`,
        `Allowed hosts: ${existingConfig.server.allowedHostnames.length > 0 ? existingConfig.server.allowedHostnames.join(", ") : "(loopback only)"}`,
        `Auth URL mode: ${existingConfig.auth.baseUrlMode}${existingConfig.auth.publicBaseUrl ? ` (${existingConfig.auth.publicBaseUrl})` : ""}`,
        `Storage: ${existingConfig.storage.provider}`,
        `Secrets: ${existingConfig.secrets.provider} (strict mode ${existingConfig.secrets.strictMode ? "on" : "off"})`,
        "Agent auth: PAPERCLIP_AGENT_JWT_SECRET configured",
      ].join("\n"),
      "Configuration ready",
    );

    p.note(
      [
        `Run: ${pc.cyan("paperclipai run")}`,
        `Reconfigure later: ${pc.cyan("paperclipai configure")}`,
        `Diagnose setup: ${pc.cyan("paperclipai doctor")}`,
      ].join("\n"),
      "Next commands",
    );

    let shouldRunNow = opts.run === true || opts.yes === true;
    if (!shouldRunNow && !opts.invokedByRun && process.stdin.isTTY && process.stdout.isTTY) {
      const answer = await p.confirm({
        message: "Start Paperclip now?",
        initialValue: true,
      });
      if (!p.isCancel(answer)) {
        shouldRunNow = answer;
      }
    }

    if (shouldRunNow && !opts.invokedByRun) {
      process.env.PAPERCLIP_OPEN_ON_LISTEN = "true";
      const { runCommand } = await import("./run.js");
      await runCommand({ config: configPath, repair: true, yes: true });
      return;
    }

    p.outro("Existing Paperclip setup is ready.");
    return;
  }

  let setupMode: SetupMode = "quickstart";
  if (opts.yes) {
    p.log.message(
      pc.dim(
        opts.bind
          ? `\`--yes\` enabled: using Quickstart defaults with bind=${opts.bind}.`
          : "`--yes` enabled: using Quickstart defaults.",
      ),
    );
  } else {
    const setupModeChoice = await p.select({
      message: "Choose setup path",
      options: [
        {
          value: "quickstart" as const,
          label: "Quickstart",
          hint: "Recommended: local defaults + ready to run",
        },
        {
          value: "advanced" as const,
          label: "Advanced setup",
          hint: "Customize database, server, storage, and more",
        },
      ],
      initialValue: "quickstart",
    });
    if (p.isCancel(setupModeChoice)) {
      p.cancel("Setup cancelled.");
      return;
    }
    setupMode = setupModeChoice as SetupMode;
  }

  const tc = getTelemetryClient();
  if (tc) trackInstallStarted(tc);

  let llm: PaperclipConfig["llm"] | undefined;
  const { defaults: derivedDefaults, usedEnvKeys, ignoredEnvKeys } = quickstartDefaultsFromEnv({
    preferTrustedLocal: opts.yes === true && !opts.bind,
  });
  let {
    database,
    logging,
    server,
    auth,
    storage,
    secrets,
  } = derivedDefaults;

  if (opts.bind === "loopback" || opts.bind === "lan" || opts.bind === "tailnet") {
    const preset = buildPresetServerConfig(opts.bind, {
      port: server.port,
      allowedHostnames: server.allowedHostnames,
      serveUi: server.serveUi,
    });
    server = preset.server;
    auth = preset.auth;
    if (opts.bind === "tailnet" && server.host === "127.0.0.1") {
      p.log.warn(TAILNET_BIND_WARNING);
    }
  }

  if (setupMode === "advanced") {
    p.log.step(pc.bold("Database"));
    database = await promptDatabase(database);

    if (database.mode === "postgres" && database.connectionString) {
      const s = p.spinner();
      s.start("Testing database connection...");
      try {
        const { createDb } = await import("@paperclipai/db");
        const db = createDb(database.connectionString);
        await db.execute("SELECT 1");
        s.stop("Database connection successful");
      } catch {
        s.stop(pc.yellow("Could not connect to database — you can fix this later with `paperclipai doctor`"));
      }
    }

    p.log.step(pc.bold("LLM Provider"));
    llm = await promptLlm();

    if (llm?.apiKey) {
      const s = p.spinner();
      s.start("Validating API key...");
      try {
        if (llm.provider === "claude") {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": llm.apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-5-20250929",
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          if (res.ok || res.status === 400) {
            s.stop("API key is valid");
          } else if (res.status === 401) {
            s.stop(pc.yellow("API key appears invalid — you can update it later"));
          } else {
            s.stop(pc.yellow("Could not validate API key — continuing anyway"));
          }
        } else {
          const res = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${llm.apiKey}` },
          });
          if (res.ok) {
            s.stop("API key is valid");
          } else if (res.status === 401) {
            s.stop(pc.yellow("API key appears invalid — you can update it later"));
          } else {
            s.stop(pc.yellow("Could not validate API key — continuing anyway"));
          }
        }
      } catch {
        s.stop(pc.yellow("Could not reach API — continuing anyway"));
      }
    }

    p.log.step(pc.bold("Logging"));
    logging = await promptLogging();

    p.log.step(pc.bold("Server"));
    ({ server, auth } = await promptServer({ currentServer: server, currentAuth: auth }));

    p.log.step(pc.bold("Storage"));
    storage = await promptStorage(storage);

    p.log.step(pc.bold("Secrets"));
    const secretsDefaults = defaultSecretsConfig();
    secrets = {
      provider: secrets.provider ?? secretsDefaults.provider,
      strictMode: secrets.strictMode ?? secretsDefaults.strictMode,
      localEncrypted: {
        keyFilePath: secrets.localEncrypted?.keyFilePath ?? secretsDefaults.localEncrypted.keyFilePath,
      },
    };
    p.log.message(
      pc.dim(
        `Using defaults: provider=${secrets.provider}, strictMode=${secrets.strictMode}, keyFile=${secrets.localEncrypted.keyFilePath}`,
      ),
    );
  } else {
    p.log.step(pc.bold("Quickstart"));
    p.log.message(
      pc.dim(
        opts.bind
          ? `Using quickstart defaults with bind=${opts.bind}.`
          : `Using quickstart defaults: ${server.deploymentMode}/${server.exposure} @ ${describeServerBinding(server)}.`,
      ),
    );
    if (usedEnvKeys.length > 0) {
      p.log.message(pc.dim(`Environment-aware defaults active (${usedEnvKeys.length} env var(s) detected).`));
    } else {
      p.log.message(
        pc.dim("No environment overrides detected: embedded database, file storage, local encrypted secrets."),
      );
    }
    for (const ignored of ignoredEnvKeys) {
      p.log.message(pc.dim(`Ignored ${ignored.key}: ${ignored.reason}`));
    }
  }

  const jwtSecret = ensureAgentJwtSecret(configPath);
  const envFilePath = resolveAgentJwtEnvFile(configPath);
  if (jwtSecret.created) {
    p.log.success(`Created ${pc.cyan("PAPERCLIP_AGENT_JWT_SECRET")} in ${pc.dim(envFilePath)}`);
  } else if (process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()) {
    p.log.info(`Using existing ${pc.cyan("PAPERCLIP_AGENT_JWT_SECRET")} from environment`);
  } else {
    p.log.info(`Using existing ${pc.cyan("PAPERCLIP_AGENT_JWT_SECRET")} in ${pc.dim(envFilePath)}`);
  }

  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    ...(llm && { llm }),
    database,
    logging,
    server,
    auth,
    telemetry: {
      enabled: true,
    },
    storage,
    secrets,
  };

  const keyResult = ensureLocalSecretsKeyFile(config, configPath);
  if (keyResult.status === "created") {
    p.log.success(`Created local secrets key file at ${pc.dim(keyResult.path)}`);
  } else if (keyResult.status === "existing") {
    p.log.message(pc.dim(`Using existing local secrets key file at ${keyResult.path}`));
  }

  writeConfig(config, opts.config);

  if (tc) trackInstallCompleted(tc, {
    adapterType: server.deploymentMode,
  });

  p.note(
    [
      `Database: ${database.mode}`,
      llm ? `LLM: ${llm.provider}` : "LLM: not configured",
      `Logging: ${logging.mode} -> ${logging.logDir}`,
      `Server: ${server.deploymentMode}/${server.exposure} @ ${describeServerBinding(server)}`,
      `Allowed hosts: ${server.allowedHostnames.length > 0 ? server.allowedHostnames.join(", ") : "(loopback only)"}`,
      `Auth URL mode: ${auth.baseUrlMode}${auth.publicBaseUrl ? ` (${auth.publicBaseUrl})` : ""}`,
      `Storage: ${storage.provider}`,
      `Secrets: ${secrets.provider} (strict mode ${secrets.strictMode ? "on" : "off"})`,
      "Agent auth: PAPERCLIP_AGENT_JWT_SECRET configured",
    ].join("\n"),
    "Configuration saved",
  );

  p.note(
    [
      `Run: ${pc.cyan("paperclipai run")}`,
      `Reconfigure later: ${pc.cyan("paperclipai configure")}`,
      `Diagnose setup: ${pc.cyan("paperclipai doctor")}`,
    ].join("\n"),
    "Next commands",
  );

  if (canCreateBootstrapInviteImmediately({ database, server })) {
    p.log.step("Generating bootstrap CEO invite");
    await bootstrapCeoInvite({ config: configPath });
  }

  let shouldRunNow = opts.run === true || opts.yes === true;
  if (!shouldRunNow && !opts.invokedByRun && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await p.confirm({
      message: "Start Paperclip now?",
      initialValue: true,
    });
    if (!p.isCancel(answer)) {
      shouldRunNow = answer;
    }
  }

  if (shouldRunNow && !opts.invokedByRun) {
    process.env.PAPERCLIP_OPEN_ON_LISTEN = "true";
    const { runCommand } = await import("./run.js");
    await runCommand({ config: configPath, repair: true, yes: true });
    return;
  }

  if (server.deploymentMode === "authenticated" && database.mode === "embedded-postgres") {
    p.log.info(
      [
        "Bootstrap CEO invite will be created after the server starts.",
        `Next: ${pc.cyan("paperclipai run")}`,
        `Then: ${pc.cyan("paperclipai auth bootstrap-ceo")}`,
      ].join("\n"),
    );
  }

  p.outro("You're all set!");
}
