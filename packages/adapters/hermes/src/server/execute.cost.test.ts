import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { execute } from "./execute.js";

const SESSION_ID = "20261022_170000_abcdef";

describe("Hermes cost parsing (real capture process)", () => {
  let dir: string;
  let command: string;
  let capturePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-cost-"));
    command = path.join(dir, "hermes.cjs");
    capturePath = path.join(dir, "invocations.jsonl");
    await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
if (process.env.FIXTURE_STDOUT) console.log(process.env.FIXTURE_STDOUT);
console.log("Fixture completed\\nsession_id: ${SESSION_ID}");
`, { mode: 0o700 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function context(stdout: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-cost",
      agent: {
        id: "agent-synthetic", companyId: "company-synthetic", name: "Hermes fixture",
        adapterType: "hermes_local", adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-synthetic" },
      config: {
        hermesCommand: command, provider: "openrouter", model: "fixture-model", cwd: dir,
        env: { CAPTURE_PATH: capturePath, FIXTURE_STDOUT: stdout }, timeoutSec: 10, graceSec: 1,
      },
      context: {
        issueId: "task-synthetic",
        paperclipTaskMarkdownAssignment: "Complete current synthetic task.",
        paperclipTaskMarkdownCompact: "Current synthetic task.",
      },
      onLog: async () => {},
      ...overrides,
    };
  }

  it("reports the cost when the output carries one", async () => {
    const result = await execute(context("cost: $0.0123"));
    expect(result.costUsd).toBeCloseTo(0.0123, 6);
    expect(result.resultJson?.cost_usd).toBeCloseTo(0.0123, 6);
  });

  it("leaves the cost out when the output does not carry a number", async () => {
    const result = await execute(context("the round it spent."));
    expect(result.costUsd).toBeUndefined();
    expect(result.resultJson?.cost_usd ?? null).toBeNull();
  });

  it("still reports the session, so the next heartbeat can resume it", async () => {
    const result = await execute(context("the round it spent."));
    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
    expect(result.sessionDisplayId).toBe(SESSION_ID.slice(0, 16));
  });
});
