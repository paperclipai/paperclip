import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";

const SESSION_ID = "20261006_200000_abcdef";
const INSTRUCTIONS = "Synthetic governance marker: request approval before governed actions.";

interface Invocation {
  args: string[];
  systemPrompt: string | null;
  runId: string;
}

describe("Hermes managed instruction delivery (real capture process)", () => {
  let dir: string;
  let command: string;
  let instructionsFilePath: string;
  let capturePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-instructions-"));
    command = path.join(dir, "hermes.cjs");
    instructionsFilePath = path.join(dir, "instructions.md");
    capturePath = path.join(dir, "invocations.jsonl");
    await fs.writeFile(instructionsFilePath, INSTRUCTIONS);
    await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args,
  systemPrompt: process.env.HERMES_EPHEMERAL_SYSTEM_PROMPT ?? null,
  runId: process.env.PAPERCLIP_RUN_ID,
}) + "\\n");
if (args.includes("missing-session")) {
  console.error("\\u001b[1;31mSession missing-session not found.\\u001b[0m");
  process.exit(1);
}
if (process.env.FIXTURE_PROVIDER_ERROR) {
  console.error("Error: provider unavailable");
  process.exit(1);
}
console.log("Fixture completed\\nsession_id: ${SESSION_ID}");
`, { mode: 0o700 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-fresh",
      agent: {
        id: "agent-synthetic", companyId: "company-synthetic", name: "Hermes fixture",
        adapterType: "hermes_local", adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-synthetic" },
      config: {
        hermesCommand: command, provider: "openrouter", model: "fixture-model", cwd: dir,
        instructionsFilePath, env: { CAPTURE_PATH: capturePath }, timeoutSec: 10, graceSec: 1,
      },
      context: {
        issueId: "task-synthetic",
        paperclipTaskMarkdownAssignment: "Complete current synthetic task.",
        paperclipTaskMarkdownCompact: "Current synthetic task.",
        paperclipWake: {
          reason: "issue_commented",
          issue: { id: "task-synthetic", title: "Synthetic task", status: "in_progress" },
          comments: [{ id: "comment-synthetic", body: "Fresh human direction." }],
          commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
      onLog: async () => {},
      ...overrides,
    };
  }

  async function invocations(): Promise<Invocation[]> {
    return (await fs.readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  }

  function query(invocation: Invocation): string {
    return invocation.args[invocation.args.indexOf("-q") + 1];
  }

  it.each([false, true])("keeps instructions out of fresh and resumed user turns (conversation=%s)", async (conversationMode) => {
    const fresh = context();
    fresh.context.conversationMode = conversationMode;
    const first = await execute(fresh);
    const params = sessionCodec.deserialize(sessionCodec.serialize(first.sessionParams ?? null));
    expect(params?.sessionId).toBe(SESSION_ID);
    await execute({ ...fresh, runId: "run-resumed", runtime: { ...fresh.runtime, sessionParams: params } });

    const [initial, resumed] = await invocations();
    expect(initial.args).not.toContain("--resume");
    expect(resumed.args.slice(resumed.args.indexOf("--resume"))).toEqual(["--resume", SESSION_ID]);
    for (const invocation of [initial, resumed]) {
      expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
      expect(invocation.systemPrompt).toContain(`Resolve any relative file references from ${dir}/`);
      expect(query(invocation)).not.toContain(INSTRUCTIONS);
      expect(query(invocation)).not.toContain("Safe multiline update pattern:");
      expect(query(invocation)).toContain("Fresh human direction.");
      expect(query(invocation)).toContain(invocation.runId);
      expect(query(invocation)).toContain("company-synthetic");
      expect(invocation.systemPrompt).toContain("$PAPERCLIP_API_KEY");
      expect(invocation.systemPrompt).toContain('-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"');
      expect(invocation.systemPrompt).toContain("body=$(cat <<'MD'");
      expect(invocation.systemPrompt).toContain("--data-binary @-");
      expect(invocation.systemPrompt).toContain('$api/issues/$PAPERCLIP_TASK_ID');
      expect(invocation.systemPrompt).not.toContain(invocation.runId);
    }
  });

  it("reapplies current instructions after edits and a session reset", async () => {
    const ctx = context();
    await execute(ctx);
    await fs.writeFile(instructionsFilePath, "Updated governance marker.");
    await execute({ ...ctx, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    await execute({ ...ctx, runId: "run-reset" });
    const [, edited, reset] = await invocations();
    for (const invocation of [edited, reset]) {
      expect(invocation.systemPrompt).toContain("Updated governance marker.");
      expect(invocation.systemPrompt).not.toContain(INSTRUCTIONS);
      expect(query(invocation)).not.toContain("Updated governance marker.");
    }
    expect(reset.args).not.toContain("--resume");
  });

  it("uses fresh wake context when persistence is disabled despite stored session params", async () => {
    const ctx = context();
    const result = await execute({ ...ctx, config: { ...ctx.config, persistSession: false }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    const [invocation] = await invocations();
    expect(invocation.args).not.toContain("--resume");
    expect(query(invocation)).toContain("## Paperclip Wake Payload");
    expect(query(invocation)).not.toContain("## Paperclip Resume Delta");
    expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
    expect(result.sessionParams).toBeUndefined();
  });

  it("keeps custom templates and quiet mode dynamic while preserving a configured system overlay", async () => {
    const ctx = context();
    await execute({ ...ctx, config: {
      ...ctx.config, quiet: true, promptTemplate: "Current custom direction for {{runId}}.",
      env: { CAPTURE_PATH: capturePath, HERMES_EPHEMERAL_SYSTEM_PROMPT: "User configured system guidance." },
    }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    const [invocation] = await invocations();
    expect(invocation.args).toContain("-Q");
    expect(query(invocation)).toContain("Current custom direction for run-fresh.");
    expect(query(invocation)).not.toContain(INSTRUCTIONS);
    expect(invocation.systemPrompt).toContain("User configured system guidance.");
    expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
  });

  it.each([false, true])("keeps an empty wake runnable with current identity (conversation=%s)", async (conversationMode) => {
    await execute(context({ context: { conversationMode } }));
    const [invocation] = await invocations();
    expect(query(invocation)).toContain("run-fresh");
    expect(query(invocation)).not.toContain(INSTRUCTIONS);
    expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
  });

  it("bootstraps a missing session once with full current task context", async () => {
    const ctx = context();
    const result = await execute({ ...ctx, runtime: { ...ctx.runtime, sessionParams: { sessionId: "missing-session" } } });
    const calls = await invocations();
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain("--resume");
    expect(calls[1].args).not.toContain("--resume");
    expect(query(calls[1])).toContain("## Paperclip Wake Payload");
    expect(query(calls[1])).toContain("Complete current synthetic task.");
    expect(calls[1].systemPrompt).toContain(INSTRUCTIONS);
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams?.sessionId).toBe(SESSION_ID);
  });

  it("does not retry provider failures as a missing session", async () => {
    const ctx = context();
    const result = await execute({ ...ctx, config: { ...ctx.config, env: { CAPTURE_PATH: capturePath, FIXTURE_PROVIDER_ERROR: "1" } }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    expect(await invocations()).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("Error: provider unavailable");
  });

  it("removes an obsolete instruction overlay when the bundle is removed", async () => {
    const ctx = context();
    await execute(ctx);
    await execute({ ...ctx, config: { ...ctx.config, instructionsFilePath: undefined }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    const [, resumed] = await invocations();
    expect(resumed.systemPrompt).not.toContain(INSTRUCTIONS);
    expect(resumed.systemPrompt).toContain("Paperclip API guidance:");
    expect(query(resumed)).toContain("Fresh human direction.");
  });
});
