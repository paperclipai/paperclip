/** Opt-in paid smoke: node cli/node_modules/tsx/dist/cli.mjs server/scripts/verify-agent-commentary-live.ts
 * Uses real Codex, disposable database/workspaces, and a private copy of login credentials.
 * Writes only content-free evidence to stdout; never runs as part of the unit suite.
 */
import { createAgentLifecycle } from "../src/services/agent-lifecycle.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { activityLog, agentCommentary, agents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { execute as executeLegacy } from "@paperclipai/adapter-codex-local/server";
import { startRunnerApiTestServer } from "../src/__tests__/helpers/runner-api-server.js";
import { createLocalAgentJwt } from "../src/agent-auth-jwt.js";
import { prepareNativeHeartbeatRun } from "../src/services/native-runtime/prepare-native-run.js";
import { executePaperclipNativeSession } from "../src/services/native-runtime/native-session-executor.js";
import { buildNativeExecutionInput } from "../src/services/native-runtime/native-execution-input.js";
import { buildNativeRuntimeContext } from "../src/services/native-runtime/runtime-context.js";
import { ensureNativeCompletionContract } from "../src/services/native-runtime/completion-contracts.js";
import { acquireCommentaryDaytonaTarget } from "./agent-commentary-daytona.js";
import { redactSensitiveText } from "../src/redaction.js";

