import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import type { CompanySearchQuery, CompanySearchResponse } from "@paperclipai/shared";

function createSearchResponse(query: CompanySearchQuery): CompanySearchResponse {
  return {
    query: query.q,
    normalizedQuery: query.q.trim().toLowerCase(),
    scope: query.scope,
    limit: query.limit,
    offset: query.offset,
    results: [],
    countsByType: { issue: 0, agent: 0, project: 0 },
    hasMore: false,
  };
}

describe("company search route rate limiting", () => {
  it("rejects repeated same-actor search calls before invoking search", async () => {
    const search = vi.fn(async (_companyId: string, query: CompanySearchQuery) => createSearchResponse(query));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      };
      next();
    });
    app.use("/api", issueRoutes({} as never, {} as never, {
      searchService: { search },
      searchRateLimiter: createCompanySearchRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    }));

    await request(app).get("/api/companies/company-1/search?q=wizard").expect(200);
    const limited = await request(app).get("/api/companies/company-1/search?q=wizard").expect(429);

    expect(search).toHaveBeenCalledTimes(1);
    expect(limited.body).toMatchObject({
      error: "Search rate limit exceeded",
      retryAfterSeconds: 60,
    });
    expect(limited.headers["retry-after"]).toBe("60");
  });
});
