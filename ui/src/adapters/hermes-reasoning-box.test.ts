import { describe, expect, it } from "vitest";

import { hermesLocalUIAdapter } from "./hermes-local";
import { buildTranscript, type RunLogChunk } from "./transcript";

const TS = "2026-06-29T12:00:00.000Z";

function chunks(...parts: string[]): RunLogChunk[] {
  return parts.map((chunk, index) => ({ ts: TS, stream: "stdout" as const, chunk, seq: index }));
}

describe("hermes_local transcript — quiet-mode Reasoning box", () => {
  it("coalesces a whole Reasoning box into one thinking entry", () => {
    const entries = buildTranscript(
      chunks(
        "┌─ Reasoning ─────────────────────────────────┐\r\n",
        " First wrapped line of reasoning.\r\n",
        "\r\n",
        " Second wrapped line\r\n",
        "continues without a trailing space.\r\n",
        "└────────────────────────────────────────────┘\r\n",
        "  ┊ 💬 Here is the answer.\r\n",
      ),
      hermesLocalUIAdapter,
    );

    expect(entries.map((e) => e.kind)).toEqual(["thinking", "assistant"]);
    expect(entries[0]).toMatchObject({
      kind: "thinking",
      ts: TS,
      delta: true,
      text: "First wrapped line of reasoning.\nSecond wrapped line\ncontinues without a trailing space.\n",
    });
    expect(entries[1]).toEqual({ kind: "assistant", ts: TS, text: "Here is the answer." });
  });

  it("keeps a tall Reasoning box to a single entry instead of one per line", () => {
    // Observed boxes reach ~440 wrapped lines. One entry per line would flood
    // the issue chat's ~30-entry visible window.
    const body = Array.from({ length: 440 }, (_, i) => ` reasoning line ${i}\r\n`).join("");
    const entries = buildTranscript(
      chunks(
        "┌─ Reasoning ─────────────────────────────────┐\r\n",
        body,
        "└────────────────────────────────────────────┘\r\n",
        "  ┊ 💬 Done.\r\n",
      ),
      hermesLocalUIAdapter,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("thinking");
    expect((entries[0] as { text: string }).text.split("\n")).toHaveLength(441);
  });

  it("recovers when the box is never closed", () => {
    const entries = buildTranscript(
      chunks(
        "┌─ Reasoning ─────────────────────────────────┐\r\n",
        " still reasoning\r\n",
        " more reasoning\r\n",
      ),
      hermesLocalUIAdapter,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "thinking",
      delta: true,
      text: "still reasoning\nmore reasoning\n",
    });
  });
});