const root = await mkdtemp(join(tmpdir(), "paperclip-commentary-live-"));
let server: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
async function makeRemovable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await makeRemovable(join(path, name));
  }
}
try {
  assert.ok(!process.argv[2] || ["legacy", "native"].includes(process.argv[2]), "Choose legacy, native, or omit the argument for both");
  if (process.env.PAPERCLIP_LIVE_ENVIRONMENT === "daytona" && process.argv[2] !== "legacy") {
    assert.ok(process.env.PAPERCLIP_LIVE_LINUX_RUNNER, "Build and specify the current Linux runner before the native Daytona smoke");
  }
  const authSource = process.env.PAPERCLIP_LIVE_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const codexHome = join(root, "codex");
  await mkdir(codexHome, { mode: 0o700 });
  await copyFile(join(authSource, "auth.json"), join(codexHome, "auth.json"));
  await writeFile(join(codexHome, "config.toml"), 'model_reasoning_effort = "low"\n');
  process.env.PAPERCLIP_HOME = join(root, "instance");
  process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
  process.env.PAPERCLIP_CODEX_AUTH_CACHE = "false";
  process.env.PAPERCLIP_TELEMETRY_DISABLED = "1";
  server = await startRunnerApiTestServer();
  process.env.PAPERCLIP_API_URL = server.apiUrl;
  // Production boot exports this loopback origin for host-side sandbox relays.
  const listenUrl = new URL(server.apiUrl);
  process.env.PAPERCLIP_LISTEN_HOST = listenUrl.hostname;
  process.env.PAPERCLIP_LISTEN_PORT = listenUrl.port;
  const evidence: unknown[] = [];
  for (const mode of ["legacy", "native"] as const) {
    if (process.argv[2] && process.argv[2] !== mode) continue;
    const f: Awaited<ReturnType<typeof server.fixture>> = await server.fixture({ disableWakeOnDemand: true });
    const remote: Awaited<ReturnType<typeof acquireCommentaryDaytonaTarget>> | null = process.env.PAPERCLIP_LIVE_ENVIRONMENT === "daytona" ? await acquireCommentaryDaytonaTarget(server.db, f, mode) : null;
    try {
      const prompt = `This is a bounded integration test in a disposable Paperclip instance. Use the available feedback interface to submit exactly one complaint (body: "Live ${mode} complaint: the fixture made me repeat the same setup. UGH.", key: "live-complaint") and one suggestion (body: "Live ${mode} suggestion: repeated setup wastes time; cache the fixture after initialization.", key: "live-suggestion"). ${mode === "legacy" ? "Read the automatically installed complain and suggestion-box skills and use their operational-skill stdin helper, passing each key as its second argument." : "Use the submit_complaint and submit_suggestion native tools with body and idempotencyKey."} Then continue the primary task by writing continued.txt in the working directory containing exactly continued-after-feedback. End with a brief final response. Do not create task comments or modify task status; the test harness owns disposition. Do not retry submissions. Do not access other workspaces or any external messaging tools.`;
      let log = "";
      const onLog = async (_stream: "stdout" | "stderr", chunk: string) => { log += chunk; };
      console.error(`Starting real ${mode} Codex feedback smoke.`);
      let result;
      if (mode === "legacy") {
        await server.db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null }).where(eq(heartbeatRuns.id, f.runId));
        await createAgentLifecycle(server.db).updateConfiguration(f.agentId, { adapterType: "codex_local" });
        result = await executeLegacy({
          runId: f.runId,
          agent: { id: f.agentId, companyId: f.companyId, name: "Feedback smoke", adapterType: "codex_local", adapterConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: f.issueId },
          config: { engine: "cli", cwd: f.workspace, timeoutSec: 180, promptTemplate: prompt, extraArgs: ["--skip-git-repo-check"], env: { CODEX_HOME: codexHome } },
          context: { issueId: f.issueId },
          executionTarget: remote?.target,
          authToken: createLocalAgentJwt(f.agentId, f.companyId, "codex_local", f.runId)!, onLog,
        });
        for (const skill of ["complain", "suggestion-box", "paperclip"]) {
          assert.ok(await readFile(join(codexHome, "skills", skill, "SKILL.md"), "utf8"));
        }
      } else {
        const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        const native = await prepareNativeHeartbeatRun({ db: server.db, run, issue: { id: f.issueId, title: "Feedback smoke", description: prompt, reviewPolicy: null }, environmentLeaseId: remote?.target.leaseId ?? randomUUID() });
        const [agent] = await server.db.select().from(agents).where(eq(agents.id, f.agentId));
        const completion = await ensureNativeCompletionContract({ db: server.db, companyId: f.companyId, issue: { id: f.issueId, title: "Feedback smoke", description: prompt }, actorId: f.agentId });
        const execution = buildNativeExecutionInput({
          companyId: f.companyId, runId: f.runId, agentId: f.agentId,
          issue: { id: f.issueId, identifier: null, title: "Feedback smoke", description: prompt, workMode: "standard" },
          taskPrompt: prompt, workspace: { id: f.runId, cwd: f.workspace, repoUrl: null, repoRef: null, branchName: null },
          normalizedSessionId: native.normalizedSessionId, provider: "codex", codexApprovalPolicy: "never", codexReasoningEffort: "low",
          completionContract: { id: completion.row.id, sha256: completion.row.canonicalSha256, schemaVersion: completion.row.schemaVersion, contract: completion.contract },
          runtimeContext: await buildNativeRuntimeContext({ db: server.db, agent, runId: f.runId, runtimeConfig: {}, runtimeSkillEntries: [] }),
        });
        await server.db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.runId));
        await server.db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId, phase: "observed" });
        result = await executePaperclipNativeSession({
          db: server.db, execution, runnerInstanceId: native.runnerInstanceId, turnTimeoutMs: 180_000,
          runnerEnvironment: { ...process.env, CODEX_HOME: codexHome }, useRunnerd: true, onLog,
          runnerExecutionTarget: remote?.target, runnerIngressAuthorized: Boolean(remote),
          runnerRemoteBinaryPath: remote ? process.env.PAPERCLIP_LIVE_LINUX_RUNNER : undefined,
          runnerRemoteCodexNpmSpec: remote ? "@openai/codex@0.160.0" : undefined,
          managedAiCredentialHome: codexHome,
        }).catch((error) => { throw new Error(redactSensitiveText(log.slice(-3000)), { cause: error }); });
      }
      const rows = await server.db.select().from(agentCommentary).where(eq(agentCommentary.runId, f.runId));
      assert.equal(result.exitCode, 0, `${mode}: adapter must complete successfully`);
      assert.equal(result.timedOut, false);
      // On failure expose only sanitized adapter status and row count, never provider logs or credentials.
      assert.equal(rows.length, 2, `${mode}: expected two persisted rows (adapter exit ${result.exitCode}, timed out ${result.timedOut})`);
      assert.deepEqual(rows.map(r => r.kind).sort(), ["complaint", "suggestion"]);
      assert.ok(rows.every(r => r.companyId === f.companyId && r.agentId === f.agentId && r.runId === f.runId && r.issueId === f.issueId));
      const continued: string = remote && mode === "native"
        ? (await remote.target.runner!.execute({ command: "cat", args: ["continued.txt"], cwd: remote.target.remoteCwd, bypassSession: true })).stdout
        : await readFile(join(f.workspace, "continued.txt"), "utf8");
      assert.equal(continued.trim(), "continued-after-feedback");
      const snapshot = await f.snapshot();
      assert.equal(snapshot.comments.length, 0);
      assert.equal(snapshot.issues.find(i => i.id === f.issueId)?.status, "in_progress");
      const audit = await server.db.select().from(activityLog).where(eq(activityLog.runId, f.runId));
      const feedbackAudit = audit.filter(a => a.action === "agent.commentary_submitted");
      assert.equal(feedbackAudit.length, 2);
      assert.ok(feedbackAudit.every(a => Object.keys(a.details ?? {}).join() === "kind"));
      evidence.push({ environment: remote ? "daytona" : "local", image: remote?.image, providerLeaseId: remote?.providerLeaseId, mode, exitCode: result.exitCode, timedOut: result.timedOut, companyId: f.companyId, agentId: f.agentId, runId: f.runId, issueId: f.issueId, rows: rows.map(({id, kind, createdAt}) => ({id, kind, createdAt})), continued: true, taskComments: 0, taskStatus: "in_progress", contentFreeAuditEntries: feedbackAudit.length });
      // Stop the fixture run so no subsequent sweep treats it as live work.
      await server.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
      await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      log = "";
    } finally {
      if (remote) {
        await remote.cleanup();
        console.error(`Destroyed disposable ${mode} Daytona sandbox.`);
      }
    }
  }
  const report = JSON.stringify({ verifiedAt: new Date().toISOString(), evidence }, null, 2);
  if (process.env.PAPERCLIP_LIVE_EVIDENCE_PATH) await writeFile(process.env.PAPERCLIP_LIVE_EVIDENCE_PATH, report + "\n");
  console.log(report);
} finally {
  try {
    await server?.close();
  } finally {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
}
