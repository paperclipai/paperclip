import { describe, expect, it } from "vitest";
import { buildTranscript, type RunLogChunk } from "./transcript";

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

  it("can switch stdout parsers by timestamp", () => {
    const entries = buildTranscript([
      { ts: "2026-03-20T13:00:00.000Z", stream: "stdout", chunk: "one\n" },
      { ts: "2026-03-20T13:01:00.000Z", stream: "stdout", chunk: "two\n" },
    ], (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: `default:${line}` }], {
      resolveStdoutParser: (entryTs) =>
        entryTs < "2026-03-20T13:01:00.000Z"
          ? (line, ts) => [{ kind: "stdout", ts, text: `claude:${line}` }]
          : (line, ts) => [{ kind: "stdout", ts, text: `codex:${line}` }],
    });

    expect(entries).toEqual([
      { kind: "stdout", ts: "2026-03-20T13:00:00.000Z", text: "claude:one" },
      { kind: "stdout", ts: "2026-03-20T13:01:00.000Z", text: "codex:two" },
    ]);
  });
});
