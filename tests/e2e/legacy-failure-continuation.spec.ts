import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIResponse } from "@playwright/test";
import { and, eq } from "../../server/node_modules/drizzle-orm/index.js";
import { createDb, closeRegisteredClients, heartbeatRuns, issueRecoveryActions, issues, issueComments, agentWakeupRequests, authUsers, companyMemberships } from "../../packages/db/src/index.ts";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

for (const action of ["task_retry", "thread_retry", "inbox_retry", "message", "queued_interrupt", "automatic_message"] as const) {
  test(`legacy startup hold: ${action} reaches a new agent response`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(path.join(os.tmpdir(), "legacy-recovery-browser-"));
    const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
    // Use the running test server's actual port, including fallback allocation.
    const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
    const url = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
    const db = createDb(url);
    const company = await json(await request.post("/api/companies", { data: { name: `Legacy recovery ${action} ${Date.now()}` } }));
    try {
      await writeFile(path.join(root, "continued"), "ready");
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "Recovery fixture", role: "engineer", adapterType: "claude_local",
        adapterConfig: { engine: "acp", cwd: root, stateDir: path.join(root, "state"),
          agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs"))}`,
          env: { PAPERCLIP_STOP_FIXTURE_ROOT: root, PAPERCLIP_STOP_FIXTURE_FINISH_TASK: "1" } },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      } }));
      const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "Continue after startup failure", description: "Answer the pending follow-up once.",
        status: "backlog", assigneeAgentId: agent.id,
      } }));
      const sourceRunId = randomUUID();
      // Seed the historical incident, then exercise all recovery through the UI.
      // No adapter.invoke or new dispatch identity exists on this pre-upgrade run.
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: company.id, agentId: agent.id,
        status: "failed", runtimeMode: "legacy", processPid: action === "queued_interrupt" ? process.pid : 999999999,
        responsibleUserId: issue.responsibleUserId, errorCode: "process_lost", error: "Server restarted during startup",
        startedAt: new Date(Date.now() - 10_000), finishedAt: new Date(Date.now() - 5_000),
        contextSnapshot: { issueId: issue.id },
      });
      await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: issue.id,
        kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId,
        status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
        evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issue.id));
      if (action === "queued_interrupt") {
        await db.insert(authUsers).values({ id: "original-board", name: "Original author", email: "original-author@example.test",
          createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
        await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user",
          principalId: "original-board", membershipRole: "operator", status: "active" });
      }
      if (action === "queued_interrupt" || action === "automatic_message") {
        const commentId = randomUUID();
        // Reproduce a real user comment saved while the failed run was active,
        // including queues originally created by a system wake.
        await db.insert(issueComments).values({ id: commentId, companyId: company.id, issueId: issue.id,
          authorType: "user", authorUserId: action === "queued_interrupt" ? "original-board" : "local-board", body: "Approved",
          createdAt: new Date(Date.now() - 8_000),
        });
        await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id,
          source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
          requestedByActorType: "system", payload: { issueId: issue.id, commentId,
            _paperclipWakeContext: { issueId: issue.id, wakeCommentIds: [commentId], wakeCommentId: commentId } },
        });
      }
      const taskUrl = `/${company.issuePrefix}/issues/${issue.identifier}`;
      await page.goto(action === "inbox_retry" ? `/${company.issuePrefix}/inbox/all` : taskUrl);
      if (action === "task_retry") {
        const notice = page.getByRole("status", { name: "Task recovery" });
        await expect(notice).toHaveText("Automatic recovery of this task stopped.Retry");
        await expect(notice.getByRole("link")).toHaveCount(0);
        const presentation = await notice.evaluate(element => {
          const style = getComputedStyle(element);
          return { border: style.borderTopWidth, background: style.backgroundColor };
        });
        expect(parseFloat(presentation.border)).toBeGreaterThan(0);
        expect(presentation.background).not.toBe("rgba(0, 0, 0, 0)");
        await test.info().attach("recovery-notice", { body: await notice.screenshot(), contentType: "image/png" });
      }
      if (action === "queued_interrupt") {
        const interrupt = page.getByRole("button", { name: "Interrupt", exact: true });
        await expect(interrupt).toBeEnabled();
        await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, sourceRunId));
        await interrupt.click();
      } else if (action === "automatic_message") {
        // No Retry, duplicate message, or status change: the saved input runs.
      } else if (action === "message") {
        await page.getByRole("textbox", { name: "editable markdown" }).fill("Please continue the pending follow-up.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
      } else {
        await page.getByRole("button", { name: action === "thread_retry" ? "Try again" : "Retry", exact: true }).click();
        if (action === "inbox_retry") await page.goto(taskUrl);
      }
      await expect(page.getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible({ timeout: 45_000 });
      await expect(page.getByRole("status", { name: "Task recovery" })).toHaveCount(0);
      const completed = await json(await request.get(`/api/issues/${issue.id}`));
      expect(completed).toMatchObject({ status: "done", executionBlocker: null });
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.agentId, agent.id)));
      expect(runs.filter(run => run.id !== sourceRunId)).toHaveLength(1);
      expect(runs.find(run => run.id === sourceRunId)).toMatchObject({ status: "failed", resultJson: null });
      const prompts = await readFile(path.join(root, "prompts"), "utf8");
      if (action === "queued_interrupt" || action === "automatic_message") {
        expect(prompts).toContain("Approved");
        await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toHaveCount(0);
      }
      if (action === "message") expect(prompts).toContain("Please continue the pending follow-up.");
      await page.reload();
      await expect(page.getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible();
    } finally {
      await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
      await closeRegisteredClients(url);
      await rm(root, { recursive: true, force: true });
    }
  });
}
