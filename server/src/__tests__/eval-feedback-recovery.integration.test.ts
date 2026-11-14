import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { expect, it } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { recoverInterruptedFeedback, readRecoveredFeedback } from "../../../tests/runner-e2e/feedback-recovery.js";

it("recovers real saved complaints and suggestions after their producer is killed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-feedback-interruption-"));
  const previousHome = process.env.PAPERCLIP_HOME, previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  process.env.PAPERCLIP_HOME = path.join(root, "home");
  process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null }).where(eq(heartbeatRuns.id, fixture.runId));
    await server.db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, fixture.agentId));
    const token = createLocalAgentJwt(fixture.agentId, fixture.companyId, "codex_local", fixture.runId)!;
    const caseDirectory = path.join(root, "case");
    const snapshots = path.join(caseDirectory, "snapshots");
    const identity = { campaignId: randomUUID(), attemptId: randomUUID(), executionId: "synthetic.interruption.local" };
    await mkdir(snapshots, { recursive: true });
    await writeFile(path.join(snapshots, "fixtures.json"), JSON.stringify({ executionId: identity.executionId, companyId: fixture.companyId }));
    worker = spawn(process.execPath, ["--input-type=module", "-e", `
      for (const kind of ['complaint', 'suggestion']) {
        const response = await fetch(process.env.FEEDBACK_URL, {
          method: 'POST', headers: { 'content-type': 'application/json',
            authorization: 'Bearer ' + process.env.FEEDBACK_TOKEN, 'X-Paperclip-Run-Id': process.env.FEEDBACK_RUN },
          body: JSON.stringify({ kind, body: 'Synthetic interrupted producer ' + kind, idempotencyKey: kind }),
        });
        if (response.status !== 201) throw new Error('Synthetic feedback submission failed: ' + response.status);
        await response.json();
      }
      process.send({ saved: 2 });
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      PATH: process.env.PATH, FEEDBACK_URL: `${server.apiUrl}/api/companies/${fixture.companyId}/agent-commentary`,
      FEEDBACK_TOKEN: token, FEEDBACK_RUN: fixture.runId,
    } });
    const saved = await Promise.race([
      once(worker, "message", { signal: AbortSignal.timeout(10_000) }),
      once(worker, "exit").then(([code]) => { throw new Error(`Producer exited before saving feedback: ${code}`); }),
    ]);
    expect(saved[0]).toEqual({ saved: 2 });
    const exited = once(worker, "exit");
    worker.kill("SIGKILL");
    expect((await exited)[1]).toBe("SIGKILL");
    const apiUrl = server.apiUrl;
    await recoverInterruptedFeedback({ identity, caseDirectory, secrets: [token], deadlineAt: Date.now() + 5_000,
      api: { async get<T>(endpoint: string, options?: { timeout: number }): Promise<T> {
        const response = await fetch(apiUrl + endpoint, { signal: AbortSignal.timeout(options?.timeout ?? 1_000) });
        if (!response.ok) throw new Error(`Read failed: ${response.status}`);
        return response.json() as Promise<T>;
      } },
    });
    expect(await readRecoveredFeedback(caseDirectory, identity)).toMatchObject({
      complaints: 1, suggestions: 1, bodiesCollected: 2, collection: "partial", invocationCollection: "partial",
      invocations: { completed: 0, failed: 0, unknown: 0 },
    });
    await server.close(); server = undefined;
    const evidenceText = await readFile(path.join(snapshots, "agent-feedback-recovered.json"), "utf8");
    const evidence = JSON.parse(evidenceText);
    expect(evidence.entries.map((entry: { body: string }) => entry.body).sort()).toEqual([
      "Synthetic interrupted producer complaint", "Synthetic interrupted producer suggestion",
    ]);
    expect(evidence.entries.every((entry: { runId: string; agent: { id: string }; task: { id: string } }) =>
      entry.runId === fixture.runId && entry.agent.id === fixture.agentId && entry.task.id === fixture.issueId)).toBe(true);
    expect(evidenceText).not.toContain(token);
    expect((await readRecoveredFeedback(caseDirectory, identity))?.review).toHaveLength(2);
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
    }
    await server?.close();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
