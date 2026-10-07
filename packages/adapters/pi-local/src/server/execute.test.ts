import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});
vi.mock("./models.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ensurePiModelConfiguredAndAvailable: vi.fn(async () => []) };
});

import { execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

describe("Pi cost accounting when redaction hides a display record", () => {
  const marker = "***REDACTED***";
  // A turn whose `input` counter is `input`; a string value lets a test build
  // the display form, where a secret-matching counter becomes the bare marker.
  const turn = (input: number | string, total = 0.0025) => JSON.stringify({
    type: "turn_end",
    message: { role: "assistant", content: "ok", usage: { input, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total } } },
    toolResults: [],
  });
  const redacted = () => turn(marker).replace(`"${marker}"`, marker);
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-cost-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  // Display text is what the redacted log carries; control text is the
  // sanitized copy, where the same counter becomes 0 and stays parseable.
  async function run(display: string[], control: string[]) {
    const commandPath = path.join(home, "fake-pi");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockImplementation((async (_runId: string, _target: unknown, _command: string, _args: string[], opts: { onLog: (stream: "stdout" | "stderr", text: string) => Promise<void> }) => {
      const stdout = display.join("\n") + "\n";
      await opts.onLog("stdout", stdout);
      return {
        exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString(),
        controlOutput: { stdout: control.join("\n") + "\n", stderr: "" },
      };
    }) as never);
    return execute({
      runId: "pi-cost-run",
      agent: { id: "agent-1", companyId: "company-1", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: home, model: "openai/gpt-5" },
      context: createPromptContextFixture(),
      onLog: async () => {},
    });
  }

  it("keeps the control total when a redacted turn is missing from the display stream", async () => {
    const result = await run([redacted(), turn(5)], [turn(0), turn(5)]);
    expect(result.costUsd).toBeCloseTo(0.005, 6);
  });

  it("reports unknown instead of a partial sum when control also lost a record", async () => {
    const result = await run([redacted(), turn(5), turn(6)], [turn(6)]);
    expect(result.costUsd).toBeNull();
  });

  it("leaves a fully readable stream on the checkpoint total", async () => {
    const result = await run([turn(4), turn(5)], [turn(4), turn(5)]);
    expect(result.costUsd).toBeCloseTo(0.005, 6);
  });
});
