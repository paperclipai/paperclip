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
    const company = await seedCompanyWithBoardAccess(ctx.db, "Skills repair");
    const svc = folderService(ctx.db);
    const category = await svc.ensureBundledCategory(company.companyId, "Repair Category");
    await ctx.db.update(folders).set({ name: "Renamed by hand" }).where(eq(folders.id, category.id));
    const repaired = await svc.ensureBundledCategory(company.companyId, "Repair Category");
    expect(repaired).toMatchObject({ id: category.id, name: "Repair Category" });

    await svc.pruneEmptyBundledCategories(company.companyId, ["Repair Category"]);
    expect((await bundledFolders(company.companyId)).map((row) => row.id)).toContain(category.id);
    await svc.pruneEmptyBundledCategories(company.companyId, []);
    expect((await bundledFolders(company.companyId)).map((row) => row.id)).not.toContain(category.id);
  }, 60_000);
});
