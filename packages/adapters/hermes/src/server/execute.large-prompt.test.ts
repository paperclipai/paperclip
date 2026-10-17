/**
 * Regression coverage for the oversized-prompt transport in the hermes-local
 * adapter.
 *
 * `execute()` used to place the whole rendered prompt in one argv entry
 * (`args = ["chat", "-q", prompt]`). Linux caps a single argv entry at
 * `MAX_ARG_STRLEN` (131072 bytes), so a long wake history plus the agent
 * instructions made `spawn()` fail with `E2BIG` before Hermes started, and the
 * agent looped in `error` with no run at all.
 *
 * The tests below drive the real `execute()` against a fake Hermes CLI on disk,
 * so they cover the whole path: the capability probe, the transport swap, the
 * argv the child actually receives, and the cleanup of the query file.
 */

import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { buildPrompt, execute } from "./execute.js";
import { HERMES_MAX_INLINE_QUERY_BYTES } from "./query-transport.js";

/**
 * Fake Hermes CLI. Answers `chat --help` with a usage line that either
 * advertises `--query-file` or not, and reports which transport the adapter
 * chose plus the byte size of the query the child actually received.
 */
const FAKE_HERMES_CLI = `#!/usr/bin/env node
import fs from "node:fs";

const argv = process.argv.slice(2);

if (argv[0] === "chat" && argv.includes("--help")) {
  if (process.env.FAKE_HERMES_WITHOUT_QUERY_FILE === "1") {
    process.stdout.write(
      "usage: hermes chat [-h] [-q QUERY] [--oneshot] [-Q]\\n\\noptions:\\n  -q, --query QUERY  Query to run.\\n",
    );
  } else {
    process.stdout.write(
      "usage: hermes chat [-h] [-q QUERY | --query-file PATH] [--oneshot] [-Q]\\n\\noptions:\\n" +
        "  -q, --query QUERY  Query to run.\\n" +
        "  --query-file PATH  Read the single query from a file instead of the command line ('-' reads stdin).\\n",
    );
  }
  process.exit(0);
}

const inlineIndex = argv.indexOf("-q");
const fileIndex = argv.indexOf("--query-file");
let mode = "none";
let bytes = 0;
let filePath = "";
let readError = "";

if (inlineIndex >= 0) {
  mode = "argv";
  bytes = Buffer.byteLength(argv[inlineIndex + 1] ?? "", "utf8");
} else if (fileIndex >= 0) {
  mode = "file";
  filePath = argv[fileIndex + 1] ?? "";
  try {
    bytes = Buffer.byteLength(fs.readFileSync(filePath, "utf8"), "utf8");
  } catch (error) {
    readError = String(error && error.message ? error.message : error);
  }
}

process.stdout.write("FAKE-QUERY-MODE: " + mode + "\\n");
process.stdout.write("FAKE-QUERY-BYTES: " + bytes + "\\n");
if (filePath) process.stdout.write("FAKE-QUERY-FILE: " + filePath + "\\n");
if (readError) process.stdout.write("FAKE-QUERY-READ-ERROR: " + readError + "\\n");
process.stdout.write("session_id: fake-session-0001\\n");
`;

let tempDir = "";
let cliPath = "";

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-large-prompt-"));
  cliPath = path.join(tempDir, "fake-hermes");
  await writeFile(cliPath, FAKE_HERMES_CLI, "utf8");
  await chmod(cliPath, 0o755);
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function makeCtx(options: {
  markdown?: string;
  config?: Record<string, unknown>;
} = {}) {
  const logs: { stream: string; chunk: string }[] = [];
  const ctx = {
    runId: "run-large-prompt",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes Engineer",
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
      hermesCommand: cliPath,
      cwd: tempDir,
      model: "test/model",
      provider: "nous",
      timeoutSec: 60,
      graceSec: 5,
      ...options.config,
    },
    context: {
      issueId: "COG-TEST",
      taskTitle: "Oversized prompt transport",
      paperclipTaskMarkdown: options.markdown ?? "",
    },
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk: String(chunk) });
    },
    onMeta: async () => undefined,
    onSpawn: async () => undefined,
  };
  return { ctx: ctx as unknown as AdapterExecutionContext, logs };
}

function renderedPromptBytes(markdown: string): number {
  const { ctx } = makeCtx({ markdown });
  return Buffer.byteLength(buildPrompt(ctx, ctx.config), "utf8");
}

/**
 * Markdown padding that renders a prompt of exactly `target` bytes.
 *
 * The template adds wrapper text around a non-empty task-context section, so
 * the pad is converged against the rendered size instead of assumed to be 1:1.
 */
