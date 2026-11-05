import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, companies, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { expect, it } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { heartbeatService } from "../heartbeat.js";
import { issueService } from "../issues.js";
import { instanceSettingsService } from "../instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "./native-session-executor.js";

it.skipIf(process.env.PAPERCLIP_LIVE_WORKSPACE_DISCOVERY !== "true")("settles workspace discovery and resumes a second real Codex turn", async () => {
  const home = createIsolatedTestHome();
  const keys = ["PAPERCLIP_HOME", "CODEX_HOME", "PAPERCLIP_API_URL", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TELEMETRY_DISABLED"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  try {
    const codexHome = join(home.home, "codex");
    await mkdir(codexHome, { mode: 0o700 });
    await copyFile(join(process.env.PAPERCLIP_LIVE_CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(codexHome, "auth.json"));
    process.env.CODEX_HOME = codexHome;
    process.env.PAPERCLIP_HOME = join(home.home, "instance");
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    process.env.PAPERCLIP_TELEMETRY_DISABLED = "1";
    server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
    process.env.PAPERCLIP_API_URL = server.apiUrl;
    const f = await server.fixture({ connectionScenario: "fresh" });
    const db = server.db;
    await db.insert(executionWorkspaces).values(Array.from({ length: 2_000 }, (_, index) => ({ companyId: f.companyId,
      name: `Workspace ${index}`, mode: "shared_workspace", strategyType: "task_directory", cwd: `/tmp/${"repository/".repeat(20)}${index}` })));
    await db.update(issues).set({ executionRunId: null, executionWorkspaceSettings: { mode: "shared_workspace" },
      title: "Verify paged workspace discovery", description: "Follow each latest comment. Use list_workspaces twice: request limit 2, then request limit 2 with its nextCursor. Confirm both pages have two distinct workspace IDs and hasMore true. Follow the comment's file step and finish this step with paperclip_finish, reportedWorkDisposition done. No external services or public writes are needed.",
    }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(companies).set({ defaultResponsibleUserId: f.userId }).where(eq(companies.id, f.companyId));
    await db.update(agents).set({ adapterConfig: { provider: "codex", model: "gpt-6.1-sol", modelReasoningEffort: "high",
      cwd: f.workspace, workspaceStrategy: { type: "project_primary" }, env: { CODEX_HOME: codexHome }, timeoutSec: 180, lifecycleMode: "per_turn" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, f.agentId));
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
    const service = issueService(db), markers = [randomUUID(), randomUUID()];
    const completed: Array<{ runId: string; sessionId: string | null; providerSessionId: string | null; toolCalls: number }> = [];
    for (const [index, marker] of markers.entries()) {
      await service.update(f.issueId, { status: "todo", actorUserId: f.userId! });
      const comment = await service.addComment(f.issueId, index === 0
        ? `After verifying the two workspace pages, write exactly ${marker} and a newline to discovery.txt. Read it and finish.`
        : `After verifying the two workspace pages, append exactly ${marker} and a newline once to discovery.txt. Preserve and read its existing line, then finish.`, { userId: f.userId! });
      const run = await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_reopened_via_comment",
        requestedByActorType: "user", requestedByActorId: f.userId,
        payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment", reopenedFrom: "done" },
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeCommentId: comment.id, skipIssueComment: true },
      });
      expect(run?.id).toBeTruthy();
      await heartbeat.drainActiveRunExecutions();
      const after = await heartbeat.getRun(run!.id);
      expect({ status: after?.status, errorCode: after?.errorCode, error: after?.error }).toMatchObject({ status: "succeeded", errorCode: null });
      expect(after?.resultJson?.recoveredExecutionFailure).toBeUndefined();
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run!.id));
      const calls = events.filter(event => event.eventType === "tool.execution.started" && JSON.stringify(event.payload).includes('"list_workspaces"'));
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(await readFile(join(f.workspace, "discovery.txt"), "utf8")).toBe(markers.slice(0, index + 1).join("\n") + "\n");
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task).toMatchObject({ status: "done", executionRunId: null, checkoutRunId: null });
      completed.push({ runId: run!.id, sessionId: after!.nativeSessionId, providerSessionId: after!.sessionIdAfter, toolCalls: calls.length });
    }
    expect(completed[1].providerSessionId).toBe(completed[0].providerSessionId);
    const evidence = { passed: true, model: "gpt-6.1-sol", effort: "high", lifecycleMode: "per_turn",
      platform: `${process.platform}-${process.arch}`, inventory: 2_000, completed, fileLines: 2, taskStatus: "done", locksCleared: true };
    if (process.env.PAPERCLIP_LIVE_EVIDENCE_PATH) await writeFile(process.env.PAPERCLIP_LIVE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence));
  } finally {
    await heartbeat?.drainActiveRunExecutions();
    await closeIdleWarmNativeSessionsForRestart();
    await server?.close();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    home.cleanup();
  }
}, 600_000);
