import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

function isInsideOsTmpDir(targetPath: string): boolean {
  const tmpRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(targetPath);
  return resolved === tmpRoot || resolved.startsWith(`${tmpRoot}${path.sep}`);
}

export async function databaseCheck(config: PaperclipConfig, configPath?: string): Promise<CheckResult> {
  if (config.database.mode === "postgres") {
    if (!config.database.connectionString) {
      return {
        name: "Database",
        status: "fail",
        message: "PostgreSQL mode selected but no connection string configured",
        canRepair: false,
        repairHint: "Run `paperclipai configure --section database`",
      };
    }

    try {
      const { createDb } = await import("@paperclipai/db");
      const db = createDb(config.database.connectionString);
      await db.execute("SELECT 1");
      return {
        name: "Database",
        status: "pass",
        message: "PostgreSQL connection successful",
      };
    } catch (err) {
      return {
        name: "Database",
        status: "fail",
        message: `Cannot connect to PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
        canRepair: false,
        repairHint: "Check your connection string and ensure PostgreSQL is running",
      };
    }
  }

  if (config.database.mode === "embedded-postgres") {
    const dataDir = resolveRuntimeLikePath(config.database.embeddedPostgresDataDir, configPath);
    const reportedPath = dataDir;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(reportedPath, { recursive: true });
    }

    // A worktree-mode instance whose data dir lives under the OS temp dir is a red
    // flag: this is what happens when PAPERCLIP_HOME / PAPERCLIP_IN_WORKTREE leak
    // into a PRIMARY instance's environment and silently relocate it to a throwaway
    // temp home, so it boots an empty DB and locks everyone out. (Intentional
    // ephemeral/CI instances that don't set PAPERCLIP_IN_WORKTREE are not flagged.)
    if (isInsideOsTmpDir(dataDir) && process.env.PAPERCLIP_IN_WORKTREE === "true") {
      return {
        name: "Database",
        status: "warn",
        message:
          `Embedded PostgreSQL data dir is inside the OS temp directory (${dataDir}) ` +
          "while running in worktree mode (PAPERCLIP_IN_WORKTREE=true). Data stored here is " +
          "ephemeral and will be lost on reboot or a temp cleanup. If this is your primary " +
          "instance, PAPERCLIP_HOME / PAPERCLIP_IN_WORKTREE likely leaked into its environment, " +
          "pointing it at a throwaway worktree home instead of your real data.",
        canRepair: false,
        repairHint:
          "If this is the primary instance, unset PAPERCLIP_HOME and PAPERCLIP_IN_WORKTREE " +
          "(or pass --data-dir <persistent path>) and restart so it uses the persistent instance.",
      };
    }

    return {
      name: "Database",
      status: "pass",
      message: `Embedded PostgreSQL configured at ${dataDir} (port ${config.database.embeddedPostgresPort})`,
    };
  }

  return {
    name: "Database",
    status: "fail",
    message: `Unknown database mode: ${String(config.database.mode)}`,
    canRepair: false,
    repairHint: "Run `paperclipai configure --section database`",
  };
}
