/**
 * Unit coverage for the query transport: size thresholds, Windows relaunch
 * risk classification, and strict argv validation for `hermes chat`.
 *
 * `hermes chat` accepts one query transport, in its own query slot:
 *
 *   usage: hermes chat [-h] [-q QUERY | --query-file PATH] [--oneshot] ...
 *
 * A `--query-file` appended anywhere else is read as positional text, so the
 * misplaced forms below are asserted to be rejected rather than silently sent
 * to spawn().
 */

import { describe, expect, test } from "vitest";

import {
  HERMES_MAX_COMMAND_LINE_UNITS_WINDOWS,
  HERMES_MAX_INLINE_QUERY_BYTES,
  applyQueryFileTransport,
  assertHermesChatQueryTransport,
  classifyHermesQueryTransport,
  queryExceedsInlineLimit,
  windowsCommandLineUnits,
  windowsRelaunchCommandLineUnits,
} from "./query-transport.js";

describe("classifyHermesQueryTransport and queryExceedsInlineLimit", () => {
  // The complete inline command line, as execute.ts builds it.
  const inlineArgs = (query: string) => ["chat", "-q", query, "-Q"];

  test("a query one byte under MAX_ARG_STRLEN stays in argv", () => {
    const query = "y".repeat(HERMES_MAX_INLINE_QUERY_BYTES - 1);
    expect(classifyHermesQueryTransport(query, inlineArgs(""), "linux")).toBe("inline");
    expect(queryExceedsInlineLimit(query, inlineArgs(""), "linux")).toBe(false);
  });

  test("a query of exactly MAX_ARG_STRLEN bytes leaves argv", () => {
    const query = "y".repeat(HERMES_MAX_INLINE_QUERY_BYTES);
    expect(classifyHermesQueryTransport(query, inlineArgs(""), "linux")).toBe("require-file");
    expect(queryExceedsInlineLimit(query, inlineArgs(""), "linux")).toBe(true);
  });

  test("counts UTF-8 bytes, not UTF-16 code units", () => {
    // 40000 astral-plane characters are 160000 bytes but only 80000 JS units.
    const astral = "\u{1F600}".repeat(40000);
    expect(astral.length).toBe(80000);
    expect(queryExceedsInlineLimit(astral, inlineArgs(""), "linux")).toBe(true);
  });

  test("an empty query is inline", () => {
    expect(classifyHermesQueryTransport("", inlineArgs(""), "linux")).toBe("inline");
    expect(queryExceedsInlineLimit("", inlineArgs(""), "linux")).toBe(false);
  });

  // Windows caps the whole command line instead of one entry, so a query that
  // still leaves the command line inside the budget must keep the `-q` path.
  // Refusing it would turn a run that used to start into an error.
  test("Windows keeps the query inline while the complete command line fits", () => {
    const query = "y".repeat(9000);
    expect(classifyHermesQueryTransport(query, inlineArgs(query), "win32")).toBe("inline");
    expect(queryExceedsInlineLimit(query, inlineArgs(query), "win32")).toBe(false);
  });

  test("Windows moves the query out once the complete command line no longer fits", () => {
    const query = "y".repeat(HERMES_MAX_COMMAND_LINE_UNITS_WINDOWS);
    expect(classifyHermesQueryTransport(query, inlineArgs(query), "win32")).toBe("require-file");
    expect(queryExceedsInlineLimit(query, inlineArgs(query), "win32")).toBe(true);
  });

  test("Windows counts the flags around the query, not the query alone", () => {
    const query = "y".repeat(20000);
    const bare = ["chat", "-q", query];
    const padded = [...bare, ...Array.from({ length: 1500 }, () => "--yolo")];
    expect(queryExceedsInlineLimit(query, bare, "win32")).toBe(false);
    expect(queryExceedsInlineLimit(query, padded, "win32")).toBe(true);
    expect(windowsCommandLineUnits(padded)).toBeGreaterThan(windowsCommandLineUnits(bare));
  });

  test("Windows counts inter-argument spaces plus escaped quotes and backslashes", () => {
    const plain = "y".repeat(1000);
    const quoted = '"'.repeat(1000);
    expect(windowsCommandLineUnits(["chat", "-q", quoted])).toBeGreaterThan(
      windowsCommandLineUnits(["chat", "-q", plain]),
    );
    // Single arg: length + 1 escaped quote + 2 outer quotes, no inter-arg space.
    expect(windowsCommandLineUnits(['a"b'])).toBe('a"b'.length + 1 + 2);
    // Two args: `"a" "b"` = 3 + 1 space + 3 = 7.
    expect(windowsCommandLineUnits(["a", "b"])).toBe(7);
  });

  test("Windows classifies relaunch-expanding prompts as prefer-file without breaking direct CreateProcess", () => {
    // 12,000 lines of "a\n" = 24,000 chars: fits CreateProcess directly (< 32,767 - 4,096),
    // but Python repr() turns each newline into 2 chars so relaunch_command exceeds the limit.
    const multiline = "a\n".repeat(12000);
    const args = inlineArgs(multiline);
    expect(windowsRelaunchCommandLineUnits(args)).toBeGreaterThan(windowsCommandLineUnits(args));
    expect(queryExceedsInlineLimit(multiline, args, "win32")).toBe(false);
    expect(classifyHermesQueryTransport(multiline, args, "win32")).toBe("prefer-file");
  });

  test("Windows refuses to guess without the command line", () => {
    expect(() => queryExceedsInlineLimit("y".repeat(10), [], "win32")).toThrow(
      /complete command line/,
    );
  });
});