function markdownForPromptBytes(target: number): string {
  let pad = target - renderedPromptBytes("");
  if (pad <= 0) {
    throw new Error(`target ${target} is below the empty-prompt size`);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const markdown = "y".repeat(pad);
    const bytes = renderedPromptBytes(markdown);
    if (bytes === target) return markdown;
    pad += target - bytes;
  }
  throw new Error(`could not render a prompt of exactly ${target} bytes`);
}

function logText(logs: { chunk: string }[]): string {
  return logs.map((entry) => entry.chunk).join("");
}

describe("hermes-local oversized prompt transport", () => {
  test("keeps a small query in argv and never probes or moves it", async () => {
    const markdown = "y".repeat(1000);
    const { ctx, logs } = makeCtx({ markdown });
    const expectedBytes = renderedPromptBytes(markdown);

    const result = await execute(ctx);
    const output = logText(logs);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("FAKE-QUERY-MODE: argv");
    expect(output).toContain(`FAKE-QUERY-BYTES: ${expectedBytes}`);
    expect(output).not.toContain("--query-file");
  });

  test("moves a query of exactly MAX_ARG_STRLEN bytes to --query-file and cleans it up", async () => {
    const markdown = markdownForPromptBytes(HERMES_MAX_INLINE_QUERY_BYTES);
    const { ctx, logs } = makeCtx({ markdown });

    const result = await execute(ctx);
    const output = logText(logs);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("FAKE-QUERY-MODE: file");
    expect(output).toContain(`FAKE-QUERY-BYTES: ${HERMES_MAX_INLINE_QUERY_BYTES}`);
    expect(output).toContain(
      `[hermes] Prompt is ${HERMES_MAX_INLINE_QUERY_BYTES} bytes, over the ${HERMES_MAX_INLINE_QUERY_BYTES}-byte single-argument limit; passing it via --query-file`,
    );
    // The child read the whole query from the file, not a truncated argv copy.
    expect(output).not.toContain("FAKE-QUERY-READ-ERROR");

    const queryFile = /FAKE-QUERY-FILE: (.+)/.exec(output)?.[1]?.trim();
    expect(queryFile).toBeTruthy();
    await expect(access(queryFile as string)).rejects.toThrow();
  });

  test("removes the query file when the pre-spawn log fails", async () => {
    const markdown = markdownForPromptBytes(HERMES_MAX_INLINE_QUERY_BYTES);
    const { ctx, logs } = makeCtx({ markdown });
    const prefix = "paperclip-hermes-prompt-";
    const before = (await readdir(os.tmpdir())).filter((entry) => entry.startsWith(prefix));

    const failingCtx = {
      ...ctx,
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        if (String(chunk).includes("single-argument limit")) {
          throw new Error("log sink down");
        }
        logs.push({ stream, chunk: String(chunk) });
      },
    } as unknown as AdapterExecutionContext;

    let failure: unknown = null;
    try {
      await execute(failingCtx);
    } catch (error) {
      failure = error;
    }

    expect((failure as Error)?.message).toBe("log sink down");
    const after = (await readdir(os.tmpdir())).filter(
      (entry) => entry.startsWith(prefix) && !before.includes(entry),
    );
    expect(after).toEqual([]);
  });

  test("refuses to start when the CLI does not advertise --query-file", async () => {
    const markdown = markdownForPromptBytes(HERMES_MAX_INLINE_QUERY_BYTES);
    const { ctx, logs } = makeCtx({
      markdown,
      config: { env: { FAKE_HERMES_WITHOUT_QUERY_FILE: "1" } },
    });

    let failure: unknown = null;
    try {
      await execute(ctx);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/single-argument limit/);
    expect((failure as Error).message).toMatch(/--query-file/);

    // The run never started: no spawn, so no transport report and no E2BIG.
    expect(logText(logs)).not.toContain("FAKE-QUERY-MODE");
  });

  // The inline path is only exercisable where a 131071-byte argv entry is
  // accepted; Windows caps the whole command line at ~32 KB and macOS limits
  // differ, so the boundary is asserted on Linux (the platform the defect was
  // measured on).
  test.skipIf(process.platform !== "linux")(
    "keeps a query one byte below MAX_ARG_STRLEN in argv",
    async () => {
      const markdown = markdownForPromptBytes(HERMES_MAX_INLINE_QUERY_BYTES - 1);
      const { ctx, logs } = makeCtx({ markdown });

      const result = await execute(ctx);
      const output = logText(logs);

      expect(result.exitCode).toBe(0);
      expect(output).toContain("FAKE-QUERY-MODE: argv");
      expect(output).toContain(`FAKE-QUERY-BYTES: ${HERMES_MAX_INLINE_QUERY_BYTES - 1}`);
    },
  );
});
