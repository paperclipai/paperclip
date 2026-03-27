import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-opencode-local/server";

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;

if (args[0] === "models") {
  process.stdout.write("anthropic/claude-opus-4-6\\n");
  process.exit(0);
}

let runtimeConfig = null;
const xdgConfigHome = process.env.XDG_CONFIG_HOME || null;
if (xdgConfigHome) {
  const runtimeConfigPath = path.join(xdgConfigHome, "opencode", "opencode.json");
  if (fs.existsSync(runtimeConfigPath)) {
    runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
  }
}

if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: args,
    prompt: fs.readFileSync(0, "utf8"),
    xdgConfigHome,
    runtimeConfig,
    paperclipEnvKeys: Object.keys(process.env)
      .filter((key) => key.startsWith("PAPERCLIP_"))
      .sort(),
  }), "utf8");
}

process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "ses_opencode_1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "step_finish",
  part: {
    reason: "stop",
    cost: 0,
    tokens: {
      input: 10,
      output: 5,
      cache: { read: 0, write: 0 },
    },
  },
}) + "\\n");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  xdgConfigHome: string | null;
  runtimeConfig: {
    permission?: {
      external_directory?: string;
      read?: string;
    };
    theme?: string;
  } | null;
  paperclipEnvKeys: string[];
};

describe("opencode execute", () => {
  it("injects external_directory allow config for headless runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-execute-"));
    const workspace = path.join(root, "workspace");
    const agentHome = path.join(root, "agent-home");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    const sourceConfigHome = path.join(root, "source-config");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(path.join(sourceConfigHome, "opencode"), { recursive: true });
    await fs.writeFile(
      path.join(sourceConfigHome, "opencode", "opencode.json"),
      `${JSON.stringify({ theme: "system", permission: { read: "allow" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFakeOpenCodeCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let commandNotes: string[] = [];
    try {
      const result = await execute({
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
          model: "anthropic/claude-opus-4-6",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            XDG_CONFIG_HOME: sourceConfigHome,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          paperclipWorkspace: {
            cwd: workspace,
            source: "project_primary",
            agentHome,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = meta.commandNotes ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual([
        "run",
        "--format",
        "json",
        "--model",
        "anthropic/claude-opus-4-6",
      ]);
      expect(capture.prompt).toContain("Follow the paperclip heartbeat.");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
          "PAPERCLIP_WORKSPACE_CWD",
        ]),
      );
      expect(capture.runtimeConfig).toMatchObject({
        theme: "system",
        permission: {
          read: "allow",
          external_directory: "allow",
        },
      });
      expect(commandNotes).toEqual(
        expect.arrayContaining([
          "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
        ]),
      );
      expect(capture.xdgConfigHome).not.toBe(sourceConfigHome);
      expect(capture.xdgConfigHome).not.toBeNull();
      await expect(fs.access(capture.xdgConfigHome!)).rejects.toThrow();
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
