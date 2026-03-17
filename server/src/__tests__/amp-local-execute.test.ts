import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-amp-local/server";

async function writeFakeAmpCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const prompt = fs.readFileSync(0, "utf8");
const payload = {
  argv: process.argv.slice(2),
  prompt,
  ampApiKey: process.env.AMP_API_KEY || null,
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-6", session_id: "T-test-thread-1" }));
console.log(JSON.stringify({
  type: "assistant",
  session_id: "T-test-thread-1",
  message: { content: [{ type: "text", text: "Hello from Amp!" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  result: "Hello from Amp!",
  session_id: "T-test-thread-1",
  model: "claude-opus-4-6",
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
  total_cost_usd: 0.005,
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  ampApiKey: string | null;
  paperclipEnvKeys: string[];
};

describe("amp_local execute", () => {
  it("executes amp with correct args and parses output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-amp-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "amp");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeAmpCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Amp Agent",
          adapterType: "amp_local",
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
          dangerouslyAllowAll: true,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Do the Paperclip work.",
        },
        context: {},
        authToken: "amp-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.provider).toBe("amp");
      expect(result.biller).toBe("amp");
      expect(result.billingType).toBe("credits");
      expect(result.model).toBe("claude-opus-4-6");
      expect(result.sessionId).toBe("T-test-thread-1");
      expect(result.sessionDisplayId).toBe("T-test-thread-1");
      expect(result.summary).toBe("Hello from Amp!");
      expect(result.costUsd).toBe(0.005);
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
      });

      // Verify session params for thread continuation
      expect(result.sessionParams).toEqual({
        threadId: "T-test-thread-1",
        cwd: workspace,
      });

      // Verify the command received correct args
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--execute");
      expect(capture.argv).toContain("--stream-json");
      expect(capture.argv).toContain("--dangerously-allow-all");
      expect(capture.prompt).toContain("Do the Paperclip work.");
      // Auth token should be passed as AMP_API_KEY
      expect(capture.ampApiKey).toBe("amp-jwt-token");
      // Paperclip env vars should be present
      expect(capture.paperclipEnvKeys).toContain("PAPERCLIP_RUN_ID");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes thread id for session continuation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-amp-resume-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "amp");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeAmpCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Amp Agent",
          adapterType: "amp_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "T-previous-thread",
          sessionParams: { threadId: "T-previous-thread", cwd: workspace },
          sessionDisplayId: "T-previous-thread",
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Continue work.",
        },
        context: {},
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      // Should include thread continuation args with global flags first.
      expect(capture.argv).toEqual([
        "--execute",
        "--stream-json",
        "--dangerously-allow-all",
        "threads",
        "continue",
        "T-previous-thread",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes mode flag when configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-amp-mode-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "amp");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeAmpCommand(commandPath);

    try {
      await execute({
        runId: "run-3",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Amp Agent",
          adapterType: "amp_local",
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
          mode: "rush",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
        },
        context: {},
        onLog: async () => {},
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--mode");
      expect(capture.argv).toContain("rush");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resume thread when cwd mismatch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-amp-cwdmismatch-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "amp");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeAmpCommand(commandPath);

    const logs: string[] = [];
    try {
      await execute({
        runId: "run-4",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Amp Agent",
          adapterType: "amp_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "T-old-thread",
          sessionParams: { threadId: "T-old-thread", cwd: "/some/other/cwd" },
          sessionDisplayId: "T-old-thread",
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
        },
        context: {},
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      // Should NOT include thread continuation args due to cwd mismatch
      expect(capture.argv).not.toContain("threads");
      expect(capture.argv).not.toContain("T-old-thread");
      // Should log the mismatch
      expect(logs.some(l => l.includes("will not be resumed"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
