import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { formatReplayReplay, replayReplayFixtureText } from "./replay.js";

describe("Replay replay tracer", () => {
  it("formats the validated reducer snapshot for CLI consumers", async () => {
    const source = await readFile(
      new URL("../../protocol/fixtures/replay/happy-path.json", import.meta.url),
      "utf8",
    );
    const result = replayReplayFixtureText(source);
    expect(result.ok).toBe(true);
    expect(JSON.parse(formatReplayReplay(result))).toMatchObject({
      ok: true,
      snapshot: {
        integrity: "complete",
        terminal: { runTerminalState: "succeeded" },
      },
    });
  });
});
