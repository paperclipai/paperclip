import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";

async function writeFakePiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
console.log("token=secret-value");
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({
  type: "message_update",
  assistantMessageEvent: {
    type: "thinking_delta",
    delta: "thinking about the next step",
  },
}));
console.log(JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "tool-1",
  toolName: "read",
  args: {
    path: "/tmp/secret.txt",
    token: "secret-value",
  },
}));
console.log(JSON.stringify({
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName: "read",
  result: {
    content: "tool finished",
  },
  isError: false,
}));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
console.log(JSON.stringify({
  type: "auto_retry_end",
  success: false,
  attempt: 3,
  finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"
}));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("pi_local execute", () => {
  it("fails the run when Pi exhausts automatic retries despite exiting 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-pi-quota-exhausted",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("RESOURCE_EXHAUSTED");
      expect(result.resultJson?.stdout).toContain("Pi autonomous run is in progress");
      expect(result.resultJson?.stdout).toContain("Pi thinking");
      expect(result.resultJson?.stdout).not.toContain("secret-value");
      expect(result.resultJson?.stdout).not.toContain('"type":"agent_start"');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("hides Pi stdout from heartbeat logs and replaces it with a placeholder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    const logs: Array<{ stream: string; chunk: string }> = [];

    try {
      const result = await execute({
        runId: "run-pi-hidden-stdout",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      const stdoutChunks = logs.filter((entry) => entry.stream === "stdout").map((entry) => entry.chunk);
      expect(stdoutChunks.some((chunk) => chunk.includes("Pi autonomous run is in progress"))).toBe(true);
      expect(stdoutChunks.some((chunk) => chunk.includes("Pi thinking"))).toBe(true);
      expect(stdoutChunks.some((chunk) => chunk.includes("Pi tool running: read"))).toBe(true);
      expect(stdoutChunks.some((chunk) => chunk.includes("Pi tool completed: read"))).toBe(true);
      expect(stdoutChunks.some((chunk) => chunk.includes("Pi turn completed"))).toBe(true);
      expect(stdoutChunks.some((chunk) => chunk.includes("secret-value"))).toBe(false);
      expect(logs.some((entry) => entry.chunk.includes("secret-value"))).toBe(false);
      expect(result.resultJson?.stdout).toContain("Pi autonomous run is in progress");
      expect(result.resultJson?.stdout).toContain("Pi tool running: read");
      expect(result.resultJson?.stdout).toContain("Pi turn completed");
      expect(result.resultJson?.stdout).not.toContain("secret-value");
      expect(result.resultJson?.stdout).not.toContain('"type":"tool_execution_start"');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
