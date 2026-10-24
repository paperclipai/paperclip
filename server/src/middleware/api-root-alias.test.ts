import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  createApiBaseRewriteGuard,
  isApiShapedRootPath,
  type ApiBaseRewriteGuard,
} from "./api-root-alias.js";

// These cases mirror the eleven the production hotfix was verified with. Each
// block builds its own guard with a temp ledger, so the suite is hermetic and can
// never append to the live ~/.paperclip ledger.

interface TestApp {
  app: express.Express;
  guard: ApiBaseRewriteGuard;
  ledgerPath: string;
  seen: Array<{ route: string; params: Record<string, string>; body: Record<string, unknown> }>;
  dir: string;
}

const dirs: string[] = [];

function buildApp(options: { now?: () => number } = {}): TestApp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-root-alias-"));
  dirs.push(dir);
  const ledgerPath = path.join(dir, "state", "api-base-rewrites.jsonl");
  const guard = createApiBaseRewriteGuard({ ledgerPath, now: options.now });
  const seen: TestApp["seen"] = [];

  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.post("/companies/:companyId/issues", (req, res) => {
    seen.push({ route: "canonical-create", params: req.params, body: req.body ?? {} });
    res.status(201).json({ created: true, companyId: req.params.companyId, body: req.body ?? {} });
  });
  api.post("/issues/:id/comments", (req, res) => {
    seen.push({ route: "comment", params: req.params, body: req.body ?? {} });
    res.status(201).json({ ok: true, body: req.body ?? {} });
  });
  api.patch("/goals/:id", (req, res) => {
    seen.push({ route: "goal-patch", params: req.params, body: req.body ?? {} });
    res.json({ ok: true, change: req.body ?? {} });
  });
  api.get("/issues/:id", (req, res) => res.json({ id: req.params.id }));

  app.use(guard.guard);
  app.get("/api/diagnostics/api-base-rewrites", (_req, res) => res.json(guard.snapshot()));
  app.use("/api", api);
  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
  app.use((_req, res) => res.status(404).type("html").send("<pre>Cannot POST</pre>"));

  return { app, guard, ledgerPath, seen, dir };
}

