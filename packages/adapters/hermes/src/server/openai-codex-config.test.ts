import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";

import { execute } from "./execute.js";

test("passes explicit OpenAI Codex subscription route config to Hermes CLI", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-openai-codex-config-"));
  const fakeHermesPath = path.join(tempDir, "fake-hermes");
  const argvCapturePath = path.join(tempDir, "argv.json");

  try {
    await writeFile(
      fakeHermesPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.HERMES_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)), 'utf8');",
        "console.log('PAPERCLIP_HERMES_CODEX_ADAPTER_OK');",
        "console.log('');",
        "console.log('session_id: g26-openai-codex-session');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeHermesPath, 0o755);

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const result = await execute({
      agent: {
        id: "agent-g26",
        name: "Hermes Codex Agent",
        companyId: "company-g26",
      },
      runId: "run-g26",
      authToken: "test-token",
      config: {
        hermesCommand: fakeHermesPath,
        provider: "openai-codex",
        model: "gpt-5.5",
        quiet: true,
        toolsets: "terminal,file",
        timeoutSec: 360,
        maxTurnsPerRun: 10,
        cwd: tempDir,
        env: {
          HERMES_ARGV_CAPTURE: argvCapturePath,
        },
      },
      context: {
        issueId: "issue-g26",
        paperclipWake: {
          reason: "issue_assigned",
          issue: {
            id: "issue-g26",
            identifier: "PAP-G26",
            title: "Verify Hermes-backed OpenAI Codex route",
            status: "in_progress",
            priority: "medium",
            workMode: "standard",
          },
          checkedOutByHarness: true,
          commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
          comments: [],
          fallbackFetchNeeded: false,
        },
      },
      runtime: {},
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    } as any);

    const argv = JSON.parse(await readFile(argvCapturePath, "utf8")) as string[];

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.provider).toBe("openai-codex");
    expect(result.model).toBe("gpt-5.5");
    expect(result.summary).toBe("PAPERCLIP_HERMES_CODEX_ADAPTER_OK");
    expect(result.sessionParams).toEqual({ sessionId: "g26-openai-codex-session" });

    expect(argv[0]).toBe("chat");
    expect(argv).toContain("-Q");
    expect(argv).toContain("-m");
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5.5");
    expect(argv).toContain("--provider");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("openai-codex");
    expect(argv).toContain("-t");
    expect(argv[argv.indexOf("-t") + 1]).toBe("terminal,file");
    expect(argv).toContain("--max-turns");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("10");
    expect(argv).toContain("--source");
    expect(argv[argv.indexOf("--source") + 1]).toBe("tool");
    expect(argv).toContain("--yolo");

    expect(logs.some((entry) => entry.chunk.includes("provider=openai-codex"))).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
