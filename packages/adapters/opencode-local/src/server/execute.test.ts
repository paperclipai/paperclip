import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());

vi.mock("./models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.js")>();
  return {
    ...actual,
    ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
  };
});

import { execute } from "./execute.js";

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "session.updated", sessionID: "ses_123" }));
console.log(JSON.stringify({ type: "message.part.updated", part: { text: process.env.OPENCODE_PERMISSION || "hello from opencode" } }));
console.log(JSON.stringify({ type: "run.completed", usage: { inputTokens: 1, outputTokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("opencode execute", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("continues with the configured model when model discovery times out", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockRejectedValue(
      new Error("`opencode models` timed out after 20s."),
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    try {
      const result = await execute({
        runId: "run-opencode-timeout",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claudio",
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
          model: "opencode/qwen3.6-plus-free",
          promptTemplate: "Continue the assigned work.",
        },
        context: {},
        authToken: "run-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stderr",
          chunk: expect.stringContaining("Continuing with configured model opencode/qwen3.6-plus-free."),
        }),
      );
      const out = result.resultJson && typeof result.resultJson.stdout === "string" ? result.resultJson.stdout : "";
      expect(out).toMatch(/external_directory.+allow/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("sets OPENCODE_PERMISSION external_directory to allow for non-interactive runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-permissions-"));
    const workspace = path.join(root, "workspace");
    const managedInstructionsRoot = path.join(root, "managed", "instructions");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(managedInstructionsRoot, { recursive: true });
    await fs.writeFile(path.join(managedInstructionsRoot, "HEARTBEAT.md"), "# heartbeat\n", "utf8");
    await writeFakeOpenCodeCommand(commandPath);

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);

    try {
      const result = await execute({
        runId: "run-opencode-managed-instructions",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claudio",
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
          model: "opencode/qwen3.6-plus-free",
          promptTemplate: "Continue the assigned work.",
          instructionsFilePath: path.join(managedInstructionsRoot, "HEARTBEAT.md"),
          instructionsRootPath: managedInstructionsRoot,
        },
        context: {},
        authToken: "run-token",
        onLog: async () => {},
      });

      const stdout = result.resultJson && typeof result.resultJson.stdout === "string" ? result.resultJson.stdout : "";
      expect(stdout).toMatch(/external_directory.+allow/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("merges existing OPENCODE_PERMISSION JSON and still forces external_directory allow", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-perm-merge-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);

    try {
      const result = await execute({
        runId: "run-opencode-perm-merge",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claudio",
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
          model: "opencode/qwen3.6-plus-free",
          promptTemplate: "Continue the assigned work.",
          env: { OPENCODE_PERMISSION: '{"read":"ask"}' },
        },
        context: {},
        authToken: "run-token",
        onLog: async () => {},
      });

      const stdout = result.resultJson && typeof result.resultJson.stdout === "string" ? result.resultJson.stdout : "";
      expect(stdout).toMatch(/read.+ask/);
      expect(stdout).toMatch(/external_directory.+allow/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
