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

async function writeFakeOpenCodeCommandNonZeroAfterStop(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "text", sessionID: "ses_ignorable", part: { text: "completed work" } }));
console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_ignorable", part: { reason: "stop", cost: 0.001, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 0, write: 0 } } } }));
process.exit(17);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeOpenCodeRetryThenSuccessCommand(
  commandPath: string,
  firstError: "permission" | "invalid_args",
): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const marker = path.join(path.dirname(process.argv[1]), ".attempt-count");
let count = 0;
try {
  count = Number(fs.readFileSync(marker, "utf8")) || 0;
} catch {}
count += 1;
fs.writeFileSync(marker, String(count));

if (count === 1) {
  if (${JSON.stringify(firstError)} === "permission") {
    console.log(JSON.stringify({ type: "error", error: { message: "The user rejected permission to use this specific tool call." } }));
  } else {
    console.log(JSON.stringify({ type: "error", error: { message: "The webfetch tool was called with invalid args." } }));
  }
  process.exit(1);
}

console.log(JSON.stringify({ type: "session.updated", sessionID: "ses_retry_ok" }));
console.log(JSON.stringify({ type: "text", sessionID: "ses_retry_ok", part: { text: "retry ok" } }));
console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_retry_ok", part: { reason: "stop", cost: 0.0001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeOpenCodeWebfetchFormatRetryNeedsHintCommand(
  commandPath: string,
): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const marker = path.join(path.dirname(process.argv[1]), ".attempt-count");
let count = 0;
try {
  count = Number(fs.readFileSync(marker, "utf8")) || 0;
} catch {}
count += 1;
fs.writeFileSync(marker, String(count));

const stdin = fs.readFileSync(0, "utf8");
const hint = "when using webfetch, format must be exactly one of text, markdown, or html";

if (count === 1) {
  console.log(JSON.stringify({
    type: "error",
    error: { message: "The webfetch tool was called with invalid arguments: path format invalid option expected one of \\"text\\"|\\"markdown\\"|\\"html\\"." },
  }));
  process.exit(1);
}

if (!stdin.includes(hint)) {
  console.log(JSON.stringify({ type: "error", error: { message: "retry missing format hint" } }));
  process.exit(1);
}

console.log(JSON.stringify({ type: "session.updated", sessionID: "ses_retry_with_hint_ok" }));
console.log(JSON.stringify({ type: "text", sessionID: "ses_retry_with_hint_ok", part: { text: "retry with hint ok" } }));
console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_retry_with_hint_ok", part: { reason: "stop", cost: 0.0001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeOpenCodeFileNotFoundRetryNeedsHintCommand(
  commandPath: string,
): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const marker = path.join(path.dirname(process.argv[1]), ".attempt-count");
let count = 0;
try {
  count = Number(fs.readFileSync(marker, "utf8")) || 0;
} catch {}
count += 1;
fs.writeFileSync(marker, String(count));

const stdin = fs.readFileSync(0, "utf8");
const hint = "Path-recovery hint: if a file path fails, first verify existence from the current repository root";

if (count === 1) {
  console.log(JSON.stringify({
    type: "error",
    error: { message: "File not found: /Users/nincius/sistematecnica-v1/supabase/functions/_shared/studioFusion.ts" },
  }));
  process.exit(1);
}

if (!stdin.includes(hint)) {
  console.log(JSON.stringify({ type: "error", error: { message: "retry missing path hint" } }));
  process.exit(1);
}

console.log(JSON.stringify({ type: "session.updated", sessionID: "ses_retry_with_path_hint_ok" }));
console.log(JSON.stringify({ type: "text", sessionID: "ses_retry_with_path_hint_ok", part: { text: "retry with path hint ok" } }));
console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_retry_with_path_hint_ok", part: { reason: "stop", cost: 0.0001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }));
process.exit(0);
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

      expect(mockEnsureOpenCodeModelConfiguredAndAvailable).toHaveBeenCalled();

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stderr",
          chunk: expect.stringContaining("Continuing with configured model opencode/qwen3.6-plus-free."),
        }),
      );
      expect(result.errorMessage).toBeNull();
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

      expect(result.errorMessage).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects a wake focus rule for issue_assigned runs with a task id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-wake-focus-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);

    let capturedPrompt = "";
    try {
      const result = await execute({
        runId: "run-opencode-wake-focus",
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
        context: {
          taskId: "issue-123",
          wakeReason: "issue_assigned",
        },
        authToken: "run-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedPrompt = meta.prompt;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(capturedPrompt).toContain("Wake focus rule (mandatory)");
      expect(capturedPrompt).toContain("issue issue-123");
      expect(capturedPrompt).toContain("Do not prioritize unrelated in_progress/todo tasks");
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

      expect(result.errorMessage).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats non-zero exit as success when stdout ends with step_finish stop and no stderr error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-ignorable-nonzero-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommandNonZeroAfterStop(commandPath);

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);

    try {
      const result = await execute({
        runId: "run-opencode-ignorable-nonzero",
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
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(17);
      expect(result.errorMessage).toBeNull();
      expect(result.errorCode).toBeNull();
      expect(result.resultJson).toMatchObject({
        paperclip: {
          ignoredNonZeroExitCode: 17,
          reason: "opencode_last_step_finish_stop",
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retries once on permission auto-reject even without session resume", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-retry-permission-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeRetryThenSuccessCommand(commandPath, "permission");

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);

    try {
      const result = await execute({
        runId: "run-opencode-retry-permission",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Seguranca",
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
        onLog: async () => {},
      });

      expect(result.errorMessage).toBeNull();
      expect(result.summary).toContain("retry ok");
      expect(result.exitCode).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retries once on invalid tool args (webfetch-style) even without session resume", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-retry-invalid-args-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeRetryThenSuccessCommand(commandPath, "invalid_args");

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);

    try {
      const result = await execute({
        runId: "run-opencode-retry-invalid-args",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Triagem",
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
        onLog: async () => {},
      });

      expect(result.errorMessage).toBeNull();
      expect(result.summary).toContain("retry ok");
      expect(result.exitCode).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects a webfetch format repair hint on invalid webfetch-format retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-retry-webfetch-format-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeWebfetchFormatRetryNeedsHintCommand(commandPath);

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);

    try {
      const result = await execute({
        runId: "run-opencode-retry-webfetch-format",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Triagem",
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
        onLog: async () => {},
      });

      expect(result.errorMessage).toBeNull();
      expect(result.summary).toContain("retry with hint ok");
      expect(result.exitCode).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects a path-recovery hint on file-not-found retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-retry-file-not-found-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeFileNotFoundRetryNeedsHintCommand(commandPath);

    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);

    try {
      const result = await execute({
        runId: "run-opencode-retry-file-not-found",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Revisor",
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
        onLog: async () => {},
      });

      expect(result.errorMessage).toBeNull();
      expect(result.summary).toContain("retry with path hint ok");
      expect(result.exitCode).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
