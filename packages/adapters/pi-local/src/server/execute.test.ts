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
import { createSecretEnvRedactionScanner, redactKnownSecretEnvValues } from "@paperclipai/adapter-utils/secret-env-redaction";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";

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
  async function run(display: string[], control: string[], onUsage?: (receipt: AdapterUsageCheckpoint) => Promise<void>) {
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
      onUsage,
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

  async function runRedacted(records: string[], onUsage?: (receipt: AdapterUsageCheckpoint) => Promise<void>) {
    const raw = records.join("\n");
    const control = createSecretEnvRedactionScanner(["123456"], 1024 * 1024);
    control.append(raw);
    return run([redactKnownSecretEnvValues(raw, ["123456"])], [control.snapshot()], onUsage);
  }

  it.each([false, true])("reports a redacted price as unknown (later priced turn=%s)", async later => {
    const result = await runRedacted([turn(4, 0.123456), ...(later ? [turn(5)] : [])]);
    expect(result.costUsd).toBeNull();
  });

  it("preserves genuine zero cost", async () => {
    expect((await runRedacted([turn(4, 0)])).costUsd).toBe(0);
  });

  it("ignores damaged content events with accounting words", async () => {
    const text = JSON.stringify({ type: "message_update", assistantMessageEvent: {
      type: "text_delta", delta: 'Discuss "cost" and tokens', cost: 123456,
    } });
    expect((await runRedacted([text, turn(4), turn(5)])).costUsd).toBeCloseTo(0.005, 6);
  });

  it("does not count message_end duplicates as additional priced turns", async () => {
    const message = JSON.stringify({ ...JSON.parse(turn(123456)), type: "message_end" });
    expect((await runRedacted([message, turn(123456), turn(5)])).costUsd).toBeCloseTo(0.005, 6);
  });

  it("counts a damaged partial numeric token once", async () => {
    expect((await runRedacted([turn(912345678), turn(5)])).costUsd).toBeCloseTo(0.005, 6);
  });

  it.each([0.123456123456, 0.1234567123456])("keeps repeatedly redacted prices unknown (%s)", async price => {
    expect((await runRedacted([turn(4, price), turn(5)])).costUsd).toBeNull();
  });

  it("recovers priced records whose counters contain repeated matches", async () => {
    expect((await runRedacted([turn(123456123456), turn(5)])).costUsd).toBeCloseTo(0.005, 6);
  });

  it("does not fall back from a redacted primary price to a direct zero", async () => {
    const usage = JSON.stringify({ type: "usage", usage: { input: 4, output: 7, cost: { total: 0.123456 }, costUsd: 0 } });
    expect((await runRedacted([usage, turn(5)])).costUsd).toBeNull();
  });

  it.each(["response", "extension_ui_request", "extension_ui_response", "extension_error", "agent_start", "agent_end", "auto_retry_end", "turn_start", "message_update", "error", "tool_execution_start", "tool_execution_end"])(
    "does not count ignored %s envelopes with top-level usage", async type => {
      const content = JSON.stringify({ type, usage: { input: 123456 } });
      expect((await runRedacted([content, turn(4), turn(5)])).costUsd).toBeCloseTo(0.005, 6);
    },
  );

  it("never publishes a complete priced subtotal after a lost display record", async () => {
    const onUsage = vi.fn(async (_receipt: AdapterUsageCheckpoint) => {});
    const result = await runRedacted([turn(4, 0.123456), turn(5), '{"type":"agent_end","messages":[]}'], onUsage);
    expect(result.costUsd).toBeNull();
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ costUsd: null, costStatus: "unpriced", complete: true }));
    expect(onUsage.mock.calls.at(-1)![0].usage).toMatchObject({ costUsd: null });
  });

  it("leaves a fully readable stream on the checkpoint total", async () => {
    const result = await run([turn(4), turn(5)], [turn(4), turn(5)]);
    expect(result.costUsd).toBeCloseTo(0.005, 6);
  });
});
