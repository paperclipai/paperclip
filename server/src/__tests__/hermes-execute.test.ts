import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "hermes-paperclip-adapter/server";

async function writeFakeHermesCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
};

if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}

process.stdout.write("Task completed successfully\\n\\nsession_id: hermes-session-1\\n");
`;

  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("hermes execute", () => {
  it("always passes -Q to hermes chat even when quiet is disabled in adapter config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "hermes");
    const capturePath = path.join(root, "capture.json");

    await fs.mkdir(workspace, { recursive: true });
    await writeFakeHermesCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-hermes-quiet",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Hermes Agent",
          adapterType: "hermes_local",
          adapterConfig: {
            hermesCommand: commandPath,
            cwd: workspace,
            env: {
              PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            },
            promptTemplate: "Do work.",
            quiet: false,
          },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {},
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { argv: string[] };
      expect(capture.argv).toContain("chat");
      expect(capture.argv).toContain("-Q");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
