import { writeFileSync } from "node:fs";
import request from "supertest";
import { expect, it } from "vitest";
import { boardCensusRoutes, boardSessionApp, seedBoardRouteFixture } from "./helpers/route-census-fixture.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { createStatementCensus, formatStatementCensus } from "./helpers/statement-census.js";

describeEmbeddedPostgres("board route statement census", () => {
  const ctx = useEmbeddedPostgres("board-route-census-");

  it("answers every polled and page-load board route and reports statements per request", async () => {
    const census = createStatementCensus(ctx.db);
    try {
      const fixture = await seedBoardRouteFixture(ctx.db, "Census");
      const app = boardSessionApp(ctx.db, () => fixture.userId);
      const report: string[] = [];
      for (const [label, path] of boardCensusRoutes(fixture)) {
        const warm = await request(app).get(path);
        expect(warm.status, `${label}: ${JSON.stringify(warm.body)}`).toBe(200);
        const measured = await census.measure(() => request(app).get(path).expect(200), { stacks: true });
        expect(measured.statements, label).toBeGreaterThan(0);
        report.push(formatStatementCensus(label, measured, Number(process.env.PAPERCLIP_STATEMENT_CENSUS_TOP ?? 5)));
      }
      if (process.env.PAPERCLIP_STATEMENT_CENSUS) writeFileSync(process.env.PAPERCLIP_STATEMENT_CENSUS, `${report.join("\n\n")}\n`);
    } finally {
      census.uninstall();
    }
  }, 120_000);
});
