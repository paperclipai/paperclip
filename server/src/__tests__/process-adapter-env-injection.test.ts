import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execute } from "../adapters/process/execute.js";

async function writeFakeCommand(commandPath: string): Promise<void> {
  // Captures all PAPERCLIP_* env vars to a file so the test can assert
  // which ones the adapter actually injected into the spawned environment.
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  paperclipEnv: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("PAPERCLIP_")),
  ),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type Capture = { paperclipEnv: Record<string, string> };

function makeContext(opts: {
  command: string;
  cwd: string;
  capturePath: string;
  runId?: string;
  authToken?: string;
  configEnv?: Record<string, string>;
}): Parameters<typeof execute>[0] {
  return {
    runId: opts.runId ?? "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "process agent",
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
      command: opts.command,
      cwd: opts.cwd,
      env: {
        PAPERCLIP_TEST_CAPTURE_PATH: opts.capturePath,
        ...(opts.configEnv ?? {}),
      },
    },
    context: {},
    authToken: opts.authToken,
    onLog: async () => {},
  };
}

describe("process adapter env injection", () => {
  it("injects PAPERCLIP_RUN_ID and PAPERCLIP_API_KEY when runId and authToken are present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-env-"));
    const cwd = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeCommand(commandPath);

    try {
      const result = await execute(
        makeContext({
          command: commandPath,
          cwd,
          capturePath,
          runId: "run-abc-123",
          authToken: "secret-jwt-token",
        }),
      );

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
      expect(capture.paperclipEnv.PAPERCLIP_RUN_ID).toBe("run-abc-123");
      expect(capture.paperclipEnv.PAPERCLIP_API_KEY).toBe("secret-jwt-token");
      expect(capture.paperclipEnv.PAPERCLIP_AGENT_ID).toBe("agent-1");
      expect(capture.paperclipEnv.PAPERCLIP_COMPANY_ID).toBe("company-1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not set PAPERCLIP_API_KEY when authToken is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-env-no-token-"));
    const cwd = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeCommand(commandPath);

    try {
      const result = await execute(
        makeContext({
          command: commandPath,
          cwd,
          capturePath,
          runId: "run-xyz",
          authToken: undefined,
        }),
      );

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
      expect(capture.paperclipEnv.PAPERCLIP_RUN_ID).toBe("run-xyz");
      expect(capture.paperclipEnv.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite PAPERCLIP_API_KEY supplied via config.env", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-env-explicit-"));
    const cwd = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeCommand(commandPath);

    try {
      const result = await execute(
        makeContext({
          command: commandPath,
          cwd,
          capturePath,
          runId: "run-1",
          authToken: "auto-token",
          configEnv: {
            PAPERCLIP_API_KEY: "explicit-config-key",
          },
        }),
      );

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
      expect(capture.paperclipEnv.PAPERCLIP_API_KEY).toBe("explicit-config-key");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
