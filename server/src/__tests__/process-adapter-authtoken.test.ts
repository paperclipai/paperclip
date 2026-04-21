import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";

async function writeCapturingCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const payload = {
  PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY ?? null,
  PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL ?? null,
  PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID ?? null,
};
fs.writeFileSync(process.env.PAPERCLIP_TEST_CAPTURE_PATH, JSON.stringify(payload), "utf8");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function runProcessAdapter(opts: {
  workspace: string;
  commandPath: string;
  capturePath: string;
  authToken?: string;
  userEnv?: Record<string, string>;
}) {
  return execute({
    runId: `run-${Date.now()}`,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Process Worker",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: opts.commandPath,
      cwd: opts.workspace,
      env: {
        PAPERCLIP_TEST_CAPTURE_PATH: opts.capturePath,
        ...(opts.userEnv ?? {}),
      },
    },
    context: {},
    authToken: opts.authToken,
    onLog: async () => {},
  });
}

describe("process adapter authToken injection", () => {
  it("injects authToken as PAPERCLIP_API_KEY when user has not set one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-authtoken-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeCapturingCommand(commandPath);

    try {
      const result = await runProcessAdapter({
        workspace,
        commandPath,
        capturePath,
        authToken: "run-jwt-token",
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string | null>;
      expect(capture.PAPERCLIP_API_KEY).toBe("run-jwt-token");
      expect(capture.PAPERCLIP_AGENT_ID).toBe("agent-1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects a user-provided PAPERCLIP_API_KEY and does not overwrite with authToken", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-authtoken-override-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeCapturingCommand(commandPath);

    try {
      const result = await runProcessAdapter({
        workspace,
        commandPath,
        capturePath,
        authToken: "run-jwt-token",
        userEnv: { PAPERCLIP_API_KEY: "user-provided-key" },
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string | null>;
      expect(capture.PAPERCLIP_API_KEY).toBe("user-provided-key");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves PAPERCLIP_API_KEY unset when no authToken is available and user did not set one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-authtoken-absent-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeCapturingCommand(commandPath);

    try {
      const result = await runProcessAdapter({
        workspace,
        commandPath,
        capturePath,
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string | null>;
      expect(capture.PAPERCLIP_API_KEY).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
