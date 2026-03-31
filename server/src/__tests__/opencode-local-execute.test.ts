import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-opencode-local/server";

type CapturePayload = {
  invocations: Array<{
    argv: string[];
    prompt: string;
  }>;
};

async function writeRetryingFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");

if (capturePath) {
  const current = fs.existsSync(capturePath)
    ? JSON.parse(fs.readFileSync(capturePath, "utf8"))
    : { invocations: [] };
  current.invocations.push({ argv, prompt });
  fs.writeFileSync(capturePath, JSON.stringify(current), "utf8");
}

if (argv.length === 1 && argv[0] === "models") {
  console.log("openai/gpt-5.4");
  process.exit(0);
}

if (argv.includes("--session")) {
  process.exit(0);
}

console.log(JSON.stringify({ type: "step_start", sessionID: "ses_fresh_123" }));
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }));
console.log(JSON.stringify({
  type: "step_finish",
  part: {
    reason: "stop",
    cost: 0.00042,
    tokens: { input: 10, output: 5, cache: { read: 2, write: 0 } },
  },
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("opencode execute", () => {
  it("retries fresh when a resumed session exits successfully with no output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeRetryingFakeOpenCodeCommand(commandPath);

    const logs: string[] = [];
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Agent",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "43595c05-f3e2-453a-83df-a820bb791c64",
          sessionParams: {
            sessionId: "43595c05-f3e2-453a-83df-a820bb791c64",
            cwd: workspace,
          },
          sessionDisplayId: "43595c05-f3e2-453a-83df-a820bb791c64",
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5.4",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.invocations.length).toBeGreaterThanOrEqual(2);
      const runInvocations = capture.invocations.filter((entry) => entry.argv[0] === "run");
      expect(runInvocations).toHaveLength(2);
      expect(runInvocations[0]?.argv).toEqual(
        expect.arrayContaining(["run", "--format", "json", "--session", "43595c05-f3e2-453a-83df-a820bb791c64"]),
      );
      expect(runInvocations[1]?.argv).toEqual(
        expect.arrayContaining(["run", "--format", "json"]),
      );
      expect(runInvocations[1]?.argv).not.toContain("--session");
      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.sessionId).toBe("ses_fresh_123");
      expect(result.clearSession).toBe(false);
      expect(logs.join("")).toContain("retrying with a fresh session");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
