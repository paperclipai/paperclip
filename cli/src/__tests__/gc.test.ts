import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOrphanScratchDirs } from "../commands/gc.js";

const KNOWN_COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const ORPHAN_COMPANY_ID = "22222222-2222-2222-2222-222222222222";

type StubDb = {
  select: (cols: unknown) => {
    from: (table: unknown) => {
      where: (cond: unknown) => Promise<Array<{ id: string }>>;
    };
  };
};

function makeStubDb(knownIds: string[]): StubDb {
  return {
    select: () => ({
      from: () => ({
        where: async () => knownIds.map((id) => ({ id })),
      }),
    }),
  };
}

function mkInstanceRoot(): { instanceRoot: string; cleanupRoot: string } {
  const cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-gc-"));
  const instanceRoot = path.join(cleanupRoot, ".paperclip", "instances", "test");
  fs.mkdirSync(path.join(instanceRoot, "projects", KNOWN_COMPANY_ID, "p"), { recursive: true });
  fs.mkdirSync(path.join(instanceRoot, "projects", ORPHAN_COMPANY_ID, "x"), { recursive: true });
  fs.mkdirSync(path.join(instanceRoot, "companies", KNOWN_COMPANY_ID, "codex-home"), { recursive: true });
  fs.mkdirSync(path.join(instanceRoot, "companies", ORPHAN_COMPANY_ID, "codex-home"), { recursive: true });
  fs.mkdirSync(path.join(instanceRoot, "projects", "not-a-uuid"), { recursive: true });
  return { instanceRoot, cleanupRoot };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("findOrphanScratchDirs", () => {
  it("flags only company-id dirs absent from the DB", async () => {
    const { instanceRoot, cleanupRoot } = mkInstanceRoot();
    cleanupDirs.push(cleanupRoot);

    const result = await findOrphanScratchDirs({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: makeStubDb([KNOWN_COMPANY_ID]) as any,
      projectsRoot: path.join(instanceRoot, "projects"),
      companiesRoot: path.join(instanceRoot, "companies"),
    });

    const ids = result.orphans.map((o) => o.companyId).sort();
    expect(ids).toEqual([ORPHAN_COMPANY_ID, ORPHAN_COMPANY_ID].sort());

    const kinds = new Set(result.orphans.map((o) => o.kind));
    expect(kinds).toEqual(new Set(["projects", "companies"]));
    expect(result.scanned).toBe(4); // 2 projects + 2 companies, "not-a-uuid" is skipped
  });

  it("returns no orphans when every UUID dir is in the DB", async () => {
    const { instanceRoot, cleanupRoot } = mkInstanceRoot();
    cleanupDirs.push(cleanupRoot);

    const result = await findOrphanScratchDirs({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: makeStubDb([KNOWN_COMPANY_ID, ORPHAN_COMPANY_ID]) as any,
      projectsRoot: path.join(instanceRoot, "projects"),
      companiesRoot: path.join(instanceRoot, "companies"),
    });

    expect(result.orphans).toHaveLength(0);
  });

  it("handles missing instance roots gracefully", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-gc-empty-"));
    cleanupDirs.push(tmp);

    const result = await findOrphanScratchDirs({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: makeStubDb([]) as any,
      projectsRoot: path.join(tmp, "nonexistent-projects"),
      companiesRoot: path.join(tmp, "nonexistent-companies"),
    });

    expect(result.scanned).toBe(0);
    expect(result.orphans).toHaveLength(0);
  });
});
