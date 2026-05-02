import path from "node:path";
import fs from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, count, gte, ne, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";

interface FleetMigrateOptions {
  config?: string;
  dryRun?: boolean;
  json?: boolean;
  output?: string;
  threshold?: number;
  days?: number;
  targetAdapter?: string;
  dbUrl?: string;
}

interface MigrationRecord {
  agentId: string;
  agentName: string;
  companyId: string;
  previousAdapter: string;
  newAdapter: string;
  errorRate: number;
  totalRuns: number;
  failedRuns: number;
  reason: string;
}

function resolveDbUrl(configPath?: string, overrideDbUrl?: string): string | null {
  if (overrideDbUrl) return overrideDbUrl;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  if (config?.database.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  }
  return null;
}

function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").split(".")[0];
}

export async function fleetMigrateCommand(opts: FleetMigrateOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip fleet:migrate ")));

  const configPath = resolveConfigPath(opts.config);
  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    throw new Error("Could not resolve database connection. Run `paperclipai onboard` first.");
  }

  const threshold = opts.threshold ?? 0.05;
  const days = opts.days ?? 7;
  const targetAdapter = opts.targetAdapter ?? "opencode_local";
  const dryRun = opts.dryRun ?? false;
  const outputPath = opts.output;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };

  const migrated: MigrationRecord[] = [];
  const skipped: Array<{ agentId: string; name: string; reason: string }> = [];

  try {
    const companyRows = await db.select({ id: companies.id, name: companies.name }).from(companies);

    for (const company of companyRows) {
      const agentRows = await db
        .select()
        .from(agents)
        .where(eq(agents.companyId, company.id));

      for (const agent of agentRows) {
        if (agent.adapterType === targetAdapter) {
          skipped.push({ agentId: agent.id, name: agent.name, reason: "Already uses target adapter" });
          continue;
        }

        const meta =
          typeof agent.metadata === "object" && agent.metadata !== null && !Array.isArray(agent.metadata)
            ? (agent.metadata as Record<string, unknown>)
            : null;
        if (meta?.adapterTypeOverrideByUser === true) {
          skipped.push({ agentId: agent.id, name: agent.name, reason: "User override flag set" });
          continue;
        }

        const totalResult = await db
          .select({ total: count() })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agent.id),
              eq(heartbeatRuns.companyId, company.id),
              gte(heartbeatRuns.createdAt, since),
              ne(heartbeatRuns.status, "queued"),
            ),
          );
        const totalRuns = totalResult[0]?.total ?? 0;

        if (totalRuns === 0) {
          skipped.push({ agentId: agent.id, name: agent.name, reason: "No runs in window" });
          continue;
        }

        const failedResult = await db
          .select({ failed: count() })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agent.id),
              eq(heartbeatRuns.companyId, company.id),
              gte(heartbeatRuns.createdAt, since),
              sql`${heartbeatRuns.errorCode} = 'adapter_failed'`,
            ),
          );
        const failedRuns = failedResult[0]?.failed ?? 0;
        const errorRate = failedRuns / totalRuns;

        if (errorRate <= threshold) {
          skipped.push({
            agentId: agent.id,
            name: agent.name,
            reason: `Error rate ${(errorRate * 100).toFixed(2)}% <= ${(threshold * 100).toFixed(2)}%`,
          });
          continue;
        }

        migrated.push({
          agentId: agent.id,
          agentName: agent.name,
          companyId: company.id,
          previousAdapter: agent.adapterType,
          newAdapter: targetAdapter,
          errorRate,
          totalRuns,
          failedRuns,
          reason: `${(errorRate * 100).toFixed(2)}% adapter error rate over ${totalRuns} runs`,
        });
      }
    }

    if (migrated.length === 0) {
      p.outro(pc.yellow("No agents qualify for migration."));
      if (opts.json) {
        console.log(
          JSON.stringify({ skipped: skipped.length, migrated: 0, agents: [] }, null, 2),
        );
      }
      return;
    }

    if (dryRun) {
      p.log.info(pc.yellow(`[Dry run] Would migrate ${migrated.length} agent(s):`));
      for (const m of migrated) {
        p.log.message(`  ${pc.cyan(m.agentName)} (${m.agentId}) — ${m.reason}`);
      }
      p.outro(pc.yellow("Dry run complete. No changes made."));
      if (opts.json) {
        console.log(
          JSON.stringify({ dryRun: true, migrated, skipped }, null, 2),
        );
      }
      return;
    }

    for (const m of migrated) {
        await db
          .update(agents)
          .set({
            adapterType: targetAdapter,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, m.agentId));
    }

    const rollbackScript = generateRollbackScript(migrated);
    if (outputPath) {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), rollbackScript, "utf8");
      p.log.success(`Rollback script written to ${path.resolve(outputPath)}`);
    } else {
      p.log.info(pc.dim("Rollback script (save this):"));
      console.log(pc.gray(rollbackScript));
    }

    if (opts.json) {
      console.log(
        JSON.stringify({ migrated, skipped: skipped.length }, null, 2),
      );
    } else {
      p.log.success(`Migrated ${migrated.length} agent(s) to ${targetAdapter}:`);
      for (const m of migrated) {
        p.log.message(`  ${pc.green(m.agentName)} — ${m.reason}`);
      }
      p.log.info(`${skipped.length} agent(s) skipped.`);
    }

    p.outro(pc.green("Fleet migration completed."));
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

function generateRollbackScript(migrated: MigrationRecord[]): string {
  const rows = migrated
    .map(
      (m) =>
        `    { id: "${m.agentId}", adapterType: "${m.previousAdapter}", name: "${m.agentName.replace(/"/g, '\\"')}" }`,
    )
    .join(",\n");

  return `// Auto-generated rollback script
// Generated at: ${new Date().toISOString()}
// Restore adapter types for ${migrated.length} agent(s)

const migrated = [
${rows}
];

async function rollback() {
  const { createDb, agents, eq } = await import("@paperclipai/db");
  const db = createDb(process.env.DATABASE_URL ?? "");
  for (const agent of migrated) {
    await db.update(agents).set({ adapterType: agent.adapterType, updatedAt: new Date() }).where(eq(agents.id, agent.id));
    console.log("Restored", agent.name, "->", agent.adapterType);
  }
  await (db as any).$client?.end?.({ timeout: 5 }).catch(() => undefined);
}

rollback().catch(console.error);
`;
}
