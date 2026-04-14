import { Router } from "express";
import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "@paperclipai/db";
import { count, sql } from "drizzle-orm";
import { instanceUserRoles } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";

/**
 * Tables the application cannot run without. If any of these are missing
 * (e.g. a botched migration, restored backup with the wrong schema,
 * accidental DROP TABLE), the service should be considered degraded so
 * external monitoring can fire alerts.
 */
const CRITICAL_TABLES = [
  "user", // better-auth user table
  "instance_user_roles",
  "agents",
  "issues",
  "session", // better-auth session table
] as const;

export type SchemaIntegrityStatus = "ok" | "degraded" | "unknown";

export interface SchemaIntegrityResult {
  status: SchemaIntegrityStatus;
  checkedAt: string;
  missingTables: string[];
  errors: Array<{ table: string; message: string }>;
}

/**
 * Run a cheap `SELECT 1 FROM "<table>" LIMIT 1` against each critical table.
 * Each query is wrapped in its own try/catch so we collect every failure
 * rather than aborting on the first one — this gives operators a complete
 * picture of what's broken in a single alert.
 */
export async function checkSchemaIntegrity(db: Db | undefined): Promise<SchemaIntegrityResult> {
  const checkedAt = new Date().toISOString();
  if (!db) {
    return { status: "unknown", checkedAt, missingTables: [], errors: [] };
  }

  const missingTables: string[] = [];
  const errors: Array<{ table: string; message: string }> = [];

  for (const table of CRITICAL_TABLES) {
    try {
      // sql.identifier() ensures quoting/safety; the table list is a const
      // tuple so this is not a SQL injection vector.
      await db.execute(sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      missingTables.push(table);
      errors.push({ table, message });
    }
  }

  return {
    status: missingTables.length === 0 ? "ok" : "degraded",
    checkedAt,
    missingTables,
    errors,
  };
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.get("/", async (_req, res) => {
    if (!db) {
      res.json({ status: "ok", schemaIntegrity: "unknown" });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";
    }

    const schemaCheck = await checkSchemaIntegrity(db);
    const status = schemaCheck.status === "degraded" ? "degraded" : "ok";
    const httpStatus = schemaCheck.status === "degraded" ? 503 : 200;

    res.status(httpStatus).json({
      status,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      schemaIntegrity: schemaCheck.status,
      schemaIntegrityDetails: {
        checkedAt: schemaCheck.checkedAt,
        missingTables: schemaCheck.missingTables,
        errors: schemaCheck.errors,
      },
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
    });
  });

  router.get("/schema", async (_req, res) => {
    const result = await checkSchemaIntegrity(db);
    const httpStatus = result.status === "degraded" ? 503 : 200;
    res.status(httpStatus).json(result);
  });

  // Temporary: list backup files for data recovery
  router.get("/backups", (_req, res) => {
    const candidates = [
      // Host-mounted backup dir (survives Docker volume wipes)
      "/paperclip/external-backups",
      "/paperclip/instances/default/data/backups",
      "/paperclip/data/backups",
      "/paperclip/backups",
    ];
    for (const dir of candidates) {
      if (existsSync(dir)) {
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".sql"))
          .map((f) => {
            const stat = statSync(resolve(dir, f));
            return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
          })
          .sort((a, b) => b.modified.localeCompare(a.modified));
        res.json({ backupDir: dir, files });
        return;
      }
    }
    res.json({ backupDir: null, files: [], searched: candidates });
  });

  return router;
}
