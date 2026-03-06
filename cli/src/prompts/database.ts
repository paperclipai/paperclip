import * as p from "@clack/prompts";
import type { DatabaseConfig } from "../config/schema.js";
import { resolveDefaultEmbeddedPostgresDir, resolvePaperclipInstanceId } from "../config/home.js";

export async function promptDatabase(): Promise<DatabaseConfig> {
  const defaultEmbeddedDir = resolveDefaultEmbeddedPostgresDir(resolvePaperclipInstanceId());

  const mode = await p.select({
    message: "Database mode",
    options: [
      { value: "embedded-postgres" as const, label: "Embedded PostgreSQL (managed locally)", hint: "recommended" },
      { value: "postgres" as const, label: "PostgreSQL (external server)" },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (mode === "postgres") {
    const connectionString = await p.text({
      message: "PostgreSQL connection string",
      placeholder: "postgres://user:pass@localhost:5432/paperclip",
      validate: (val) => {
        if (!val) return "Connection string is required for PostgreSQL mode";
        if (!val.startsWith("postgres")) return "Must be a postgres:// or postgresql:// URL";
      },
    });

    if (p.isCancel(connectionString)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    return {
      mode: "postgres",
      connectionString,
      embeddedPostgresDataDir: defaultEmbeddedDir,
      embeddedPostgresPort: 54329,
    };
  }

  const embeddedPostgresDataDir = await p.text({
    message: "Embedded PostgreSQL data directory",
    defaultValue: defaultEmbeddedDir,
    placeholder: defaultEmbeddedDir,
  });

  if (p.isCancel(embeddedPostgresDataDir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const embeddedPostgresPort = await p.text({
    message: "Embedded PostgreSQL port",
    defaultValue: "54329",
    placeholder: "54329",
    validate: (val) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return "Port must be an integer between 1 and 65535";
    },
  });

  if (p.isCancel(embeddedPostgresPort)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    mode: "embedded-postgres",
    embeddedPostgresDataDir: embeddedPostgresDataDir || defaultEmbeddedDir,
    embeddedPostgresPort: Number(embeddedPostgresPort || "54329"),
  };
}
