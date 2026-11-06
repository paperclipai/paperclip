// Run against an explicitly selected installed release and disposable database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const install = process.env.PAPERCLIP_BACKPORT_INSTALL;
assert.ok(install && path.isAbsolute(install), "Select an absolute installation");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "resume-readiness-home-"));
process.env.PAPERCLIP_HOME = home;
process.env.PAPERCLIP_INSTANCE_ID = "regression";
process.env.PAPERCLIP_CONFIG = path.join(home, "config.json");
const load = (file) => import(pathToFileURL(path.join(install, "node_modules", file)));
const schema = await load("@paperclipai/db/dist/index.js");
const { startEmbeddedPostgresTestDatabase } = await load("@paperclipai/db/dist/test-embedded-postgres.js");
const { issueService } = await load("@paperclipai/server/dist/services/issues.js");
const { issueRoutes } = await load("@paperclipai/server/dist/routes/issues.js");
const { actorMiddleware } = await load("@paperclipai/server/dist/middleware/auth.js");
const { errorHandler } = await load("@paperclipai/server/dist/middleware/error-handler.js");
const require = createRequire(path.join(install, "node_modules/@paperclipai/server/package.json"));
const express = require("express");

test("resume evaluates the requested dependency list through HTTP", { timeout: 120000 }, async (t) => {
  const database = await startEmbeddedPostgresTestDatabase("resume-readiness-db-");
  const db = schema.createDb(database.connectionString);
  let http;
  try {
    const companyId = randomUUID();
    await db.insert(schema.companies).values({ id: companyId, name: "Resume regression", issuePrefix: "REG" });
    const svc = issueService(db);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {}));
    app.use(errorHandler);
    http = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => http.once("listening", resolve));
    const request = async (route, data, method = "PATCH") => {
      const response = await fetch(`http://127.0.0.1:${http.address().port}/api${route}`, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify(data),
      });
      return { status: response.status, body: await response.json() };
    };
    const blocker = await svc.create(companyId, { title: "Unresolved", status: "todo" });
    const done = await svc.create(companyId, { title: "Resolved", status: "done" });
    const cancelled = await svc.create(companyId, { title: "Cancelled", status: "cancelled" });
    const fixture = () => svc.create(companyId, { title: "Blocked", status: "blocked", blockedByIssueIds: [blocker.id] });
    for (const ids of [[], [done.id, cancelled.id]]) {
      await t.test(`combined PATCH accepts ${ids.length} resolved blockers`, async () => {
        const issue = await fixture();
        const response = await request(`/issues/${issue.id}`, { blockedByIssueIds: ids, status: "todo", resume: true, comment: "Dependency repaired" });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.status, "todo");
        const relations = await db.select().from(schema.issueRelations);
        assert.deepEqual(relations.filter((row) => row.relatedIssueId === issue.id && row.type === "blocks").map((row) => row.issueId).sort(), [...ids].sort());
      });
    }
    for (const extra of [{}, { blockedByIssueIds: [blocker.id] }]) {
      await t.test(`unresolved blockers reject ${JSON.stringify(extra)}`, async () => {
        const issue = await fixture();
        const response = await request(`/issues/${issue.id}`, { ...extra, status: "todo", resume: true, comment: "Still blocked" });
        assert.equal(response.status, 409);
        assert.equal(response.body.error, "Issue follow-up blocked by unresolved blockers");
        assert.equal((await svc.getById(issue.id)).status, "blocked");
      });
    }
    await t.test("checkout remains blocked by persisted dependencies", async () => {
      const issue = await fixture();
      const [agent] = await db.insert(schema.agents).values({ companyId, name: "Fixture", role: "engineer", adapterType: "process" }).returning();
      const response = await request(`/issues/${issue.id}/checkout`, { agentId: agent.id, expectedStatuses: ["blocked"], blockedByIssueIds: [] }, "POST");
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.equal((await svc.getDependencyReadiness(issue.id)).unresolvedBlockerCount, 1);
    });
    await t.test("checkout ownership conflicts still return 409", async () => {
      const agents = await db.insert(schema.agents).values(["Owner", "Contender"].map((name) => ({ companyId, name, role: "engineer", adapterType: "process" }))).returning();
      const issue = await svc.create(companyId, { title: "Owned", status: "todo", assigneeAgentId: agents[0].id });
      const response = await request(`/issues/${issue.id}/checkout`, { agentId: agents[1].id, expectedStatuses: ["todo"] }, "POST");
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal((await svc.getById(issue.id)).assigneeAgentId, agents[0].id);
    });
  } finally {
    if (http) await new Promise((resolve) => http.close(resolve));
    await database.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  }
});
