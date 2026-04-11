import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "../adapters/process/execute.js";

async function writeEnvCaptureScript(scriptPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const payload = {
  PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID ?? null,
  PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID ?? null,
  PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL ?? null,
  PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID ?? null,
  PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY ?? null
};
fs.writeFileSync(process.argv[2], JSON.stringify(payload), "utf8");
`;
  await fs.writeFile(scriptPath, script, "utf8");
  await fs.chmod(scriptPath, 0o755);
}

describe("process adapter execute", () => {
  it("injects PAPERCLIP_RUN_ID and PAPERCLIP_API_KEY from authToken by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-execute-"));
    const scriptPath = path.join(root, "capture.js");
    const capturePath = path.join(root, "capture.json");
    await writeEnvCaptureScript(scriptPath);

    try {
      const result = await execute({
        runId: "run-123",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Process Agent",
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
          command: process.execPath,
          args: [scriptPath, capturePath],
          cwd: root,
          env: {},
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async () => {},
      } as any);

      expect(result.errorMessage).toBeUndefined();
      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string | null>;
      expect(payload.PAPERCLIP_AGENT_ID).toBe("agent-1");
      expect(payload.PAPERCLIP_COMPANY_ID).toBe("company-1");
      expect(payload.PAPERCLIP_RUN_ID).toBe("run-123");
      expect(payload.PAPERCLIP_API_KEY).toBe("run-jwt-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves explicit PAPERCLIP_API_KEY override from adapter config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-execute-explicit-key-"));
    const scriptPath = path.join(root, "capture.js");
    const capturePath = path.join(root, "capture.json");
    await writeEnvCaptureScript(scriptPath);

    try {
      const result = await execute({
        runId: "run-456",
        agent: {
          id: "agent-2",
          companyId: "company-2",
          name: "Process Agent",
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
          command: process.execPath,
          args: [scriptPath, capturePath],
          cwd: root,
          env: {
            PAPERCLIP_API_KEY: "manual-agent-key",
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async () => {},
      } as any);

      expect(result.errorMessage).toBeUndefined();
      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string | null>;
      expect(payload.PAPERCLIP_RUN_ID).toBe("run-456");
      expect(payload.PAPERCLIP_API_KEY).toBe("manual-agent-key");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
