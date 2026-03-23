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
});
