import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getServerAdapter } from "../adapters/index.js";
import {
  resetOpenCodeModelsCacheForTests,
} from "@penclipai/adapter-opencode-local/server";

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("openai/gpt-5.3-codex\\n");
  process.exit(0);
}

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: args,
  prompt: fs.readFileSync(0, "utf8"),
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}

console.log(JSON.stringify({ type: "step_start", sessionID: "ses_123" }));
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }));
console.log(JSON.stringify({
  type: "step_finish",
  part: {
    reason: "stop",
    cost: 0.001,
    tokens: { input: 10, output: 5, cache: { read: 1, write: 0 } },
  },
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  paperclipEnvKeys: string[];
};

describe("opencode execute", () => {
  it("injects localization runtime guidance into the composed stdin prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    resetOpenCodeModelsCacheForTests();
    const adapter = getServerAdapter("opencode_local");

    let invocationPrompt = "";
    let promptMetrics: Record<string, unknown> = {};
    try {
      const result = await adapter.execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
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
          model: "openai/gpt-5.3-codex",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          paperclipSessionHandoffMarkdown: "Session handoff note.",
          paperclipLocalizationPromptMarkdown: "Runtime note:\n- Use zh-CN.",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual(["run", "--format", "json", "--model", "openai/gpt-5.3-codex"]);
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );
      expect(capture.prompt).toContain("Session handoff note.");
      expect(capture.prompt).toContain("Runtime note:\n- Use zh-CN.");
      expect(capture.prompt).toContain("Follow the paperclip heartbeat.");
      expect(capture.prompt.indexOf("Session handoff note.")).toBeLessThan(
        capture.prompt.indexOf("Runtime note:\n- Use zh-CN."),
      );
      expect(capture.prompt.indexOf("Runtime note:\n- Use zh-CN.")).toBeLessThan(
        capture.prompt.indexOf("Follow the paperclip heartbeat."),
      );
      expect(invocationPrompt).toContain("Runtime note:\n- Use zh-CN.");
      expect(promptMetrics.sessionHandoffChars).toBe(
        ["Session handoff note.", "Runtime note:\n- Use zh-CN."].join("\n\n").length,
      );
    } finally {
      resetOpenCodeModelsCacheForTests();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
