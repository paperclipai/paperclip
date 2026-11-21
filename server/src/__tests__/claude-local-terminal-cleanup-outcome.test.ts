import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { resolveAdapterResultOutcome } from "../services/heartbeat/adapter-result-outcome.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

async function writeLingeringSuccessClaudeCommand(
  commandPath: string,
  options: { resultEvent: Record<string, unknown>; lingeringChild: boolean; childIgnoresSigterm?: boolean },
): Promise<void> {
  const childScript = options.childIgnoresSigterm
    ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("ready")'
    : 'setInterval(() => {}, 1000); process.send("ready")';
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.286 (Claude Code)"); process.exit(0); }
const { spawn } = require("node:child_process");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "claude-sonnet" }));
const printResult = () => console.log(${JSON.stringify(JSON.stringify(options.resultEvent))});
if (${options.lingeringChild}) {
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
  child.once("message", () => { child.disconnect(); printResult(); });
} else {
  printResult();
}
setInterval(() => {}, 1000);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function runLingeringCli(
  options: { resultEvent: Record<string, unknown>; lingeringChild: boolean; childIgnoresSigterm?: boolean },
  heartbeatContext?: AdapterExecutionContext,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-terminal-cleanup-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "claude");
  await fs.mkdir(workspace, { recursive: true });
  await writeLingeringSuccessClaudeCommand(commandPath, options);
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    return await execute({
      ...heartbeatContext,
      runId: heartbeatContext?.runId ?? "run-claude-terminal-cleanup",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: { engine: "cli" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: commandPath,
        cwd: workspace,
        promptTemplate: "Follow the paperclip heartbeat.",
        terminalResultCleanupGraceMs: 200,
        timeoutSec: 30,
        graceSec: 1,
      },
      context: heartbeatContext?.context ?? {},
      authToken: "run-jwt-token",
      onLog: heartbeatContext?.onLog ?? (async () => {}),
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

const successResult = {
  type: "result",
  subtype: "success",
  session_id: "11111111-1111-4111-8111-111111111111",
  is_error: false,
  stop_reason: "end_turn",
  result: "Finished the requested change.",
  usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
};

describe("claude_local terminal-result cleanup run outcome", () => {
  for (const lingeringChild of [false, true]) {
    it(`records a success result as succeeded when cleanup stops the lingering CLI (lingering child: ${lingeringChild})`, async () => {
      const adapterResult = await runLingeringCli({ resultEvent: successResult, lingeringChild });

      expect(adapterResult.timedOut).toBe(false);
      expect(adapterResult.errorMessage).toBeNull();
      expect(adapterResult.errorCode).toBeNull();
      expect(adapterResult.resultJson?.subtype).toBe("success");
      expect(adapterResult.terminalResultSuccess).toBe(true);
      expect(adapterResult.resultJson?.unmanagedBackgroundTask).toMatchObject({
        kind: "terminal_result_cleanup",
        stopped: true,
        terminalResultSeen: true,
      });
      expect(adapterResult.exitCode === 0 && adapterResult.signal === null).toBe(false);

      expect(resolveAdapterResultOutcome(adapterResult)).toBe("succeeded");
    }, 30_000);
  }

  it("records succeeded when cleanup escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const adapterResult = await runLingeringCli({
      resultEvent: successResult,
      lingeringChild: true,
      childIgnoresSigterm: true,
    });

    expect(adapterResult.errorMessage).toBeNull();
    expect(adapterResult.errorCode).toBeNull();
    expect(adapterResult.resultJson?.unmanagedBackgroundTask).toMatchObject({
      stopped: true,
      terminalResultSeen: true,
      signal: "SIGKILL",
      forceKilled: true,
    });
    expect(resolveAdapterResultOutcome(adapterResult)).toBe("succeeded");
  }, 30_000);

  for (const lingeringChild of [false, true]) {
    it(`keeps error_max_turns without is_error failed when cleanup stops the lingering CLI (lingering child: ${lingeringChild})`, async () => {
      const adapterResult = await runLingeringCli({
        resultEvent: {
          ...successResult,
          subtype: "error_max_turns",
          is_error: false,
          stop_reason: "max_turns",
          result: "Reached the maximum number of turns.",
        },
        lingeringChild,
      });

      expect(adapterResult.timedOut).toBe(false);
      expect(adapterResult.errorMessage).toBeNull();
      expect(adapterResult.errorCode).toBeNull();
      expect(adapterResult.resultJson?.subtype).toBe("error_max_turns");
      expect(adapterResult.terminalResultSuccess).toBe(false);
      expect(adapterResult.resultJson?.unmanagedBackgroundTask).toMatchObject({
        kind: "terminal_result_cleanup",
        stopped: true,
        terminalResultSeen: true,
      });
      expect(adapterResult.exitCode === 0 && adapterResult.signal === null).toBe(false);

      expect(resolveAdapterResultOutcome(adapterResult)).toBe("failed");
    }, 30_000);
  }

  it("keeps max-turn exhaustion failed and classified when cleanup stops the lingering CLI", async () => {
    const adapterResult = await runLingeringCli({
      resultEvent: {
        ...successResult,
        subtype: "error_max_turns",
        is_error: true,
        stop_reason: "max_turns",
        result: "Reached the maximum number of turns.",
      },
      lingeringChild: true,
    });

    expect(adapterResult.resultJson?.unmanagedBackgroundTask).toMatchObject({ stopped: true, terminalResultSeen: true });
    expect(adapterResult.errorCode).toBe("max_turns_exhausted");
    expect(adapterResult.resultJson?.stopReason).toBe("max_turns_exhausted");
    expect(resolveAdapterResultOutcome(adapterResult)).toBe("failed");
  }, 30_000);

  it("keeps an error result failed even when cleanup stopped the CLI", async () => {
    const adapterResult = await runLingeringCli({
      resultEvent: {
        ...successResult,
        subtype: "error_during_execution",
        is_error: true,
        result: "The turn failed.",
      },
      lingeringChild: false,
    });

    expect(adapterResult.resultJson?.unmanagedBackgroundTask).toMatchObject({ stopped: true, terminalResultSeen: true });
    expect(adapterResult.errorMessage).toBeTruthy();
    expect(resolveAdapterResultOutcome(adapterResult)).toBe("failed");
  }, 30_000);
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping heartbeat terminal-result cleanup tests: ${support.reason}`);

describePostgres("claude_local terminal-result cleanup through heartbeat completion", () => {
  const adapterType = "claude_terminal_cleanup_test";
  const fixtureByAgent = new Map<string, Parameters<typeof runLingeringCli>[0]>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-terminal-cleanup-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "cleanup-user", name: "Cleanup fixture sponsor", email: "cleanup-sponsor@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input) => {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return runLingeringCli(fixtureByAgent.get(input.agent.id)!, input);
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function runThroughHeartbeat(fixture: Parameters<typeof runLingeringCli>[0]) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "cleanup-user",
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude Coder", adapterType, status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Cleanup fixture", status: "todo", assigneeAgentId: agentId,
      responsibleUserId: "cleanup-user", issueNumber: 1 });
    fixtureByAgent.set(agentId, fixture);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId }, contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return { finished: runs.find(row => row.id === run!.id)!, runs };
  }

  it("saves a success result as succeeded with no error and no retry when cleanup stops the lingering CLI", async () => {
    const { finished, runs } = await runThroughHeartbeat({ resultEvent: successResult, lingeringChild: true });

    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    expect(finished.errorCode).toBeNull();
    expect(finished.error).toBeNull();
    expect(finished.scheduledRetryAt).toBeNull();
    expect(runs.map(row => row.id)).toEqual([finished.id]);
  }, 60_000);

  it("saves a non-success result as failed when cleanup stops the lingering CLI", async () => {
    const { finished } = await runThroughHeartbeat({
      resultEvent: { ...successResult, subtype: "error_max_turns", is_error: false, stop_reason: "max_turns" },
      lingeringChild: true,
    });

    expect(finished.status).toBe("failed");
  }, 60_000);
});
