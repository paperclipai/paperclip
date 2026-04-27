import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import {
  resolveCompanyScratchRoot,
  resolvePaperclipTrashRoot,
  resolveProjectScratchRoot,
} from "../home-paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OrphanScratchKind = "projects" | "companies";

export interface OrphanScratchDir {
  kind: OrphanScratchKind;
  companyId: string;
  path: string;
}

export interface ProjectsGcResult {
  scanned: number;
  orphans: OrphanScratchDir[];
  quarantined: Array<{ kind: OrphanScratchKind; companyId: string; from: string; to: string }>;
  swept: string[];
  errors: Array<{ phase: "quarantine" | "sweep"; path: string; message: string }>;
  dryRun: boolean;
}

export interface ProjectsGcOptions {
  db: Db;
  retentionDays: number;
  dryRun?: boolean;
  projectsRoot?: string;
  companiesRoot?: string;
  trashRoot?: string;
  now?: Date;
}

async function listSubdirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
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
  const candidates: Array<{ kind: OrphanScratchKind; companyId: string; path: string }> = [];

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
  // 2026-04-27T15-55-24-129Z (filesystem-safe, monotonic)
  return now.toISOString().replace(/[:.]/g, "-");
}

async function quarantineOrphan(
  orphan: OrphanScratchDir,
  trashRoot: string,
  now: Date,
): Promise<{ kind: OrphanScratchKind; companyId: string; from: string; to: string }> {
  const bucket = path.resolve(trashRoot, orphan.kind);
  await fs.mkdir(bucket, { recursive: true });
  const target = path.resolve(bucket, `${orphan.companyId}-${timestampSlug(now)}`);
  await fs.rename(orphan.path, target);
  return { kind: orphan.kind, companyId: orphan.companyId, from: orphan.path, to: target };
}

async function sweepBucket(
  bucketDir: string,
  cutoffMs: number,
): Promise<{ swept: string[]; errors: Array<{ path: string; message: string }> }> {
  if (!existsSync(bucketDir)) return { swept: [], errors: [] };
  const swept: string[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const entries = await fs.readdir(bucketDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.resolve(bucketDir, entry.name);
    try {
      const stat = await fs.stat(entryPath);
      if (stat.mtimeMs > cutoffMs) continue;
      await fs.rm(entryPath, { recursive: true, force: true });
      swept.push(entryPath);
    } catch (err) {
      errors.push({ path: entryPath, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { swept, errors };
}

export async function runProjectsGc(opts: ProjectsGcOptions): Promise<ProjectsGcResult> {
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date();
  const projectsRoot = opts.projectsRoot ?? resolveProjectScratchRoot();
  const companiesRoot = opts.companiesRoot ?? resolveCompanyScratchRoot();
  const trashRoot = opts.trashRoot ?? resolvePaperclipTrashRoot();
  const retentionDays = Math.max(0, Math.trunc(opts.retentionDays));

  const { scanned, orphans } = await findOrphanScratchDirs({
    db: opts.db,
    projectsRoot,
    companiesRoot,
  });

  const result: ProjectsGcResult = {
    scanned,
    orphans,
    quarantined: [],
    swept: [],
    errors: [],
    dryRun,
  };

  if (!dryRun) {
    for (const orphan of orphans) {
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
  }

  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  for (const kind of ["projects", "companies"] as const) {
    const bucket = path.resolve(trashRoot, kind);
    if (dryRun) continue;
    const sweep = await sweepBucket(bucket, cutoffMs);
    result.swept.push(...sweep.swept);
    for (const err of sweep.errors) {
      result.errors.push({ phase: "sweep", path: err.path, message: err.message });
    }
  }

  return result;
}
