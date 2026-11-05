import request from "supertest";
import { expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue origin kind prefix", () => {
  const ctx = useEmbeddedPostgres("paperclip-origin-prefix-", {
    resetEach: resetCompanyIssueFixtures,
  });

  for (const attention of [undefined, "blocked"] as const) {
    for (const method of ["list", "count"] as const) {
      it.each(["%", "_", "plugin:sample_", "plugin:sample%", "plugin:sample\\", "plugin:", ""])(
        `${method} matches literal prefix %j with attention ${attention}`,
        async (prefix) => {
          const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Origin prefix");
          const other = await seedCompanyWithBoardAccess(ctx.db, "Other origins");
          const originKinds = [
            "%literal", "_literal", "manual", "plugin:sample_task",
            "plugin:sampleXtask", "plugin:sample%task", "plugin:sample\\task",
            "plugin:sample_task:child", "plugin:other",
          ];
          const rows = await ctx.db.insert(issues).values(originKinds.map((originKind) => ({
            companyId, title: originKind, originKind, status: "blocked",
          }))).returning();
          await ctx.db.insert(issues).values({
            companyId: other.companyId, title: "Other company", originKind: `${prefix}other`, status: "blocked",
          });
          const expected = rows.filter((row) => row.originKind!.startsWith(prefix));
          const svc = issueService(ctx.db);
          const filters = { originKindPrefix: prefix, attention, includeRoutineExecutions: true };
          if (method === "count") {
            expect(await svc.count(companyId, filters)).toBe(expected.length);
          } else {
            const result = await svc.list(companyId, filters);
            expect(result.map((row) => row.id).sort()).toEqual(expected.map((row) => row.id).sort());
          }
        },
      );
    }
  }

  async function seedRepeatedPrefixRoute() {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Repeated origin prefix");
    const [joined] = await ctx.db.insert(issues).values(["plugin:a,plugin:b", "plugin:a", "plugin:b"].map((originKind) => ({
      companyId, title: originKind, originKind, status: "blocked",
    }))).returning();
    return { companyId, app: routeApp(ctx.db, actor, issueRoutes), joinedId: joined!.id };
  }

  it.each(["", "&attention=blocked"])("list route joins repeated prefixes with commas (%s)", async (attention) => {
    const { companyId, app, joinedId } = await seedRepeatedPrefixRoute();
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues?originKindPrefix=plugin:a&originKindPrefix=plugin:b${attention}`)
      .expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id)).toEqual([joinedId]);
  });

  it("count route joins repeated prefixes with commas", async () => {
    const { companyId, app } = await seedRepeatedPrefixRoute();
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues/count?attention=blocked&originKindPrefix=plugin:a&originKindPrefix=plugin:b`)
      .expect(200);
    expect(res.body).toEqual(expect.objectContaining({ count: 1 }));
  });
});
