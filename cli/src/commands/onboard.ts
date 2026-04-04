import * as p from "@clack/prompts";
import path from "node:path";
import pc from "picocolors";
import { t } from "../i18n/index.js";
import {
  AUTH_BASE_URL_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
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
};

type OnboardDefaults = Pick<PaperclipConfig, "database" | "logging" | "server" | "auth" | "storage" | "secrets">;

const ONBOARD_ENV_KEYS = [
  "PAPERCLIP_PUBLIC_URL",
  "DATABASE_URL",
  "PAPERCLIP_DB_BACKUP_ENABLED",
  "PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES",
  "PAPERCLIP_DB_BACKUP_RETENTION_DAYS",
  "PAPERCLIP_DB_BACKUP_DIR",
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
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

function quickstartDefaultsFromEnv(): {
  defaults: OnboardDefaults;
  usedEnvKeys: string[];
  ignoredEnvKeys: Array<{ key: string; reason: string }>;
} {
  const instanceId = resolvePaperclipInstanceId();
  const defaultStorage = defaultStorageConfig();
  const defaultSecrets = defaultSecretsConfig();
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const publicUrl =
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.BETTER_AUTH_BASE_URL?.trim() ||
    undefined;
  const deploymentMode =
    parseEnumFromEnv<DeploymentMode>(process.env.PAPERCLIP_DEPLOYMENT_MODE, DEPLOYMENT_MODES) ?? "local_trusted";
  const deploymentExposureFromEnv = parseEnumFromEnv<DeploymentExposure>(
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
    DEPLOYMENT_EXPOSURES,
  );
  const deploymentExposure =
    deploymentMode === "local_trusted" ? "private" : (deploymentExposureFromEnv ?? "private");
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
      host: process.env.HOST ?? "127.0.0.1",
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
  if (deploymentMode === "local_trusted" && process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE !== undefined) {
    ignoredEnvKeys.push({
      key: "PAPERCLIP_DEPLOYMENT_EXPOSURE",
      reason: "Ignored because deployment mode local_trusted always forces private exposure",
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
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(t("onboard.intro"))));
  const configPath = resolveConfigPath(opts.config);
  const instance = describeLocalInstancePaths(resolvePaperclipInstanceId());
  p.log.message(
    pc.dim(
      t("onboard.local_home_info", { homeDir: instance.homeDir, instanceId: instance.instanceId, configPath }),
    ),
  );

  let existingConfig: PaperclipConfig | null = null;
  if (configExists(opts.config)) {
    p.log.message(pc.dim(t("onboard.config_exists", { configPath })));

    try {
      existingConfig = readConfig(opts.config);
    } catch (err) {
      p.log.message(
        pc.yellow(
          t("onboard.config_invalid", { error: err instanceof Error ? err.message : String(err) }),
        ),
      );
    }
  }

  if (existingConfig) {
    p.log.message(
      pc.dim(t("onboard.existing_detected")),
    );
    p.log.message(pc.dim(t("onboard.use_configure", { command: pc.cyan("paperclipai configure") })));

    const jwtSecret = ensureAgentJwtSecret(configPath);
    const envFilePath = resolveAgentJwtEnvFile(configPath);
    if (jwtSecret.created) {
      p.log.success(t("onboard.jwt_created", { key: pc.cyan("PAPERCLIP_AGENT_JWT_SECRET"), path: pc.dim(envFilePath) }));
    } else if (process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()) {
      p.log.info(t("onboard.jwt_from_env", { key: pc.cyan("PAPERCLIP_AGENT_JWT_SECRET") }));
    } else {
      p.log.info(t("onboard.jwt_from_file", { key: pc.cyan("PAPERCLIP_AGENT_JWT_SECRET"), path: pc.dim(envFilePath) }));
    }

    const keyResult = ensureLocalSecretsKeyFile(existingConfig, configPath);
    if (keyResult.status === "created") {
      p.log.success(t("onboard.secrets_key_created", { path: pc.dim(keyResult.path) }));
    } else if (keyResult.status === "existing") {
      p.log.message(pc.dim(t("onboard.secrets_key_existing", { path: keyResult.path })));
    }

    p.note(
      [
        t("onboard.config_preserved"),
        t("onboard.db_label", { mode: existingConfig.database.mode }),
        existingConfig.llm ? t("onboard.llm_label", { provider: existingConfig.llm.provider }) : t("onboard.llm_not_configured"),
        t("onboard.logging_label", { mode: existingConfig.logging.mode, logDir: existingConfig.logging.logDir }),
        t("onboard.server_label", { deploymentMode: existingConfig.server.deploymentMode, exposure: existingConfig.server.exposure, host: existingConfig.server.host, port: existingConfig.server.port }),
        t("onboard.allowed_hosts_label", { hosts: existingConfig.server.allowedHostnames.length > 0 ? existingConfig.server.allowedHostnames.join(", ") : t("onboard.loopback_only") }),
        t("onboard.auth_url_mode_label", { mode: existingConfig.auth.baseUrlMode, url: existingConfig.auth.publicBaseUrl ? ` (${existingConfig.auth.publicBaseUrl})` : "" }),
        t("onboard.storage_label", { provider: existingConfig.storage.provider }),
        t("onboard.secrets_label", { provider: existingConfig.secrets.provider, strictMode: existingConfig.secrets.strictMode ? t("onboard.strict_on") : t("onboard.strict_off") }),
        t("onboard.agent_auth_configured"),
      ].join("\n"),
      t("onboard.config_ready_title"),
    );

    p.note(
      [
        t("onboard.next_run", { command: pc.cyan("paperclipai run") }),
        t("onboard.next_reconfigure", { command: pc.cyan("paperclipai configure") }),
        t("onboard.next_diagnose", { command: pc.cyan("paperclipai doctor") }),
      ].join("\n"),
      t("onboard.next_commands_title"),
    );

    let shouldRunNow = opts.run === true || opts.yes === true;
    if (!shouldRunNow && !opts.invokedByRun && process.stdin.isTTY && process.stdout.isTTY) {
      const answer = await p.confirm({
        message: t("onboard.start_now"),
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

    p.outro(t("onboard.existing_ready"));
    return;
  }

  let setupMode: SetupMode = "quickstart";
  if (opts.yes) {
    p.log.message(pc.dim(t("onboard.yes_enabled")));
  } else {
    const setupModeChoice = await p.select({
      message: t("onboard.choose_setup_path"),
      options: [
        {
          value: "quickstart" as const,
          label: t("onboard.quickstart_label"),
          hint: t("onboard.quickstart_hint"),
        },
        {
          value: "advanced" as const,
          label: t("onboard.advanced_label"),
          hint: t("onboard.advanced_hint"),
        },
      ],
      initialValue: "quickstart",
    });
    if (p.isCancel(setupModeChoice)) {
      p.cancel(t("onboard.setup_cancelled"));
      return;
    }
    setupMode = setupModeChoice as SetupMode;
  }

  const tc = getTelemetryClient();
  if (tc) trackInstallStarted(tc);

  let llm: PaperclipConfig["llm"] | undefined;
  const { defaults: derivedDefaults, usedEnvKeys, ignoredEnvKeys } = quickstartDefaultsFromEnv();
  let {
    database,
    logging,
    server,
    auth,
    storage,
    secrets,
  } = derivedDefaults;

  if (setupMode === "advanced") {
    p.log.step(pc.bold(t("onboard.step_database")));
    database = await promptDatabase(database);

    if (database.mode === "postgres" && database.connectionString) {
      const s = p.spinner();
      s.start(t("onboard.testing_db"));
      try {
        const { createDb } = await import("@paperclipai/db");
        const db = createDb(database.connectionString);
        await db.execute("SELECT 1");
        s.stop(t("onboard.db_connection_success"));
      } catch {
        s.stop(pc.yellow(t("onboard.db_connection_failed")));
      }
    }

    p.log.step(pc.bold(t("onboard.step_llm")));
    llm = await promptLlm();

    if (llm?.apiKey) {
      const s = p.spinner();
      s.start(t("onboard.validating_api_key"));
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
            s.stop(t("onboard.api_key_valid"));
          } else if (res.status === 401) {
            s.stop(pc.yellow(t("onboard.api_key_invalid")));
          } else {
            s.stop(pc.yellow(t("onboard.api_key_unknown")));
          }
        } else {
          const res = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${llm.apiKey}` },
          });
          if (res.ok) {
            s.stop(t("onboard.api_key_valid"));
          } else if (res.status === 401) {
            s.stop(pc.yellow(t("onboard.api_key_invalid")));
          } else {
            s.stop(pc.yellow(t("onboard.api_key_unknown")));
          }
        }
      } catch {
        s.stop(pc.yellow(t("onboard.api_unreachable")));
      }
    }

    p.log.step(pc.bold(t("onboard.step_logging")));
    logging = await promptLogging();

    p.log.step(pc.bold(t("onboard.step_server")));
    ({ server, auth } = await promptServer({ currentServer: server, currentAuth: auth }));

    p.log.step(pc.bold(t("onboard.step_storage")));
    storage = await promptStorage(storage);

    p.log.step(pc.bold(t("onboard.step_secrets")));
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
        t("onboard.secrets_defaults", { provider: secrets.provider, strictMode: secrets.strictMode, keyFilePath: secrets.localEncrypted.keyFilePath }),
      ),
    );
  } else {
    p.log.step(pc.bold(t("onboard.step_quickstart")));
    p.log.message(pc.dim(t("onboard.quickstart_defaults")));
    if (usedEnvKeys.length > 0) {
      p.log.message(pc.dim(t("onboard.env_aware_defaults", { count: usedEnvKeys.length })));
    } else {
      p.log.message(
        pc.dim(t("onboard.no_env_overrides")),
      );
    }
    for (const ignored of ignoredEnvKeys) {
      p.log.message(pc.dim(t("onboard.ignored_env", { key: ignored.key, reason: ignored.reason })));
    }
  }

  const jwtSecret = ensureAgentJwtSecret(configPath);
  const envFilePath = resolveAgentJwtEnvFile(configPath);
  if (jwtSecret.created) {
    p.log.success(t("onboard.jwt_created", { key: pc.cyan("PAPERCLIP_AGENT_JWT_SECRET"), path: pc.dim(envFilePath) }));
  } else if (process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()) {
    p.log.info(t("onboard.jwt_from_env", { key: pc.cyan("PAPERCLIP_AGENT_JWT_SECRET") }));
  } else {
    p.log.info(t("onboard.jwt_from_file", { key: pc.cyan("PAPERCLIP_AGENT_JWT_SECRET"), path: pc.dim(envFilePath) }));
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
    p.log.success(t("onboard.secrets_key_created", { path: pc.dim(keyResult.path) }));
  } else if (keyResult.status === "existing") {
    p.log.message(pc.dim(t("onboard.secrets_key_existing", { path: keyResult.path })));
  }

  writeConfig(config, opts.config);

  if (tc) trackInstallCompleted(tc, {
    adapterType: server.deploymentMode,
  });

  p.note(
    [
      t("onboard.db_label", { mode: database.mode }),
      llm ? t("onboard.llm_label", { provider: llm.provider }) : t("onboard.llm_not_configured"),
      t("onboard.logging_label", { mode: logging.mode, logDir: logging.logDir }),
      t("onboard.server_label", { deploymentMode: server.deploymentMode, exposure: server.exposure, host: server.host, port: server.port }),
      t("onboard.allowed_hosts_label", { hosts: server.allowedHostnames.length > 0 ? server.allowedHostnames.join(", ") : t("onboard.loopback_only") }),
      t("onboard.auth_url_mode_label", { mode: auth.baseUrlMode, url: auth.publicBaseUrl ? ` (${auth.publicBaseUrl})` : "" }),
      t("onboard.storage_label", { provider: storage.provider }),
      t("onboard.secrets_label", { provider: secrets.provider, strictMode: secrets.strictMode ? t("onboard.strict_on") : t("onboard.strict_off") }),
      t("onboard.agent_auth_configured"),
    ].join("\n"),
    t("onboard.config_saved_title"),
  );

  p.note(
    [
      t("onboard.next_run", { command: pc.cyan("paperclipai run") }),
      t("onboard.next_reconfigure", { command: pc.cyan("paperclipai configure") }),
      t("onboard.next_diagnose", { command: pc.cyan("paperclipai doctor") }),
    ].join("\n"),
    t("onboard.next_commands_title"),
  );

  if (canCreateBootstrapInviteImmediately({ database, server })) {
    p.log.step(t("onboard.generating_ceo_invite"));
    await bootstrapCeoInvite({ config: configPath });
  }

  let shouldRunNow = opts.run === true || opts.yes === true;
  if (!shouldRunNow && !opts.invokedByRun && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await p.confirm({
      message: t("onboard.start_now"),
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
        t("onboard.bootstrap_ceo_later"),
        t("onboard.next_label", { command: pc.cyan("paperclipai run") }),
        t("onboard.then_label", { command: pc.cyan("paperclipai auth bootstrap-ceo") }),
      ].join("\n"),
    );
  }

  p.outro(t("onboard.all_set"));
}
