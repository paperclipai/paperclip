import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/index.js";
import { migrateLocalSkillPackageObjects } from "./skill-package-storage-migration.js";

vi.mock("./skill-package-store.js", () => ({ skillPackageStore: () => ({ verifyDurable: async () => true }) }));

const local = { provider: "local_disk" } as StorageService;
const s3 = { provider: "s3", putFile: vi.fn(), getObject: vi.fn() } as unknown as StorageService;
const row = { id: "snapshot-1", companyId: "company-1", storage: { provider: "local_disk", archiveKey: "a", manifestKey: "m",
  archiveBytes: 1, archiveSha256: "x", manifestBytes: 1, manifestSha256: "y" } };

function fakeDb(claimed: boolean) {
  const chain = (value: unknown) => {
    const node: Record<string, unknown> = {};
    for (const key of ["from", "where", "orderBy", "set"]) node[key] = () => node;
    node.limit = async () => value;
    node.returning = async () => (claimed ? [{ id: row.id }] : []);
    return node;
  };
  return { select: () => chain([row]), update: () => chain([]) } as unknown as Db;
}

afterEach(() => vi.unstubAllEnvs());

it("refuses outside offline maintenance unless the caller is the online pass", async () => {
  await expect(migrateLocalSkillPackageObjects({} as Db, { source: local, destination: s3, writersStopped: false,
    signal: AbortSignal.timeout(5_000) })).rejects.toThrow("offline_skill_object_migration_required");
  await expect(migrateLocalSkillPackageObjects({} as Db, { source: s3, destination: s3, writersStopped: false, online: true,
    signal: AbortSignal.timeout(5_000) })).rejects.toThrow("offline_skill_object_migration_required");
});

it("skips a row another owner holds while serving instead of failing the pass", async () => {
  const result = await migrateLocalSkillPackageObjects(fakeDb(false), { source: local, destination: s3, writersStopped: false,
    online: true, signal: AbortSignal.timeout(5_000) });
  expect(result).toEqual({ inspected: 1, migrated: 0, busy: 1, after: "snapshot-1" });
  expect(s3.putFile).not.toHaveBeenCalled();
});

it("keeps failing closed on a busy row in offline maintenance", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
  await expect(migrateLocalSkillPackageObjects(fakeDb(false), { source: local, destination: s3, writersStopped: true,
    signal: AbortSignal.timeout(5_000) })).rejects.toThrow("skill_object_migration_owner_busy");
});
