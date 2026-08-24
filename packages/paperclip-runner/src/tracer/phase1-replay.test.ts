import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { formatPhase1Replay, replayPhase1FixtureText } from "./phase1-replay.js";

describe("Phase 1 replay tracer", () => {
  it("formats the validated reducer snapshot for CLI consumers", async () => {
    const source = await readFile(
      new URL("../../protocol/fixtures/phase-01/happy-path.json", import.meta.url),
      "utf8",
    );
    const result = replayPhase1FixtureText(source);
    expect(result.ok).toBe(true);
    expect(JSON.parse(formatPhase1Replay(result))).toMatchObject({
      ok: true,
      snapshot: {
        integrity: "complete",
        terminal: { runTerminalState: "succeeded" },
      },
    });
  });
});
