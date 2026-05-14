import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { inArray } from "drizzle-orm";
import { companies, createDb, type Db } from "@paperclipai/db";
import {
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "../config/home.js";
import { readConfig } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OrphanScratchKind = "projects" | "companies";

export interface OrphanScratchDir {
  kind: OrphanScratchKind;
  companyId: string;
  path: string;
}

export interface ProjectsGcSummary {
  scanned: number;
  orphans: OrphanScratchDir[];
  quarantined: Array<{ kind: OrphanScratchKind; companyId: string; from: string; to: string }>;
  swept: string[];
  errors: Array<{ phase: "quarantine" | "sweep"; path: string; message: string }>;
  dryRun: boolean;
}

type ProjectsGcOptions = {
  config?: string;
  dataDir?: string;
  instance?: string;
  apply?: boolean;
  dryRun?: boolean;
  retentionDays?: number;
  json?: boolean;
};

function resolveConnectionString(configPath?: string): { value: string; source: string } | null {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return { value: envUrl, source: "DATABASE_URL" };

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return {
      value: config.database.connectionString.trim(),
      source: "config.database.connectionString",
    };
  }
  if (config?.database.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return {
      value: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
      source: `embedded-postgres@${port}`,
    };
  }
  return null;
}

function defaultRetentionDays(): number {
  const fromEnv = Number(process.env.PAPERCLIP_PROJECTS_GC_RETENTION_DAYS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.trunc(fromEnv);
  return 14;
}

function resolveInstanceRoot(instance?: string): string {
  if (!instance) return resolvePaperclipInstanceRoot();
  return path.resolve(resolvePaperclipHomeDir(), "instances", resolvePaperclipInstanceId(instance));
}

async function listSubdirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function loadKnownCompanyIds(db: Db, candidateIds: string[]): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(inArray(companies.id, candidateIds));
  return new Set(rows.map((row) => row.id));
}

export async function findOrphanScratchDirs(input: {
  db: Db;
  projectsRoot: string;
  companiesRoot: string;
}): Promise<{ scanned: number; orphans: OrphanScratchDir[] }> {
  const candidates: OrphanScratchDir[] = [];

  for (const [root, kind] of [
    [input.projectsRoot, "projects" as const],
    [input.companiesRoot, "companies" as const],
  ] satisfies Array<[string, OrphanScratchKind]>) {
    const names = await listSubdirs(root);
    for (const name of names) {
      if (!UUID_RE.test(name)) continue;
      candidates.push({ kind, companyId: name, path: path.resolve(root, name) });
    }
  }

  const known = await loadKnownCompanyIds(
    input.db,
    Array.from(new Set(candidates.map((c) => c.companyId))),
  );
  const orphans = candidates.filter((c) => !known.has(c.companyId));
  return { scanned: candidates.length, orphans };
}