describe("applyQueryFileTransport", () => {
  test("replaces the query slot in place and keeps every other argument", () => {
    const args = ["chat", "-q", "hello", "-Q", "--source", "tool", "--yolo"];

    const next = applyQueryFileTransport(args, "/tmp/query.txt");

    expect(next).toEqual([
      "chat",
      "--query-file",
      "/tmp/query.txt",
      "-Q",
      "--source",
      "tool",
      "--yolo",
    ]);
    // The original array is not mutated: the caller owns the argv it built.
    expect(args[1]).toBe("-q");
  });

  test("accepts the long inline flag", () => {
    expect(applyQueryFileTransport(["chat", "--query", "hello", "--yolo"], "/tmp/q.txt")).toEqual([
      "chat",
      "--query-file",
      "/tmp/q.txt",
      "--yolo",
    ]);
  });

  test("refuses an argv whose query slot it does not recognise", () => {
    expect(() => applyQueryFileTransport(["chat", "-Q", "hello"], "/tmp/q.txt")).toThrow(
      /query flag at argv\[1\]/,
    );
    expect(() => applyQueryFileTransport(["run", "-q", "hello"], "/tmp/q.txt")).toThrow(
      /"chat" subcommand/,
    );
    expect(() => applyQueryFileTransport(["chat", "-q", ""], "/tmp/q.txt")).toThrow(
      /no value at argv\[2\]/,
    );
    expect(() => applyQueryFileTransport(["chat", "-q", "hello"], "")).toThrow(
      /no query file path/,
    );
  });
});

describe("assertHermesChatQueryTransport", () => {
  test("accepts the inline transport the adapter builds by default", () => {
    expect(() =>
      assertHermesChatQueryTransport(["chat", "-q", "hello", "-Q", "--yolo"]),
    ).not.toThrow();
  });

  test("accepts Markdown bullet or horizontal-rule inline prompts starting with '-'", () => {
    expect(() =>
      assertHermesChatQueryTransport(["chat", "-q", "- Fix the wake prompt", "-Q"]),
    ).not.toThrow();
    expect(() =>
      assertHermesChatQueryTransport(["chat", "-q", "---\ntitle: Wake\n---\nBody", "-Q"]),
    ).not.toThrow();
  });

  test("accepts the file transport in the query slot", () => {
    expect(() =>
      assertHermesChatQueryTransport(["chat", "--query-file", "/tmp/q.txt", "--yolo"]),
    ).not.toThrow();
    // '-' is the CLI's stdin sentinel, not a flag.
    expect(() =>
      assertHermesChatQueryTransport(["chat", "--query-file", "-", "--yolo"]),
    ).not.toThrow();
  });

  test("rejects a --query-file appended after the flags", () => {
    // This is the mis-placement the CLI cannot parse: the query option ends up
    // after `--yolo` and is read as positional text.
    expect(() =>
      assertHermesChatQueryTransport([
        "chat",
        "-q",
        "hello",
        "-Q",
        "--yolo",
        "--query-file",
        "/tmp/q.txt",
      ]),
    ).toThrow(/second query transport \(--query-file\) appears at argv\[5\]/);
  });

  test("rejects --query-file= or --query= duplicates appended later in argv", () => {
    expect(() =>
      assertHermesChatQueryTransport(["chat", "-q", "hello", "--query-file=/tmp/q.txt"]),
    ).toThrow(/second query transport \(--query-file=\/tmp\/q\.txt\) appears at argv\[3\]/);
    expect(() =>
      assertHermesChatQueryTransport(["chat", "--query-file", "/tmp/q.txt", "--query=hello"]),
    ).toThrow(/second query transport \(--query=hello\) appears at argv\[3\]/);
  });

  test("rejects a --query-file hidden behind an operator -- separator", () => {
    expect(() =>
      assertHermesChatQueryTransport(["chat", "--", "-q", "hello"]),
    ).toThrow(/query slot \(argv\[1\]\)/);
  });

  test("rejects both transports at once", () => {
    expect(() =>
      assertHermesChatQueryTransport(["chat", "--query-file", "/tmp/q.txt", "-q", "hello"]),
    ).toThrow(/second query transport \(-q\)/);
  });

  test("rejects a missing or flag-shaped --query-file value", () => {
    expect(() => assertHermesChatQueryTransport(["chat", "--query-file"])).toThrow(
      /needs a query transport and a value/,
    );
    expect(() => assertHermesChatQueryTransport(["chat", "--query-file", "--yolo"])).toThrow(
      /looks like another flag/,
    );
    expect(() => assertHermesChatQueryTransport(["chat", "-q", ""])).toThrow(
      /has no value at argv\[2\]/,
    );
  });

  test("rejects an argv without the chat subcommand", () => {
    expect(() => assertHermesChatQueryTransport(["run", "-q", "hello"])).toThrow(
      /"chat" subcommand at argv\[0\]/,
    );
  });
});
