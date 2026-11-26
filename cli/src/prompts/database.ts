import * as p from "@clack/prompts";
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
    message: "Database mode",
    options: [
      { value: "embedded-postgres" as const, label: "Embedded PostgreSQL (managed locally)", hint: "recommended" },
      { value: "postgres" as const, label: "PostgreSQL (external server)" },
    ],
    initialValue: base.mode,
  });

  if (p.isCancel(mode)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  let connectionString: string | undefined = base.connectionString;
  let embeddedPostgresDataDir = base.embeddedPostgresDataDir || defaultEmbeddedDir;
  let embeddedPostgresPort = base.embeddedPostgresPort || 54329;
  const embeddedPortDefault = String(base.embeddedPostgresPort || 54329);

  if (mode === "postgres") {
    // Clack validates the raw input before applying defaultValue, so an
    // Enter press hands the validator an empty string. Validate the value
    // that will actually be submitted — the typed input, or the default.
    const connectionStringDefault = base.connectionString ?? "";
    const value = await p.text({
      message: "PostgreSQL connection string",
      defaultValue: connectionStringDefault,
      placeholder: "postgres://user:pass@localhost:5432/paperclip",
      validate: (val) => {
        const candidate = val || connectionStringDefault;
        if (!candidate) return "Connection string is required for PostgreSQL mode";
        if (!candidate.startsWith("postgres")) return "Must be a postgres:// or postgresql:// URL";
      },
    });

    if (p.isCancel(value)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    connectionString = value;
  } else {
    const dataDir = await p.text({
      message: "Embedded PostgreSQL data directory",
      defaultValue: base.embeddedPostgresDataDir || defaultEmbeddedDir,
      placeholder: defaultEmbeddedDir,
    });

    if (p.isCancel(dataDir)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    embeddedPostgresDataDir = dataDir || defaultEmbeddedDir;

    const portValue = await p.text({
      message: "Embedded PostgreSQL port",
      defaultValue: embeddedPortDefault,
      placeholder: "54329",
      validate: (val) => {
        const n = Number(val || embeddedPortDefault);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return "Port must be an integer between 1 and 65535";
      },
    });

    if (p.isCancel(portValue)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    embeddedPostgresPort = Number(portValue || embeddedPortDefault);
    connectionString = undefined;
  }

  const backupEnabled = await p.confirm({
    message: "Enable automatic database backups?",
    initialValue: base.backup.enabled,
  });
  if (p.isCancel(backupEnabled)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const backupDirDefault = base.backup.dir || defaultBackupDir;
  const backupDirInput = await p.text({
    message: "Backup directory",
    defaultValue: backupDirDefault,
    placeholder: defaultBackupDir,
    validate: (val) => ((val || backupDirDefault).trim().length === 0 ? "Backup directory is required" : undefined),
  });
  if (p.isCancel(backupDirInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const backupIntervalDefault = String(base.backup.intervalMinutes || 60);
  const backupRetentionDefault = String(base.backup.retentionDays || 30);
  const backupIntervalInput = await p.text({
    message: "Backup interval (minutes)",
    defaultValue: backupIntervalDefault,
    placeholder: "60",
    validate: (val) => {
      const n = Number(val || backupIntervalDefault);
      if (!Number.isInteger(n) || n < 1) return "Interval must be a positive integer";
      if (n > 10080) return "Interval must be 10080 minutes (7 days) or less";
      return undefined;
    },
  });
  if (p.isCancel(backupIntervalInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const backupRetentionInput = await p.text({
    message: "Backup retention (days)",
    defaultValue: backupRetentionDefault,
    placeholder: "30",
    validate: (val) => {
      const n = Number(val || backupRetentionDefault);
      if (!Number.isInteger(n) || n < 1) return "Retention must be a positive integer";
      if (n > 3650) return "Retention must be 3650 days or less";
      return undefined;
    },
  });
  if (p.isCancel(backupRetentionInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    mode,
    connectionString,
    embeddedPostgresDataDir,
    embeddedPostgresPort,
    backup: {
      enabled: backupEnabled,
      intervalMinutes: Number(backupIntervalInput || backupIntervalDefault),
      retentionDays: Number(backupRetentionInput || backupRetentionDefault),
      dir: backupDirInput || defaultBackupDir,
    },
  };
}
