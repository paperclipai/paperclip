import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb, executionWorkspaces, issues, workspaceRuntimeServices } from "@paperclipai/db";
import { readConfig, resolveConfigPath } from "../../cli/src/config/store.js";
import { planSharedWorkspaceDeduplication } from "../src/services/execution-workspaces.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usage(): never {
  console.error(
    "Usage: tsx server/scripts/dedupe-shared-execution-workspaces.ts --project-id <uuid> [--company-id <uuid>] [--project-workspace-id <uuid>] [--cwd <path>] [--apply] [--config <path>]",
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const result: {
    projectId: string | null;
    companyId: string | null;
    projectWorkspaceId: string | null;
    cwd: string | null;
    apply: boolean;
    configPath?: string;
  } = {
    projectId: null,
    companyId: null,
    projectWorkspaceId: null,
    cwd: null,
    apply: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--apply") {
      result.apply = true;
      continue;
    }
    if (arg === "--project-id") {
      result.projectId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--company-id") {
      result.companyId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--project-workspace-id") {
      result.projectWorkspaceId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--cwd") {
      result.cwd = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--config") {
      result.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    usage();
  }

  if (!result.projectId) usage();
  return result;
}

function resolveConnectionString(configPath?: string) {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();

  const resolvedConfigPath = resolveConfigPath(configPath);
  const config = readConfig(resolvedConfigPath);
  if (!config) {
    throw new Error(`No Paperclip config found at ${resolvedConfigPath}`);
  }

  if (config.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return config.database.connectionString.trim();
  }

  const port = config.database.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = resolveConnectionString(args.configPath);
  const db = createDb(connectionString);
  try {
    const conditions = [
      eq(executionWorkspaces.projectId, args.projectId!),
      eq(executionWorkspaces.mode, "shared_workspace"),
      eq(executionWorkspaces.strategyType, "project_primary"),
      inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
    ];
    if (args.companyId) conditions.push(eq(executionWorkspaces.companyId, args.companyId));
    if (args.projectWorkspaceId) conditions.push(eq(executionWorkspaces.projectWorkspaceId, args.projectWorkspaceId));
    if (args.cwd) conditions.push(eq(executionWorkspaces.cwd, args.cwd));

    const candidates = await db
      .select({
        id: executionWorkspaces.id,
        projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
        cwd: executionWorkspaces.cwd,
        status: executionWorkspaces.status,
        lastUsedAt: executionWorkspaces.lastUsedAt,
        createdAt: executionWorkspaces.createdAt,
        metadata: executionWorkspaces.metadata,
        linkedIssueCount: sql<number>`(
          select count(*)::int
          from ${issues}
          where ${issues.executionWorkspaceId} = ${executionWorkspaces.id}
        )`,
        activeRuntimeCount: sql<number>`(
          select count(*)::int
          from ${workspaceRuntimeServices}
          where ${workspaceRuntimeServices.executionWorkspaceId} = ${executionWorkspaces.id}
            and ${workspaceRuntimeServices.status} in ('running', 'starting')
        )`,
      })
      .from(executionWorkspaces)
      .where(and(...conditions));

    const metadataByWorkspaceId = new Map(
      candidates.map((candidate) => [candidate.id, asRecord(candidate.metadata)]),
    );
    const plans = planSharedWorkspaceDeduplication(
      candidates.map((candidate) => ({
        id: candidate.id,
        projectWorkspaceId: candidate.projectWorkspaceId ?? null,
        cwd: candidate.cwd ?? null,
        status: candidate.status,
        lastUsedAt: candidate.lastUsedAt,
        createdAt: candidate.createdAt,
        linkedIssueCount: Number(candidate.linkedIssueCount ?? 0),
        activeRuntimeCount: Number(candidate.activeRuntimeCount ?? 0),
      })),
    );

    const archiveCount = plans.reduce((sum, plan) => sum + plan.archive.length, 0);
    const skippedCount = plans.reduce((sum, plan) => sum + plan.skipped.length, 0);

    console.log(
      JSON.stringify(
        {
          projectId: args.projectId,
          apply: args.apply,
          groups: plans.length,
          archiveCount,
          skippedCount,
          plans: plans.map((plan) => ({
            projectWorkspaceId: plan.projectWorkspaceId,
            cwd: plan.cwd,
            keep: plan.keep.id,
            archive: plan.archive.map((candidate) => candidate.id),
            skipped: plan.skipped.map((candidate) => candidate.id),
          })),
        },
        null,
        2,
      ),
    );

    if (!args.apply || archiveCount === 0) return;

    const now = new Date();
    for (const plan of plans) {
      for (const candidate of plan.archive) {
        const metadata = metadataByWorkspaceId.get(candidate.id) ?? {};
        await db
          .update(executionWorkspaces)
          .set({
            status: "archived",
            closedAt: now,
            cleanupReason: `Archived duplicate shared workspace in favor of ${plan.keep.id}`,
            metadata: {
              ...metadata,
              dedupedSharedWorkspace: {
                canonicalExecutionWorkspaceId: plan.keep.id,
                archivedAt: now.toISOString(),
                originalStatus: candidate.status,
              },
            },
            updatedAt: now,
          })
          .where(eq(executionWorkspaces.id, candidate.id));
      }
    }

    console.log(
      `Archived ${archiveCount} duplicate shared execution workspace rows for project ${args.projectId}.`,
    );
  } finally {
    await db.$client.end();
  }
}

void main();
