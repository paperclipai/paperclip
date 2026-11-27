import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, agentTaskSessions, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { expect, it } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { heartbeatService } from "../heartbeat.js";
import { issueService } from "../issues.js";
import { instanceSettingsService } from "../instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "./native-session-executor.js";

it.skipIf(process.env.PAPERCLIP_LIVE_SESSION_EPOCH !== "true")("publishes a fresh live Codex session and resumes its saved file", async () => {
  const home = createIsolatedTestHome(), root = home.home;
  const lifecycleMode = process.env.PAPERCLIP_LIVE_SESSION_LIFECYCLE === "per_turn" ? "per_turn" : "warm";
  const keys = ["PAPERCLIP_HOME", "CODEX_HOME", "PAPERCLIP_API_URL", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TELEMETRY_DISABLED"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  try {
    const codexHome = join(root, "codex");
    await mkdir(codexHome, { mode: 0o700 });
    await copyFile(join(process.env.PAPERCLIP_LIVE_CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(codexHome, "auth.json"));
    await writeFile(join(codexHome, "config.toml"), 'model_reasoning_effort = "low"\n');
    process.env.CODEX_HOME = codexHome;
    process.env.PAPERCLIP_HOME = join(root, "instance");
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    process.env.PAPERCLIP_TELEMETRY_DISABLED = "1";
    server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
    process.env.PAPERCLIP_API_URL = server.apiUrl;
    const fixture = await server.fixture({ connectionScenario: "fresh" });
    const db = server.db;
    await db.update(issues).set({ executionRunId: null, executionWorkspaceSettings: { mode: "shared_workspace" },
      title: "Preserve one verification file across native sessions",
      description: "Follow the latest comment's single file step. The deliverable is epoch.txt in this workspace. Read the file to verify the step. Complete this step with paperclip_finish, reportedWorkDisposition done, and file evidence. Do not do later steps or repeat earlier steps.",
    }).where(eq(issues.id, fixture.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId));
    await db.update(companies).set({ defaultResponsibleUserId: fixture.userId }).where(eq(companies.id, fixture.companyId));
    await db.update(agents).set({ adapterConfig: { provider: "codex", model: "gpt-6.1-sol", modelReasoningEffort: "low",
      cwd: fixture.workspace, workspaceStrategy: { type: "project_primary" }, env: { CODEX_HOME: codexHome }, timeoutSec: 180,
      lifecycleMode, idleTimeoutMs: 900_000 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, fixture.agentId));
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
    const service = issueService(db), markers = [randomUUID(), randomUUID(), randomUUID()];
    const completed: Array<{ runId: string; sessionId: string; providerSessionId: string; publication: unknown }> = [];
    for (const [index, marker] of markers.entries()) {
      await service.update(fixture.issueId, { status: "todo", actorUserId: fixture.userId! });
      const comment = await service.addComment(fixture.issueId,
        index === 0 ? `Write exactly ${marker} followed by a newline to epoch.txt. Read it and finish this step.`
          : `Append exactly ${marker} followed by a newline once to epoch.txt. Preserve all existing lines. Read the result and finish this step.`,
        { userId: fixture.userId! });
      const run = await heartbeat.wakeup(fixture.agentId, { source: "automation", triggerDetail: "system", reason: "issue_reopened_via_comment",
        requestedByActorType: "user", requestedByActorId: fixture.userId,
        payload: { issueId: fixture.issueId, commentId: comment.id, mutation: "comment", reopenedFrom: "done" },
        contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeCommentId: comment.id, skipIssueComment: true,
          ...(index === 1 ? { forceFreshSession: true } : {}) },
      });
      expect(run?.id).toBeTruthy();
      await heartbeat.drainActiveRunExecutions();
      const after = await heartbeat.getRun(run!.id);
      console.log(JSON.stringify({ stage: index, status: after?.status, errorCode: after?.errorCode, error: after?.error }));
      expect(after?.status).toBe("succeeded");
      const [session] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, fixture.issueId));
      expect(session.lastRunId).toBe(run!.id);
      expect(session.sessionParamsJson?.sessionId).toBe(after!.nativeSessionId);
      expect(await readFile(join(fixture.workspace, "epoch.txt"), "utf8")).toBe(markers.slice(0, index + 1).join("\n") + "\n");
      completed.push({ runId: run!.id, sessionId: after!.nativeSessionId!, providerSessionId: after!.sessionIdAfter!,
        publication: after!.runnerProfileJson?.nativeTaskSessionPublication });
    }
    console.log(JSON.stringify({ observedSessions: completed }));
    expect(completed[1].sessionId).not.toBe(completed[0].sessionId);
    expect(completed[1].providerSessionId).not.toBe(completed[0].providerSessionId);
    expect(completed[2].sessionId).toBe(completed[1].sessionId);
    expect(completed[2].providerSessionId).toBe(completed[1].providerSessionId);
    const evidence = { passed: true, model: "gpt-6.1-sol", lifecycleMode, provider: "real local Codex login", platform: `${process.platform}-${process.arch}`,
      turns: 3, freshSessionPublished: true, ordinaryFollowupResumedFreshSession: true, exactFileLines: 3, completed };
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
