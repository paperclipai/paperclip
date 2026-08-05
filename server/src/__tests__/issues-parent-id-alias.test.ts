import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

/**
 * Mirrors the parent-id alias resolution that `server/src/routes/issues.ts`
 * applies in `listFilters` and `blockedCountFilters`. Refs #3846.
 */
function buildApp() {
  const app = express();
  app.get("/api/companies/:companyId/issues", (req, res) => {
    const parentId = (req.query.parentId ?? req.query.parentIssueId) as string | undefined;
    res.status(200).json({ parentId: parentId ?? null });
  });
  return app;
}

describe("issue list parent id query alias", () => {
  it("resolves ?parentId=", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?parentId=issue-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parentId: "issue-1" });
  });

  it("resolves ?parentIssueId= as an alias", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?parentIssueId=issue-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parentId: "issue-1" });
  });

  it("prefers ?parentId= when both spellings are present", async () => {
    const res = await request(buildApp()).get(
      "/api/companies/c1/issues?parentId=issue-1&parentIssueId=issue-2",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parentId: "issue-1" });
  });

  it("leaves the filter unset when neither spelling is present", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parentId: null });
  });
});
