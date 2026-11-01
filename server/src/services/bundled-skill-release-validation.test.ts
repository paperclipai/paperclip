import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySkills, companySkillVersions, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { verifyExistingBundledSkillRelease } from "./bundled-skill-release-validation.js";

const support = await getEmbeddedPostgresTestSupport();
const hashInventory = (files: Array<{ path: string; content: string }>) => createHash("sha256")
  .update(JSON.stringify(files.map(file => [file.path, file.content]))).digest("hex");

(support.supported ? describe : describe.skip)("bundled release validation with current database fingerprints", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("bundled-release-validation-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(content = "saved release content") {
    const companyId = randomUUID(), skillId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Release validation", issuePrefix: companyId.slice(0, 8) });
    await db.insert(companySkills).values({ id: skillId, companyId, key: "fixture/release", slug: "release",
      name: "Release", markdown: "# Release", sourceType: "local_path" });
    const files = [{ path: "SKILL.md", kind: "skill" as const, content }];
    const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skillId,
      revisionNumber: 1, releaseId: "release-1", fileInventory: files }).returning();
    const expectedInventoryHash = hashInventory(files);
    const validateInventory = vi.fn((row: typeof companySkillVersions.$inferSelect) => {
      if (hashInventory(row.fileInventory) !== expectedInventoryHash) throw new Error("snapshot mismatch");
    });
    return { version: version!, input: { db, companyId, skillId, releaseId: "release-1", expectedInventoryHash, validateInventory } };
  }

  it("reuses proof only within current company, skill and release bindings", async () => {
    const f = await seed();
    expect(await verifyExistingBundledSkillRelease(f.input)).toBe(true);
    expect(await verifyExistingBundledSkillRelease(f.input)).toBe(true);
    expect(f.input.validateInventory).toHaveBeenCalledTimes(1);
    expect(await verifyExistingBundledSkillRelease({ ...f.input, companyId: randomUUID() })).toBe(false);
    expect(await verifyExistingBundledSkillRelease({ ...f.input, skillId: randomUUID() })).toBe(false);
    expect(await verifyExistingBundledSkillRelease({ ...f.input, releaseId: "other-release" })).toBe(false);
    expect(f.input.validateInventory).toHaveBeenCalledTimes(1);
    expect(await verifyExistingBundledSkillRelease(f.input)).toBe(true);
  });

  it("revalidates when the expected on-disk inventory changes without poisoning valid proof", async () => {
    const f = await seed();
    await verifyExistingBundledSkillRelease(f.input);
    const changedHash = hashInventory([{ path: "SKILL.md", content: "new on-disk content" }]);
    const validateChanged = vi.fn((row: typeof companySkillVersions.$inferSelect) => {
      if (hashInventory(row.fileInventory) !== changedHash) throw new Error("snapshot mismatch");
    });
    await expect(verifyExistingBundledSkillRelease({ ...f.input, expectedInventoryHash: changedHash,
      validateInventory: validateChanged })).rejects.toThrow("snapshot mismatch");
    expect(validateChanged).toHaveBeenCalledOnce();
    expect(await verifyExistingBundledSkillRelease(f.input)).toBe(true);
    expect(f.input.validateInventory).toHaveBeenCalledOnce();
  });

  it("rechecks current content after a change overlaps an earlier validation", async () => {
    const f = await seed();
    let entered!: () => void, release!: () => void;
    const validating = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = verifyExistingBundledSkillRelease({ ...f.input, validateInventory: async row => {
      f.input.validateInventory(row);
      entered();
      await held;
    } });
    await validating;
    try {
      await db.update(companySkillVersions).set({ fileInventory: [{ path: "SKILL.md", kind: "skill", content: "changed" }] })
        .where(and(eq(companySkillVersions.companyId, f.input.companyId), eq(companySkillVersions.id, f.version.id)));
    } finally { release(); }
    expect(await first).toBe(true);
    await expect(verifyExistingBundledSkillRelease(f.input)).rejects.toThrow("snapshot mismatch");
    expect(f.input.validateInventory).toHaveBeenCalledTimes(2);
  });

  it("does not accept a deleted row from earlier proof", async () => {
    const f = await seed();
    await verifyExistingBundledSkillRelease(f.input);
    await db.delete(companySkillVersions).where(eq(companySkillVersions.id, f.version.id));
    expect(await verifyExistingBundledSkillRelease(f.input)).toBe(false);
    expect(f.input.validateInventory).toHaveBeenCalledOnce();
  });

  it("bounds retained proof and safely revalidates an evicted release", async () => {
    const f = await seed();
    await verifyExistingBundledSkillRelease(f.input);
    for (let revisionNumber = 2; revisionNumber <= 66; revisionNumber++) {
      const releaseId = `release-${revisionNumber}`;
      await db.insert(companySkillVersions).values({ companyId: f.input.companyId, companySkillId: f.input.skillId,
        revisionNumber, releaseId, fileInventory: f.version.fileInventory });
      expect(await verifyExistingBundledSkillRelease({ ...f.input, releaseId })).toBe(true);
    }
    const before = f.input.validateInventory.mock.calls.length;
    expect(await verifyExistingBundledSkillRelease(f.input)).toBe(true);
    expect(f.input.validateInventory).toHaveBeenCalledTimes(before + 1);
  });
});
