import * as p from "@clack/prompts";
import { t } from "../i18n/index.js";
import type { DatabaseConfig } from "../config/schema.js";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

export async function promptDatabase(current?: DatabaseConfig): Promise<DatabaseConfig> {
  const instanceId = resolvePaperclipInstanceId();
  const defaultEmbeddedDir = resolveDefaultEmbeddedPostgresDir(instanceId);
  const defaultBackupDir = resolveDefaultBackupDir(instanceId);
  const base: DatabaseConfig = current ?? {
    mode: "embedded-postgres",
    embeddedPostgresDataDir: defaultEmbeddedDir,
    embeddedPostgresPort: 54329,
    backup: {
      enabled: true,
      intervalMinutes: 60,
      retentionDays: 30,
      dir: defaultBackupDir,
    },
  };

  const mode = await p.select({
    message: t("database.mode_message"),
    options: [
      { value: "embedded-postgres" as const, label: t("database.embedded_label"), hint: t("database.embedded_hint") },
      { value: "postgres" as const, label: t("database.postgres_label") },
    ],
    initialValue: base.mode,
  });

  if (p.isCancel(mode)) {
    p.cancel(t("database.setup_cancelled"));
    process.exit(0);
  }

  let connectionString: string | undefined = base.connectionString;
  let embeddedPostgresDataDir = base.embeddedPostgresDataDir || defaultEmbeddedDir;
  let embeddedPostgresPort = base.embeddedPostgresPort || 54329;

  if (mode === "postgres") {
    const value = await p.text({
      message: t("database.connection_string_message"),
      defaultValue: base.connectionString ?? "",
      placeholder: t("database.connection_string_placeholder"),
      validate: (val) => {
        if (!val) return t("database.connection_string_required");
        if (!val.startsWith("postgres")) return t("database.connection_string_protocol");
      },
    });

    if (p.isCancel(value)) {
      p.cancel(t("database.setup_cancelled"));
      process.exit(0);
    }

    connectionString = value;
  } else {
    const dataDir = await p.text({
      message: t("database.data_dir_message"),
      defaultValue: base.embeddedPostgresDataDir || defaultEmbeddedDir,
      placeholder: defaultEmbeddedDir,
    });

    if (p.isCancel(dataDir)) {
      p.cancel(t("database.setup_cancelled"));
      process.exit(0);
    }

    embeddedPostgresDataDir = dataDir || defaultEmbeddedDir;

    const portValue = await p.text({
      message: t("database.port_message"),
      defaultValue: String(base.embeddedPostgresPort || 54329),
      placeholder: "54329",
      validate: (val) => {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return t("database.port_validation");
      },
    });

    if (p.isCancel(portValue)) {
      p.cancel(t("database.setup_cancelled"));
      process.exit(0);
    }

    embeddedPostgresPort = Number(portValue || "54329");
    connectionString = undefined;
  }

  const backupEnabled = await p.confirm({
    message: t("database.backup_enabled_message"),
    initialValue: base.backup.enabled,
  });
  if (p.isCancel(backupEnabled)) {
    p.cancel(t("database.setup_cancelled"));
    process.exit(0);
  }

  const backupDirInput = await p.text({
    message: t("database.backup_dir_message"),
    defaultValue: base.backup.dir || defaultBackupDir,
    placeholder: defaultBackupDir,
    validate: (val) => (!val || val.trim().length === 0 ? t("database.backup_dir_required") : undefined),
  });
  if (p.isCancel(backupDirInput)) {
    p.cancel(t("database.setup_cancelled"));
    process.exit(0);
  }

  const backupIntervalInput = await p.text({
    message: t("database.backup_interval_message"),
    defaultValue: String(base.backup.intervalMinutes || 60),
    placeholder: "60",
    validate: (val) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) return t("database.backup_interval_positive");
      if (n > 10080) return t("database.backup_interval_max");
      return undefined;
    },
  });
  if (p.isCancel(backupIntervalInput)) {
    p.cancel(t("database.setup_cancelled"));
    process.exit(0);
  }

  const backupRetentionInput = await p.text({
    message: t("database.backup_retention_message"),
    defaultValue: String(base.backup.retentionDays || 30),
    placeholder: "30",
    validate: (val) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) return t("database.backup_retention_positive");
      if (n > 3650) return t("database.backup_retention_max");
      return undefined;
    },
  });
  if (p.isCancel(backupRetentionInput)) {
    p.cancel(t("database.setup_cancelled"));
    process.exit(0);
  }

  return {
    mode,
    connectionString,
    embeddedPostgresDataDir,
    embeddedPostgresPort,
    backup: {
      enabled: backupEnabled,
      intervalMinutes: Number(backupIntervalInput || "60"),
      retentionDays: Number(backupRetentionInput || "30"),
      dir: backupDirInput || defaultBackupDir,
    },
  };
}
