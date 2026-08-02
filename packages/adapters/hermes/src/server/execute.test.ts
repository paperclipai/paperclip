import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const runChildProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess: runChildProcessMock,
  };
});

import { execute } from "./execute.js";

const tempRoots: string[] = [];
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;

async function makeHermesHome(configLines: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-execute-"));
  const hermesDir = path.join(root, ".hermes");
  await fs.mkdir(hermesDir, { recursive: true });
  await fs.writeFile(path.join(hermesDir, "config.yaml"), `${configLines.join("\n")}\n`, "utf8");
  tempRoots.push(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  return root;
}

afterEach(async () => {
  runChildProcessMock.mockReset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("hermes execute", () => {
  it("defaults to quiet mode and preserves matching custom Hermes config providers", async () => {
    const root = await makeHermesHome([
      "model:",
      "  default: grok-4.5",
      "  provider: xai-oauth",
      "  base_url: https://api.x.ai/v1",
    ]);

    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "session_id: sess-1",
        "Warning: Unknown toolsets: messaging",
        "OK",
      ].join("\n"),
      stderr: "",
    });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Agent",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        model: "grok-4.5",
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    };

    const result = await execute(ctx);

    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    const call = runChildProcessMock.mock.calls[0] as [string, string, string[]];
    expect(call[1]).toBe("hermes");
    expect(call[2]).toEqual(expect.arrayContaining([
      "chat",
      "-q",
      "-Q",
      "-m",
      "grok-4.5",
      "--provider",
      "xai-oauth",
      "--source",
      "tool",
      "--yolo",
    ]));

    expect(result).toMatchObject({
      exitCode: 0,
      provider: "xai-oauth",
      model: "grok-4.5",
      summary: "OK",
      sessionDisplayId: "sess-1",
      sessionParams: { sessionId: "sess-1" },
      resultJson: {
        result: "OK",
        session_id: "sess-1",
      },
    });
    expect(logs.some((entry) => entry.chunk.includes("provider=xai-oauth [hermesConfig]"))).toBe(true);
  });

  it("lets adapter config opt out of quiet mode explicitly", async () => {
    const root = await makeHermesHome([
      "model:",
      "  default: grok-4.5",
      "  provider: xai-oauth",
    ]);

    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "OK",
      stderr: "",
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-quiet-false",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Agent",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        model: "grok-4.5",
        quiet: false,
      },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await execute(ctx);

    const call = runChildProcessMock.mock.calls[0] as [string, string, string[]];
    expect(call[2]).not.toContain("-Q");
  });
});
