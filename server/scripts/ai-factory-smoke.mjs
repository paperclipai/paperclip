// AI factory E2E smoke test. See AI_FACTORY_E2E_SMOKE.md.
// Prereqs: local dev stack running (pnpm dev), at least one auth user.
// Run: cd server && pnpm exec tsx scripts/ai-factory-smoke.mjs
import { createDb } from "@paperclipai/db";
import { costEvents, issues as issuesTable } from "@paperclipai/db";
import { like } from "drizzle-orm";
import { issueService } from "../src/services/issues.js";
import { workProductService } from "../src/services/work-products.js";
import { budgetService } from "../src/services/budgets.js";
import { boardAuthService } from "../src/services/board-auth.js";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3100";
const DB_URL = process.env.SMOKE_DB_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

const db = createDb(DB_URL);
const company = (await db.query.companies.findMany())[0];
const agent = (await db.query.agents.findMany()).find((a) => a.name !== "CEO");
const user = (await db.query.authUsers.findMany())[0];
if (!company || !agent || !user) throw new Error("Need a company, an agent, and one auth user in the local DB");

const issues = issueService(db);
const workProducts = workProductService(db);
const budgets = budgetService(db);

const results = [];
const check = (name, ok, detail) => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);

// Temporary board API key for the HTTP intake call; revoked in cleanup.
const boardAuth = boardAuthService(db);
const key = await boardAuth.createNamedBoardApiKey({ userId: user.id, name: "ai-factory-smoke" });
const token = key.token;

const sourceRef = `https://github.com/smoke/repo/issues/${Date.now()}`;
try {
  // 1-2. Intake over real HTTP: GitHub payload defaults requiredWorkProductType=pull_request.
  const res = await fetch(`${BASE_URL}/api/webhooks/intake/${company.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      action: "opened",
      issue: { title: "SMOKE E2E factory loop", body: "from smoke test", html_url: sourceRef },
    }),
  });
  const created = await res.json();
  check("1. webhook intake creates issue (HTTP 201)", res.status === 201, `status ${res.status}`);
  const issue = await issues.getById(created.issue.id);
  await issues.update(issue.id, { maxCostCents: 5 }); // small cap for step 7
  check(
    "2. issue is backlog + requiredWorkProductType=pull_request + maxCostCents set",
    issue.status === "backlog" && issue.requiredWorkProductType === "pull_request",
  );

  // Redelivery dedupe (same sourceRef) returns the existing issue.
  const res2 = await fetch(`${BASE_URL}/api/webhooks/intake/${company.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ issue: { title: "SMOKE E2E factory loop", html_url: sourceRef } }),
  });
  const redelivered = await res2.json();
  check("2b. duplicate webhook deduplicated", redelivered.deduplicated === true && redelivered.issue.id === issue.id);

  // 3. Close without work product must fail.
  try {
    await issues.update(issue.id, { status: "done" });
    check("3. close without work product rejected", false, "unexpectedly succeeded");
  } catch (e) {
    check("3. close without work product rejected", /requires an accepted 'pull_request'/.test(e.message));
  }

  // 4-5. Merged PR work product, then close passes.
  await workProducts.createForIssue(issue.id, company.id, {
    type: "pull_request",
    provider: "github",
    title: "SMOKE PR",
    status: "merged",
    reviewState: "none",
  });
  const closed = await issues.update(issue.id, { status: "done" });
  check("4-5. close with merged pull_request work product", closed?.status === "done");

  // 6. Agent cannot clear/change the required type.
  const issue2res = await fetch(`${BASE_URL}/api/webhooks/intake/${company.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ issue: { title: "SMOKE E2E waive attempt", html_url: `${sourceRef}-2` } }),
  });
  const issue2 = (await issue2res.json()).issue;
  try {
    await issues.update(issue2.id, { requiredWorkProductType: null, status: "done", actorAgentId: agent.id });
    check("6. agent clearing requiredWorkProductType rejected", false, "unexpectedly succeeded");
  } catch (e) {
    check("6. agent clearing requiredWorkProductType rejected", /only a human/.test(e.message));
  }

  // 7. Cost cap blocks further work once spend exceeds maxCostCents.
  await issues.update(issue2.id, { maxCostCents: 5 });
  await db.insert(costEvents).values({
    companyId: company.id,
    agentId: agent.id,
    issueId: issue2.id,
    provider: "smoke",
    model: "smoke",
    costCents: 10,
    occurredAt: new Date(),
  });
  const block = await budgets.getInvocationBlock(company.id, agent.id, { issueId: issue2.id });
  check(
    "7. cost cap blocks invocation after spend exceeds cap",
    block?.scopeType === "issue" && block?.scopeId === issue2.id,
    block ? `${block.scopeType}: ${block.reason}` : "no block returned",
  );
} finally {
  // Cleanup: revoke the temp key, hide smoke issues.
  await boardAuth.revokeBoardApiKey(key.id);
  await db.update(issuesTable).set({ hiddenAt: new Date() }).where(like(issuesTable.title, "SMOKE E2E%"));
}

console.log("\n" + results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
