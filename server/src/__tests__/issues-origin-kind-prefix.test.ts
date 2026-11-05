import { expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
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
});
