import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import { expect, it } from "vitest";
import { folders } from "@paperclipai/db";
import { companySkillRoutes } from "../routes/company-skills.js";
import { folderService } from "../services/folders.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("GET /api/companies/:companyId/skills statements per request", () => {
  const ctx = useEmbeddedPostgres("company-skills-list-statements-");

  function meter() {
    const { host, port } = (ctx.db.$client as unknown as { options: { host: string[]; port: number[] } }).options;
    return meterDatabaseStatements(ctx.db, `postgres://${host[0]}:${port[0]}/skills`);
  }

  const bundledFolders = (companyId: string) => ctx.db.select().from(folders)
    .where(and(eq(folders.companyId, companyId), like(folders.systemKey, "bundled%")));

  it("lists skills with plain reads once the bundled folders exist", async () => {
    const statements = meter();
    try {
      const company = await seedCompanyWithBoardAccess(ctx.db, "Skills list");
      const app = routeApp(ctx.db, company.actor, (db) => companySkillRoutes(db));
      const first = await request(app).get(`/api/companies/${company.companyId}/skills`).expect(200);
      expect(first.body.length).toBeGreaterThan(0);
      const foldersAfterFirst = await bundledFolders(company.companyId);

      const before = statements.read();
      statements.startLog();
      const second = await request(app).get(`/api/companies/${company.companyId}/skills`).expect(200);
      const log = statements.stopLog();
      const after = statements.read();

      expect(second.body).toEqual(first.body);
      expect(after.transactions - before.transactions).toBe(0);
      expect(log.filter((entry) => /pg_advisory/.test(entry.sql))).toEqual([]);
      expect(after.statements - before.statements).toBeLessThanOrEqual(45);
      expect(await bundledFolders(company.companyId)).toEqual(foldersAfterFirst);
    } finally {
      statements.uninstall();
    }
  }, 60_000);

  it("creates exactly one folder when two first requests ensure the same category at once", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Skills race");
    const [left, right] = await Promise.all([
      folderService(ctx.db).ensureBundledCategory(company.companyId, "Race Category"),
      folderService(ctx.db).ensureBundledCategory(company.companyId, "Race Category"),
    ]);
    expect(left.id).toBe(right.id);
    const rows = await bundledFolders(company.companyId);
    expect(rows.filter((row) => row.systemKey === "bundled:race-category")).toHaveLength(1);
    expect(rows.filter((row) => row.systemKey === "bundled")).toHaveLength(1);

    const app = routeApp(ctx.db, company.actor, (db) => companySkillRoutes(db));
    await Promise.all([
      request(app).get(`/api/companies/${company.companyId}/skills`).expect(200),
      request(app).get(`/api/companies/${company.companyId}/skills`).expect(200),
    ]);
    const systemKeys = (await bundledFolders(company.companyId)).map((row) => row.systemKey);
    expect(new Set(systemKeys).size).toBe(systemKeys.length);
  }, 60_000);

  it("still renames a changed category and prunes an empty one under the lock", async () => {
    const statements = meter();
    try {
      const company = await seedCompanyWithBoardAccess(ctx.db, "Skills repair");
      const svc = folderService(ctx.db);
      const locked = async (write: () => Promise<unknown>) => {
        const before = statements.read();
        statements.startLog();
        await write();
        const log = statements.stopLog();
        const lockIndex = log.findIndex((entry) => /pg_advisory_xact_lock/.test(entry.sql));
        const writes = log.filter((entry) => /^\s*(insert|update|delete)\b/i.test(entry.sql));
        return {
          transactions: statements.read().transactions - before.transactions,
          lockedBeforeWrite: lockIndex >= 0 && writes.every((entry) => entry.inTransaction && log.indexOf(entry) > lockIndex),
          writes: writes.length,
        };
      };

      const created = await locked(() => svc.ensureBundledCategory(company.companyId, "Repair Category"));
      expect(created).toMatchObject({ transactions: 1, lockedBeforeWrite: true });
      expect(created.writes).toBeGreaterThan(0);
      const [category] = (await bundledFolders(company.companyId)).filter((row) => row.systemKey === "bundled:repair-category");
      await ctx.db.update(folders).set({ name: "Renamed by hand" }).where(eq(folders.id, category!.id));
      const renamed = await locked(() => svc.ensureBundledCategory(company.companyId, "Repair Category"));
      expect(renamed).toMatchObject({ transactions: 1, lockedBeforeWrite: true, writes: 1 });
      expect((await bundledFolders(company.companyId)).find((row) => row.id === category!.id)?.name).toBe("Repair Category");

      expect(await locked(() => svc.pruneEmptyBundledCategories(company.companyId, ["Repair Category"])))
        .toEqual({ transactions: 0, lockedBeforeWrite: false, writes: 0 });
      expect((await bundledFolders(company.companyId)).map((row) => row.id)).toContain(category!.id);
      expect(await locked(() => svc.pruneEmptyBundledCategories(company.companyId, [])))
        .toEqual({ transactions: 1, lockedBeforeWrite: true, writes: 1 });
      expect((await bundledFolders(company.companyId)).map((row) => row.id)).not.toContain(category!.id);
    } finally {
      statements.uninstall();
    }
  }, 60_000);
});