function timestampSlug(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function quarantineOrphan(
  orphan: OrphanScratchDir,
  trashRoot: string,
  now: Date,
) {
  const bucket = path.resolve(trashRoot, orphan.kind);
  await fsPromises.mkdir(bucket, { recursive: true });
  const target = path.resolve(bucket, `${orphan.companyId}-${timestampSlug(now)}`);
  await fsPromises.rename(orphan.path, target);
  return { kind: orphan.kind, companyId: orphan.companyId, from: orphan.path, to: target };
}

async function sweepBucket(bucketDir: string, cutoffMs: number) {
  if (!existsSync(bucketDir)) return { swept: [] as string[], errors: [] as Array<{ path: string; message: string }> };
  const swept: string[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const entries = await fsPromises.readdir(bucketDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.resolve(bucketDir, entry.name);
    try {
      const stat = await fsPromises.stat(entryPath);
      if (stat.mtimeMs > cutoffMs) continue;
      await fsPromises.rm(entryPath, { recursive: true, force: true });
      swept.push(entryPath);
    } catch (err) {
      errors.push({ path: entryPath, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { swept, errors };
}

export async function projectsGcCommand(opts: ProjectsGcOptions): Promise<void> {
  const isJson = Boolean(opts.json);
  if (!isJson) {
    printPaperclipCliBanner();
    p.intro(pc.bgCyan(pc.black(" paperclipai projects:gc ")));
  }

  const connection = resolveConnectionString(opts.config);
  if (!connection) {
    throw new Error("Could not resolve a database connection (no DATABASE_URL and no embedded-postgres config).");
  }

  const dryRun = opts.apply !== true;
  const retentionDays =
    opts.retentionDays !== undefined && Number.isFinite(opts.retentionDays)
      ? Math.max(0, Math.trunc(opts.retentionDays))
      : defaultRetentionDays();

  const instanceRoot = resolveInstanceRoot(opts.instance);
  const projectsRoot = path.resolve(instanceRoot, "projects");
  const companiesRoot = path.resolve(instanceRoot, "companies");
  const trashRoot = path.resolve(instanceRoot, "_trash");

  if (!isJson) {
    p.log.message(pc.dim(`Instance root: ${instanceRoot}`));
    p.log.message(pc.dim(`DB source: ${connection.source}`));
    p.log.message(pc.dim(`Retention: ${retentionDays} day(s)`));
    p.log.message(pc.dim(`Mode: ${dryRun ? "dry-run" : "apply (quarantine + sweep)"}`));
  }

  const db = createDb(connection.value);
  const result: ProjectsGcSummary = {
    scanned: 0,
    orphans: [],
    quarantined: [],
    swept: [],
    errors: [],
    dryRun,
  };
  try {
    const found = await findOrphanScratchDirs({ db, projectsRoot, companiesRoot });
    result.scanned = found.scanned;
    result.orphans = found.orphans;

    const now = new Date();
    if (!dryRun) {
      for (const orphan of found.orphans) {
        try {
          const moved = await quarantineOrphan(orphan, trashRoot, now);
          result.quarantined.push(moved);
        } catch (err) {
          result.errors.push({
            phase: "quarantine",
            path: orphan.path,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
      for (const kind of ["projects", "companies"] as const) {
        const sweep = await sweepBucket(path.resolve(trashRoot, kind), cutoffMs);
        result.swept.push(...sweep.swept);
        for (const err of sweep.errors) {
          result.errors.push({ phase: "sweep", path: err.path, message: err.message });
        }
      }
    }

    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.orphans.length === 0 && result.swept.length === 0) {
      p.outro(pc.green(`Nothing to clean (scanned ${result.scanned}).`));
      return;
    }

    if (result.orphans.length > 0) {
      p.log.message(pc.yellow(`Found ${result.orphans.length} orphan${result.orphans.length === 1 ? "" : "s"}:`));
      for (const orphan of result.orphans) {
        p.log.message(`  • [${orphan.kind}] ${orphan.companyId}  ${pc.dim(orphan.path)}`);
      }
    }
    if (dryRun) {
      p.log.info("Dry-run only. Re-run with --apply to quarantine the directories above (and sweep older trash).");
      p.outro("Done.");
      return;
    }
    if (result.quarantined.length > 0) {
      p.log.message(pc.cyan(`Quarantined ${result.quarantined.length}:`));
      for (const entry of result.quarantined) {
        p.log.message(`  • [${entry.kind}] ${entry.companyId} → ${pc.dim(entry.to)}`);
      }
    }
    if (result.swept.length > 0) {
      p.log.message(pc.cyan(`Swept ${result.swept.length} expired trash entr${result.swept.length === 1 ? "y" : "ies"}.`));
    }
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        p.log.error(`[${err.phase}] ${err.path}: ${err.message}`);
      }
    }
    p.outro(pc.green("Done."));
  } finally {
    await (db as unknown as { $client?: { end?: (opts?: { timeout?: number }) => Promise<void> } }).$client
      ?.end?.({ timeout: 5 })
      .catch(() => undefined);
  }
}
