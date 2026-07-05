import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseStatusFilter } from "../services/issues.ts";

/**
 * Regression test for https://github.com/paperclipai/paperclip/issues/4628
 *
 * Stands up a minimal Express app whose handler mirrors the parsing path
 * `server/src/routes/issues.ts:957-958` uses to forward `req.query.status`
 * into `issueService.list({ status })`. Verifies the four shapes Express's
 * default `qs` parser can produce all normalize correctly and none crash:
 *
 *   1. Single value         — `?status=todo`
 *   2. Comma-separated      — `?status=todo,in_progress`        (legacy)
 *   3. Repeated key (array) — `?status=todo&status=in_progress` (the bug)
 *   4. Mixed array + CSV    — `?status=todo,in_progress&status=done`
 *
 * Pre-fix, case 3 returned HTTP 500 with `TypeError: filters.status.split is
 * not a function`. We don't spin embedded-postgres here; the helper itself is
 * unit-tested in `parse-status-filter.test.ts`, and the route→helper contract
 * is what regresses if anyone reverts the fix.
 */

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/companies/:companyId/issues", (req, res) => {
    // Mirror the cast at routes/issues.ts:958 exactly. Pre-fix this said
    // `as string | undefined` and the cast was a lie when qs returned an array.
    const statusInput = req.query.status as string | string[] | undefined;
    const statuses = parseStatusFilter(statusInput);
    res.status(200).json({ statuses });
  });
  return app;
}

describe("issue list status query parsing", () => {
  it("accepts a single ?status=todo and returns one normalized status", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?status=todo");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statuses: ["todo"] });
  });

  it("accepts comma-separated ?status=todo,in_progress (preserves legacy CSV)", async () => {
    const res = await request(buildApp()).get(
      "/api/companies/c1/issues?status=todo,in_progress",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statuses: ["todo", "in_progress"] });
  });

  it("accepts repeated ?status=todo&status=in_progress without crashing (the bug fix)", async () => {
    const res = await request(buildApp()).get(
      "/api/companies/c1/issues?status=todo&status=in_progress",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statuses: ["todo", "in_progress"] });
  });

  it("accepts mixed array + CSV ?status=todo,in_progress&status=done", async () => {
    const res = await request(buildApp()).get(
      "/api/companies/c1/issues?status=todo,in_progress&status=done",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statuses: ["todo", "in_progress", "done"] });
  });

  it("accepts no ?status param and returns an empty status filter", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statuses: [] });
  });
});
