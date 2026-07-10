import { describe, expect, it, vi } from "vitest";
import { analyticsService } from "../services/analytics.js";

function renderSql(query: { toQuery: (config: unknown) => { sql: string } }) {
  return query.toQuery({
    escapeName: (name: string) => `"${name}"`,
    escapeParam: (index: number) => `$${index + 1}`,
    escapeString: (value: string) => `'${value.replaceAll("'", "''")}'`,
  }).sql;
}

describe("analyticsService", () => {
  it("uses tenant-scoped joins and NULL-safe group matching for model usage", async () => {
    let capturedQuery: { toQuery: (config: unknown) => { sql: string } } | undefined;
    const db = {
      execute: vi.fn(async (query) => {
        capturedQuery = query;
        return [];
      }),
    };

    await analyticsService(db as never).modelUsage("company-1", { groupBy: "model" });

    expect(db.execute).toHaveBeenCalledOnce();
    expect(capturedQuery).toBeDefined();
    const querySql = renderSql(capturedQuery!);
    expect(querySql).toMatch(/LEFT JOIN agents a ON ce\.agent_id = a\.id AND a\.company_id = \$\d+/);
    expect(querySql).toMatch(
      /LEFT JOIN heartbeat_runs hr ON ce\.heartbeat_run_id = hr\.id AND hr\.company_id = \$\d+/,
    );
    expect(querySql).toContain("ra.model IS NOT DISTINCT FROM ca.model");
    expect(querySql).toContain("ra.provider IS NOT DISTINCT FROM ca.provider");
  });
});
