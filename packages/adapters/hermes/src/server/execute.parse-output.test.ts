/**
 * Regression tests for the server-side run response parser
 * (parseHermesOutput / cleanResponse in execute.ts).
 *
 * Greptile P1 on PR #14939 (2026-10-04): with quiet mode now the default
 * (TIM-67), the Reasoning box that the UI transcript parser classifies as
 * thinking entries flowed unchecked into parsed.response — and from there
 * into executionResult.summary and resultJson.result, which persist and can
 * be posted as automatic issue comments. cleanResponse must drop the box:
 * opening border through closing border, interior included; a box that never
 * closes drops to the end of the output, so a truncated run cannot leak
 * reasoning either.
 *
 * https://github.com/paperclipai/paperclip/pull/14939#discussion_r4178277154
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror of the execute.onspawn.test.ts harness: intercept runChildProcess so
// the execute() tests below can feed raw quiet-mode stdout without a binary.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute, parseHermesOutput } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

// ── Fixtures ───────────────────────────────────────────────────────────────
// Shapes verified from the production quiet-mode run log behind the UI
// parser tests (run 22e178e0); border width varies with the terminal, so
// only the box glyphs are asserted on.

function reasoningBorder(width = 80): string {
  return `┌─ Reasoning ${"─".repeat(Math.max(1, width - 15))}┐`;
}

function closingBorder(width = 80): string {
  return `└${"─".repeat(Math.max(1, width - 2))}┘`;
}

/** Quiet-mode run output: the given lines, then the session_id footer. */
function quietStdout(lines: string[]): string {
  return [...lines, "session_id: run-abc123"].join("\n") + "\n";
}

function parseQuiet(lines: string[]) {
  return parseHermesOutput(quietStdout(lines), "");
}

// ── parseHermesOutput / cleanResponse ─────────────────────────────────────

describe("parseHermesOutput: quiet-mode Reasoning box in the run response", () => {
  it("drops the box and keeps only the answer", () => {
    const parsed = parseQuiet([
      reasoningBorder(),
      " weighing whether to answer directly",
      " the run wants a terse summary",
      closingBorder(),
      "Terse summary.",
    ]);

    expect(parsed.sessionId).toBe("run-abc123");
    expect(parsed.response).toBe("Terse summary.");
  });

  it("keeps the answer when the closing border is glued to the last interior line", () => {
    const parsed = parseQuiet([
      reasoningBorder(),
      " wrapped reasoning two continues",
      ` lead with the answer.${closingBorder()}`,
      "Final answer text",
    ]);

    expect(parsed.response).toBe("Final answer text");
    expect(parsed.response).not.toContain("└");
  });

  it("drops the tail when the box never closes", () => {
    const parsed = parseQuiet([
      "Answer first, then a truncated box:",
      reasoningBorder(),
      " reasoning that never terminates",
    ]);

    expect(parsed.response).toBe("Answer first, then a truncated box:");
  });

  it("drops everything when an unclosed box opens before any answer", () => {
    const parsed = parseQuiet([
      reasoningBorder(),
      " reasoning that never terminates",
    ]);

    // The quiet path assigns the cleaned text directly, so an all-reasoning
    // run yields "" rather than an absent field; execute() guards on
    // truthiness either way, so nothing reaches summary or resultJson.
    expect(parsed.response).toBeFalsy();
  });

  it("passes answer-only output through unchanged", () => {
    expect(parseQuiet(["  ┊ 💬 Plain assistant line."]).response).toBe("Plain assistant line.");
    expect(parseQuiet(["Answer.", "", "Second paragraph."]).response).toBe(
      "Answer.\n\nSecond paragraph.",
    );

    // Legacy (non-quiet) path runs the same cleaner over all of stdout.
    expect(parseHermesOutput("Just an answer\n", "").response).toBe("Just an answer");
  });

  it("detects Reasoning-box borders wrapped in ANSI codes", () => {
    const dim = (text: string) => `\u001B[2m${text}\u001B[0m`;
    const parsed = parseQuiet([
      dim(reasoningBorder()),
      dim(" dimmed interior reasoning"),
      dim(closingBorder()),
      "Visible answer.",
    ]);

    expect(parsed.response).toBe("Visible answer.");
  });

  it("strips a stray closing border glued to an answer line outside a box", () => {
    const parsed = parseQuiet(["Answer text└────┘"]);

    expect(parsed.response).toBe("Answer text");
  });

  it("strips a glued closing border that carries a trailing ANSI reset", () => {
    // The TUI appends a reset after the border; border detection sees the
    // bare glyphs, so the strip has to look past the reset.
    const glued = parseQuiet([`Answer text${closingBorder()}\u001B[0m`]);
    expect(glued.response).toBe("Answer text");
    expect(glued.response).not.toContain("└");
    expect(glued.response).not.toContain("\u001B[0m");

    // A border-only line outside a box is decoration, ANSI included.
    const lone = parseQuiet([`${closingBorder()}\u001B[0m`, "Real answer."]);
    expect(lone.response).toBe("Real answer.");
    expect(lone.response).not.toContain("└");
  });

  it("drops two consecutive boxes but keeps the answers between them", () => {
    const parsed = parseQuiet([
      reasoningBorder(),
      " first box body",
      closingBorder(),
      "  ┊ 💬 Interim answer.",
      reasoningBorder(),
      " second box body",
      closingBorder(),
      "  ┊ 💬 Final answer.",
    ]);

    expect(parsed.response).toBe("Interim answer.\nFinal answer.");
  });
});

// ── execute(): the persisted summary/resultJson path ──────────────────────

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
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
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("execute: Reasoning box stays out of summary and resultJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the cleaned answer, not the reasoning", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: quietStdout([
        reasoningBorder(),
        " private model reasoning that must not persist",
        closingBorder(),
        "Terse summary.",
      ]),
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.summary).toBe("Terse summary.");
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.result).toBe("Terse summary.");
  });
});
