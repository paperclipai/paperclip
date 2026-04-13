import { describe, expect, it } from "vitest";
import { buildTranscript, type RunLogChunk } from "./transcript";
import type { UIAdapterModule } from "./types";

describe("buildTranscript", () => {
  const ts = "2026-03-20T13:00:00.000Z";
  const chunks: RunLogChunk[] = [
    { ts, stream: "stdout", chunk: "opened /Users/dotta/project\n" },
    { ts, stream: "stderr", chunk: "stderr /Users/dotta/project" },
  ];

  it("defaults username censoring to off when options are omitted", () => {
    const entries = buildTranscript(chunks, (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: line }]);

    expect(entries).toEqual([
      { kind: "stdout", ts, text: "opened /Users/dotta/project" },
      { kind: "stderr", ts, text: "stderr /Users/dotta/project" },
    ]);
  });

  it("still redacts usernames when explicitly enabled", () => {
    const entries = buildTranscript(chunks, (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: line }], {
      censorUsernameInLogs: true,
    });

    expect(entries).toEqual([
      { kind: "stdout", ts, text: "opened /Users/d****/project" },
      { kind: "stderr", ts, text: "stderr /Users/d****/project" },
    ]);
  });

  it("creates a fresh stateful parser for each transcript build", () => {
    const statefulAdapter: UIAdapterModule = {
      type: "stateful_test",
      label: "Stateful Test",
      parseStdoutLine: (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: line }],
      createStdoutParser: () => {
        let pending: string | null = null;
        return {
          parseLine: (line, entryTs) => {
            if (line.startsWith("begin:")) {
              pending = line.slice("begin:".length);
              return [];
            }
            if (line === "finish" && pending) {
              const text = `completed:${pending}`;
              pending = null;
              return [{ kind: "stdout", ts: entryTs, text }];
            }
            return [{ kind: "stdout", ts: entryTs, text: `literal:${line}` }];
          },
          reset: () => {
            pending = null;
          },
        };
      },
      ConfigFields: () => null,
      buildAdapterConfig: () => ({}),
    };

    const first = buildTranscript(
      [{ ts, stream: "stdout", chunk: "begin:task-a\n" }],
      statefulAdapter,
    );
    const second = buildTranscript(
      [{ ts, stream: "stdout", chunk: "finish\n" }],
      statefulAdapter,
    );

    expect(first).toEqual([]);
    expect(second).toEqual([{ kind: "stdout", ts, text: "literal:finish" }]);
  });

  it("converts parser failures into transcript error entries and keeps going", () => {
    const entries = buildTranscript(
      [
        { ts, stream: "stdout", chunk: "ok\nexplode\nlater\n" },
      ],
      (line, entryTs) => {
        if (line === "explode") {
          throw new Error("boom");
        }
        return [{ kind: "stdout", ts: entryTs, text: line }];
      },
    );

    expect(entries).toEqual([
      { kind: "stdout", ts, text: "ok" },
      {
        kind: "result",
        ts,
        text: "Chat transcript error: boom. Falling back for line: explode",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "transcript_parse_error",
        isError: true,
        errors: [],
      },
      { kind: "stdout", ts, text: "later" },
    ]);
  });

  it("resets stateful parsers after a failure before parsing later lines", () => {
    const statefulAdapter: UIAdapterModule = {
      type: "stateful_test",
      label: "Stateful Test",
      parseStdoutLine: (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: line }],
      createStdoutParser: () => {
        let pending: string | null = null;
        return {
          parseLine: (line, entryTs) => {
            if (line.startsWith("begin:")) {
              pending = line.slice("begin:".length);
              return [];
            }
            if (line === "explode") {
              throw new Error(`bad state:${pending ?? "none"}`);
            }
            if (line === "finish" && pending) {
              const text = `completed:${pending}`;
              pending = null;
              return [{ kind: "stdout", ts: entryTs, text }];
            }
            return [{ kind: "stdout", ts: entryTs, text: `literal:${line}` }];
          },
          reset: () => {
            pending = null;
          },
        };
      },
      ConfigFields: () => null,
      buildAdapterConfig: () => ({}),
    };

    const entries = buildTranscript(
      [{ ts, stream: "stdout", chunk: "begin:task-a\nexplode\nfinish\n" }],
      statefulAdapter,
    );

    expect(entries).toEqual([
      {
        kind: "result",
        ts,
        text: "Chat transcript error: bad state:task-a. Falling back for line: explode",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "transcript_parse_error",
        isError: true,
        errors: [],
      },
      { kind: "stdout", ts, text: "literal:finish" },
    ]);
  });

  it("handles trailing buffered parser failures without throwing", () => {
    const entries = buildTranscript(
      [{ ts, stream: "stdout", chunk: "explode" }],
      (line, entryTs) => {
        if (line === "explode") {
          throw new Error("trailing boom");
        }
        return [{ kind: "stdout", ts: entryTs, text: line }];
      },
    );

    expect(entries).toEqual([
      {
        kind: "result",
        ts,
        text: "Chat transcript error: trailing boom. Falling back for line: explode",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "transcript_parse_error",
        isError: true,
        errors: [],
      },
    ]);
  });
});