function ledgerRows(ledgerPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("api-root-alias guard", () => {
  let ctx: TestApp;

  beforeEach(() => {
    ctx = buildApp();
  });

  it("rescues a root POST /issues carrying companyId onto the canonical create route", async () => {
    const res = await request(ctx.app)
      .post("/issues")
      .send({ companyId: "c0", title: "lost report" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: true, companyId: "c0", body: { title: "lost report" } });
    expect(res.headers["x-paperclip-api-base"]).toBe("/api");
    expect(res.headers["x-paperclip-api-base-rewritten"]).toBe("/api/companies/c0/issues");
    expect(ctx.seen[0]).toMatchObject({ route: "canonical-create", params: { companyId: "c0" } });
  });

  it("rescues the POST /api/issues shorthand carrying companyId", async () => {
    const res = await request(ctx.app)
      .post("/api/issues")
      .send({ companyId: "c1", title: "t" });

    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe("c1");
    expect(res.headers["x-paperclip-api-base"]).toBe("/api");
    expect(ctx.seen[0]).toMatchObject({ route: "canonical-create", params: { companyId: "c1" } });
  });

  it("accepts a trailing slash on the shorthand", async () => {
    const res = await request(ctx.app).post("/issues/").send({ companyId: "c1", title: "t" });
    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe("c1");
  });

  it("returns an explicit 400 naming the canonical route when companyId cannot be resolved", async () => {
    const res = await request(ctx.app).post("/issues").send({ title: "t" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "companyId is required to create an issue",
      didYouMean: "POST /api/companies/{companyId}/issues",
    });
    expect(res.body.hint).toContain("X-Paperclip-Company-Id");
    expect(ctx.seen).toHaveLength(0);
  });

  it("resolves companyId from X-Paperclip-Company-Id", async () => {
    const res = await request(ctx.app)
      .post("/api/issues")
      .set("X-Paperclip-Company-Id", "c2")
      .send({ title: "t" });

    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe("c2");
  });

  it("resolves companyId from the query string and keeps the other query params", async () => {
    const res = await request(ctx.app)
      .post("/issues?companyId=c3&view=compact")
      .send({ title: "t" });

    expect(res.status).toBe(201);
    expect(res.headers["x-paperclip-api-base-rewritten"]).toBe(
      "/api/companies/c3/issues?view=compact",
    );
    // The stub reads params from the path, so a leaked ?companyId= would show up
    // as a stray param on the canonical request.
    expect(ctx.seen[0]).toMatchObject({ route: "canonical-create", params: { companyId: "c3" } });
  });

  it("rewrites other API-shaped root mutations onto /api without touching the body", async () => {
    const res = await request(ctx.app).post("/issues/abc/comments").send({ body: "hi" });
    expect(res.status).toBe(201);
    expect(ctx.seen[0]).toMatchObject({ route: "comment", params: { id: "abc" } });
    expect(ctx.seen[0]?.body).toEqual({ body: "hi" });

    const patched = await request(ctx.app).patch("/goals/g1").send({ status: "paused" });
    expect(patched.status).toBe(200);
    expect(ctx.seen[1]).toMatchObject({ route: "goal-patch", params: { id: "g1" } });
    expect(ctx.seen[1]?.body).toEqual({ status: "paused" });
    expect(patched.headers["x-paperclip-api-base-rewritten"]).toBe("/api/goals/g1");
  });

  it("leaves the canonical create route untouched", async () => {
    const res = await request(ctx.app).post("/api/companies/c9/issues").send({ title: "t" });

    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe("c9");
    expect(res.headers["x-paperclip-api-base"]).toBeUndefined();
    expect(ctx.seen[0]).toMatchObject({ route: "canonical-create", params: { companyId: "c9" } });
  });

  it("never rewrites GET, so SPA navigation and API reads are unaffected", async () => {
    const read = await request(ctx.app).get("/api/issues/abc");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ id: "abc" });

    const spa = await request(ctx.app).get("/issues/abc");
    expect(spa.status).toBe(404);
    expect(spa.text).toContain("Cannot POST");

    const snap = await request(ctx.app).get("/api/diagnostics/api-base-rewrites");
    expect(snap.status).toBe(200);
    expect(snap.body.rescues.totalSinceStart).toBe(0);
    expect(ledgerRows(ctx.ledgerPath)).toHaveLength(0);
  });

  it("does not rewrite a UI path or a static asset POST", async () => {
    const ui = await request(ctx.app).post("/some-ui-page");
    expect(ui.status).toBe(404);
    expect(ui.text).toContain("Cannot POST");

    const asset = await request(ctx.app).post("/assets/app.js");
    expect(asset.status).toBe(404);
    expect(asset.text).toContain("Cannot POST");

    expect(ctx.guard.snapshot().rescues.totalSinceStart).toBe(0);
  });

  it("counts rescues exactly and exposes the same numbers on the diagnostics endpoint", async () => {
    await request(ctx.app).post("/issues").send({ companyId: "c0", title: "t" });
    await request(ctx.app).post("/api/issues").send({ companyId: "c1", title: "t" });
    await request(ctx.app).post("/issues").send({ companyId: "c1", title: "t2" });
    await request(ctx.app).post("/api/issues").send({ title: "no company" });
    await request(ctx.app).post("/issues/abc/comments").send({ body: "hi" });

    const snap = await request(ctx.app).get("/api/diagnostics/api-base-rewrites");
    expect(snap.status).toBe(200);
    expect(snap.body.rescues).toMatchObject({
      rootAliasSinceStart: 1,
      createShorthandSinceStart: 3,
      createShorthandUnresolvedSinceStart: 1,
      totalSinceStart: 4,
      byPathSinceStart: { "/issues": 2, "/api/issues": 2, "/issues/abc/comments": 1 },
      byMethodSinceStart: { POST: 5 },
      lastPath: "/issues/abc/comments",
      lastKind: "root-alias",
      lastCompanyId: "c1",
    });
    expect(snap.body.canonicalCreateRoute).toBe("POST /api/companies/{companyId}/issues");
    expect(snap.body.ledgerPath).toBe(ctx.ledgerPath);
  });

  it("writes one ledger row per rescue, including the unresolved one", async () => {
    await request(ctx.app).post("/issues").send({ companyId: "c0", title: "t" });
    await request(ctx.app).post("/api/issues").send({ companyId: "c1", title: "t" });
    await request(ctx.app).post("/issues").send({ title: "no company" });

    const rows = ledgerRows(ctx.ledgerPath);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.kind)).toEqual([
      "create-shorthand",
      "create-shorthand",
      "create-shorthand-unresolved",
    ]);
    expect(rows[0]).toMatchObject({
      path: "/issues",
      rewritten: "/api/companies/c0/issues",
      companyId: "c0",
      method: "POST",
    });
    expect(Number.isFinite(Date.parse(String(rows[0]?.ts)))).toBe(true);
  });

  it("keeps the 24h count across a restart by reading the ledger", async () => {
    await request(ctx.app).post("/issues").send({ companyId: "c0", title: "t" });

    // A fresh guard over the same ledger models the server restarting: in-memory
    // counters reset, the day's history does not.
    const restarted = createApiBaseRewriteGuard({ ledgerPath: ctx.ledgerPath });
    const snap = restarted.snapshot();
    expect(snap.rescues.totalSinceStart).toBe(0);
    expect(snap.rescues.last24h).toBe(1);
    expect(snap.rescues.createShorthandLast24h).toBe(1);
  });

  it("raises the rolling-window alarm at the fifth rescue in ten minutes", async () => {
    let now = Date.parse("2026-10-22T08:00:00.000Z");
    const clocked = buildApp({ now: () => now });

    for (let i = 0; i < 4; i += 1) {
      now += 1000;
      await request(clocked.app).post("/issues").send({ companyId: `c${i}`, title: "t" });
    }
    expect(clocked.guard.snapshot().alarm.active).toBe(false);

    now += 1000;
    await request(clocked.app).post("/issues").send({ companyId: "c4", title: "t" });

    const alarm = clocked.guard.snapshot().alarm;
    expect(alarm.active).toBe(true);
    expect(alarm.threshold).toBe(5);
    expect(alarm.windowMinutes).toBe(10);
    expect(alarm.lastAlarmAt).toBe(new Date(now).toISOString());

    // The alarm tracks the window, so it clears once the burst ages out. The
    // repeat-suppression timestamp stays, so the next burst can alarm again.
    now += 11 * 60 * 1000;
    const cleared = clocked.guard.snapshot().alarm;
    expect(cleared.active).toBe(false);
    expect(cleared.lastAlarmAt).toBe(new Date(Date.parse(alarm.lastAlarmAt ?? "")).toISOString());
  });

  it("serves a redacted snapshot to callers without an operator actor", async () => {
    await request(ctx.app).post("/issues").send({ companyId: "c0", title: "t" });

    const full = ctx.guard.snapshot();
    expect(full.ledgerPath).toBe(ctx.ledgerPath);
    expect(full.rescues.byPathSinceStart).toEqual({ "/issues": 1 });
    expect(full.rescues.lastCompanyId).toBe("c0");

    const publicView = ctx.guard.publicSnapshot();
    expect(publicView.rescues).toMatchObject({
      totalSinceStart: 1,
      createShorthandSinceStart: 1,
      last24h: 1,
    });
    expect(publicView).not.toHaveProperty("ledgerPath");
    expect(publicView.rescues).not.toHaveProperty("byPathSinceStart");
    expect(publicView.rescues).not.toHaveProperty("byPathLast24h");
    expect(publicView.rescues).not.toHaveProperty("lastCompanyId");
    expect(publicView.rescues).not.toHaveProperty("lastPath");
    expect(publicView.canonicalCreateRoute).toBe("POST /api/companies/{companyId}/issues");
  });

  it("does not raise the alarm when the fifth hit falls outside the window", async () => {
    let now = Date.parse("2026-10-22T08:00:00.000Z");
    const clocked = buildApp({ now: () => now });

    for (let i = 0; i < 4; i += 1) {
      now += 1000;
      await request(clocked.app).post("/issues").send({ companyId: `c${i}`, title: "t" });
    }
    now += 11 * 60 * 1000;
    await request(clocked.app).post("/issues").send({ companyId: "c9", title: "t" });

    const snap = clocked.guard.snapshot();
    expect(snap.rescues.createShorthandSinceStart).toBe(5);
    expect(snap.alarm.active).toBe(false);
    expect(snap.rescues.windowCount).toBe(1);
  });
});

describe("isApiShapedRootPath", () => {
  it.each([
    ["/issues", true],
    ["/issues/abc/comments", true],
    ["/companies/c1/issues", true],
    ["/api/issues", false],
    ["/api/companies/c1/issues", false],
    ["/some-ui-page", false],
    ["/assets/app.js", false],
    ["/logo.png", false],
    ["issues", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isApiShapedRootPath(pathname)).toBe(expected);
  });
});
