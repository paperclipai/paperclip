import { existsSync, mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { runProjectsGc } from "./projects-gc.js";

const ALIVE_COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const DEAD_COMPANY_ID_A = "22222222-2222-2222-2222-222222222222";
const DEAD_COMPANY_ID_B = "33333333-3333-3333-3333-333333333333";

function makeFakeDb(activeIds: Set<string>): Db {
  return {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve(Array.from(activeIds).map((id) => ({ id }))),
      }),
    }),
  } as unknown as Db;
}

async function touchDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "marker"), "x");
}

async function setMtime(target: string, ms: number): Promise<void> {
  const t = new Date(ms);
  await fs.utimes(target, t, t);
}

describe("runProjectsGc", () => {
  let tempRoot: string;
  let projectsRoot: string;
  let companiesRoot: string;
  let trashRoot: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-gc-"));
    projectsRoot = path.join(tempRoot, "projects");
    companiesRoot = path.join(tempRoot, "companies");
    trashRoot = path.join(tempRoot, "_trash");
    await fs.mkdir(projectsRoot, { recursive: true });
    await fs.mkdir(companiesRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("ignores directories whose company id is still in the DB", async () => {
    await touchDir(path.join(projectsRoot, ALIVE_COMPANY_ID, "project-1"));
    await touchDir(path.join(companiesRoot, ALIVE_COMPANY_ID));

    const result = await runProjectsGc({
      db: makeFakeDb(new Set([ALIVE_COMPANY_ID])),
      retentionDays: 14,
      projectsRoot,
      companiesRoot,
      trashRoot,
    });

    expect(result.scanned).toBe(2);
    expect(result.orphans).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(existsSync(path.join(projectsRoot, ALIVE_COMPANY_ID))).toBe(true);
    expect(existsSync(path.join(companiesRoot, ALIVE_COMPANY_ID))).toBe(true);
  });

  it("ignores non-UUID directory names", async () => {
    await touchDir(path.join(projectsRoot, "_default"));
    await touchDir(path.join(projectsRoot, "scratchpad"));

    const result = await runProjectsGc({
      db: makeFakeDb(new Set()),
      retentionDays: 14,
      projectsRoot,
      companiesRoot,
      trashRoot,
    });

    expect(result.scanned).toBe(0);
    expect(result.orphans).toEqual([]);
    expect(existsSync(path.join(projectsRoot, "_default"))).toBe(true);
  });

  it("quarantines orphaned company directories from both projects and companies roots", async () => {
    await touchDir(path.join(projectsRoot, DEAD_COMPANY_ID_A, "p1"));
    await touchDir(path.join(companiesRoot, DEAD_COMPANY_ID_B));
    await touchDir(path.join(projectsRoot, ALIVE_COMPANY_ID, "p2"));

    const now = new Date("2026-04-27T12:00:00Z");
    const result = await runProjectsGc({
      db: makeFakeDb(new Set([ALIVE_COMPANY_ID])),
      retentionDays: 14,
      projectsRoot,
      companiesRoot,
      trashRoot,
      now,
    });

    expect(result.scanned).toBe(3);
    expect(result.orphans.map((o) => o.companyId).sort()).toEqual(
      [DEAD_COMPANY_ID_A, DEAD_COMPANY_ID_B].sort(),
    );
    expect(result.quarantined).toHaveLength(2);

    expect(existsSync(path.join(projectsRoot, DEAD_COMPANY_ID_A))).toBe(false);
    expect(existsSync(path.join(companiesRoot, DEAD_COMPANY_ID_B))).toBe(false);
    expect(existsSync(path.join(projectsRoot, ALIVE_COMPANY_ID))).toBe(true);

    const projectsTrashEntries = await fs.readdir(path.join(trashRoot, "projects"));
    expect(projectsTrashEntries).toHaveLength(1);
    expect(projectsTrashEntries[0]).toContain(DEAD_COMPANY_ID_A);

    const companiesTrashEntries = await fs.readdir(path.join(trashRoot, "companies"));
    expect(companiesTrashEntries).toHaveLength(1);
    expect(companiesTrashEntries[0]).toContain(DEAD_COMPANY_ID_B);
  });

  it("does nothing destructive in dry-run mode", async () => {
    await touchDir(path.join(projectsRoot, DEAD_COMPANY_ID_A));

    const result = await runProjectsGc({
      db: makeFakeDb(new Set()),
      retentionDays: 14,
      dryRun: true,
      projectsRoot,
      companiesRoot,
      trashRoot,
    });

    expect(result.dryRun).toBe(true);
    expect(result.orphans).toHaveLength(1);
    expect(result.quarantined).toHaveLength(0);
    expect(result.swept).toEqual([]);
    expect(existsSync(path.join(projectsRoot, DEAD_COMPANY_ID_A))).toBe(true);
  });

  it("sweeps quarantine entries older than retentionDays", async () => {
    const now = new Date("2026-04-27T00:00:00Z");
    const oldDir = path.join(trashRoot, "projects", `${DEAD_COMPANY_ID_A}-old`);
    const recentDir = path.join(trashRoot, "companies", `${DEAD_COMPANY_ID_B}-recent`);
    await touchDir(oldDir);
    await touchDir(recentDir);
    await setMtime(oldDir, now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await setMtime(recentDir, now.getTime() - 1 * 24 * 60 * 60 * 1000);

    const result = await runProjectsGc({
      db: makeFakeDb(new Set()),
      retentionDays: 14,
      projectsRoot,
      companiesRoot,
      trashRoot,
      now,
    });

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0]).toBe(oldDir);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(recentDir)).toBe(true);
  });

  it("retentionDays=0 sweeps quarantine immediately", async () => {
    const now = new Date("2026-04-27T00:00:00Z");
    const dir = path.join(trashRoot, "projects", `${DEAD_COMPANY_ID_A}-x`);
    await touchDir(dir);
    await setMtime(dir, now.getTime() - 60 * 1000);

    const result = await runProjectsGc({
      db: makeFakeDb(new Set()),
      retentionDays: 0,
      projectsRoot,
      companiesRoot,
      trashRoot,
      now,
    });

    expect(result.swept).toContain(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
