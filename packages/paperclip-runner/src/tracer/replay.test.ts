import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { formatReplayResult, replayFixtureText } from "./replay.js";

describe("Replay tracer", () => {
  it("formats the validated reducer snapshot for CLI consumers", async () => {
    const source = await readFile(
      new URL(
        "../../protocol/fixtures/replay/happy-path.json",
        import.meta.url,
      ),
      "utf8",
    );
    const result = replayFixtureText(source);
    expect(result.ok).toBe(true);
    expect(JSON.parse(formatReplayResult(result))).toMatchObject({
      ok: true,
      snapshot: {
        integrity: "complete",
        terminal: { runTerminalState: "succeeded" },
      },
    });
  });
});
