import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TOOLS,
  buildToolMap,
  dispatchToolCall,
  parseToolArguments,
  READ_FILE_TOOL,
  RUN_COMMAND_TOOL,
  runShellCommand,
  toOpenAiTools,
  WRITE_FILE_TOOL,
  LIST_DIRECTORY_TOOL,
} from "./tools.js";
import type { ToolContext } from "./tools.js";

let tmp: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-agent-tools-"));
  ctx = { cwd: tmp, runCommandTimeoutSec: 5 };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("parseToolArguments", () => {
  it("returns empty object for empty/null inputs", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("null")).toEqual({});
  });
  it("parses object payloads", () => {
    expect(parseToolArguments(`{"a": 1}`)).toEqual({ a: 1 });
  });
  it("rejects non-object payloads", () => {
    expect(() => parseToolArguments("[1,2]")).toThrow(/JSON object/);
  });
  it("rejects unparseable JSON", () => {
    expect(() => parseToolArguments("{bad")).toThrow(/failed to parse/);
  });
});

describe("toOpenAiTools", () => {
  it("emits one function tool per handler with the declared schema", () => {
    const out = toOpenAiTools(DEFAULT_TOOLS);
    expect(out).toHaveLength(DEFAULT_TOOLS.length);
    for (const tool of out) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.parameters).toBeTruthy();
    }
  });
});

describe("file tools", () => {
  it("read_file returns contents of a file relative to cwd", async () => {
    await fs.writeFile(path.join(tmp, "hello.txt"), "world");
    const result = await READ_FILE_TOOL.execute({ path: "hello.txt" }, ctx);
    expect(result).toBe("world");
  });

  it("write_file creates parent directories and writes content", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: "nested/dir/out.txt", content: "abc" },
      ctx,
    );
    expect(result).toContain("wrote 3 bytes");
    const written = await fs.readFile(path.join(tmp, "nested/dir/out.txt"), "utf-8");
    expect(written).toBe("abc");
  });

  it("list_directory returns one line per entry with type prefix", async () => {
    await fs.writeFile(path.join(tmp, "a.txt"), "");
    await fs.mkdir(path.join(tmp, "child"));
    const result = await LIST_DIRECTORY_TOOL.execute({ path: "." }, ctx);
    expect(result.split("\n").sort()).toEqual(["d child", "f a.txt"]);
  });

  it("read_file rejects empty path argument", async () => {
    await expect(READ_FILE_TOOL.execute({ path: "" }, ctx)).rejects.toThrow(
      /non-empty/,
    );
  });
});

describe("run_command tool", () => {
  it("captures stdout, stderr, and exit code", async () => {
    const result = await RUN_COMMAND_TOOL.execute(
      { command: "printf hi; printf err 1>&2; exit 3" },
      ctx,
    );
    expect(result).toContain("[exitCode=3");
    expect(result).toContain("hi");
    expect(result).toContain("err");
  });

  it("respects the per-call timeout", async () => {
    const result = await RUN_COMMAND_TOOL.execute(
      { command: "sleep 5" },
      { cwd: tmp, runCommandTimeoutSec: 1 },
    );
    expect(result).toContain("timed out");
  }, 10000);
});

describe("runShellCommand with AbortSignal", () => {
  it("sends SIGTERM when signal is already aborted before spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runShellCommand("sleep 30", tmp, 30, undefined, controller.signal);
    // Process must exit well within the 30s per-tool timeout
    expect(result.timedOut).toBe(false);
    expect(result.signal !== null || (result.exitCode !== null && result.exitCode !== 0)).toBe(true);
  }, 5000);

  it("sends SIGTERM to child when signal fires mid-execution", async () => {
    const controller = new AbortController();
    const resultPromise = runShellCommand("sleep 30", tmp, 30, undefined, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;
    expect(result.timedOut).toBe(false);
    expect(result.signal !== null || (result.exitCode !== null && result.exitCode !== 0)).toBe(true);
  }, 5000);

  it("behaves identically when no signal is provided", async () => {
    const result = await runShellCommand("echo hello", tmp, 10);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });
});

describe("dispatchToolCall", () => {
  it("returns an error outcome for an unknown tool", async () => {
    const out = await dispatchToolCall(
      {
        id: "x",
        type: "function",
        function: { name: "missing", arguments: "{}" },
      },
      buildToolMap(DEFAULT_TOOLS),
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain("unknown tool");
  });

  it("returns the handler's content on success", async () => {
    await fs.writeFile(path.join(tmp, "f.txt"), "ok");
    const out = await dispatchToolCall(
      {
        id: "y",
        type: "function",
        function: { name: "read_file", arguments: `{"path":"f.txt"}` },
      },
      buildToolMap(DEFAULT_TOOLS),
      ctx,
    );
    expect(out.isError).toBe(false);
    expect(out.content).toBe("ok");
  });

  it("wraps handler errors as error outcomes", async () => {
    const out = await dispatchToolCall(
      {
        id: "z",
        type: "function",
        function: { name: "read_file", arguments: `{"path":"missing.txt"}` },
      },
      buildToolMap(DEFAULT_TOOLS),
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain("error:");
  });
});
