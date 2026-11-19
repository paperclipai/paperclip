import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";
import { resolveAdapterResultOutcome } from "../services/heartbeat/adapter-result-outcome.js";

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

async function runLingeringCli(options: { resultEvent: Record<string, unknown>; lingeringChild: boolean; childIgnoresSigterm?: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-terminal-cleanup-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "claude");
  await fs.mkdir(workspace, { recursive: true });
  await writeLingeringSuccessClaudeCommand(commandPath, options);
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    return await execute({
      runId: "run-claude-terminal-cleanup",
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
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
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
