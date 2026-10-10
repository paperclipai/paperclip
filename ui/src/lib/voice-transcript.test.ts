import { describe, expect, it } from "vitest";
import { updateVoiceTranscript } from "./voice-transcript";

describe("voice transcript reconciliation", () => {
  it("keeps a delayed reply separate from an earlier acknowledgment by the same speaker", () => {
    const first = updateVoiceTranscript([], { source: "agent", segmentId: "ack", text: "Working on it.", isFinal: true }, "unused");
    const result = updateVoiceTranscript(first, { source: "agent", segmentId: "answer", text: "The result is ready.", isFinal: true }, "unused");
    expect(result.map((e) => e.text)).toEqual(["Working on it.", "The result is ready."]);
  });
  it("replaces partials, ignores stale partials after final, and deduplicates repeated final reports", () => {
    let entries = updateVoiceTranscript([], { source: "user", segmentId: "a", text: "Add", isFinal: false }, "unused");
    for (const update of [{ text: "Add a follow-up", isFinal: true }, { text: "Add a", isFinal: false }, { text: "Add a follow-up", isFinal: true }]) {
      entries = updateVoiceTranscript(entries, { source: "user", segmentId: "a", ...update }, "unused");
    }
    expect(entries).toEqual([{ id: "user:a", source: "user", text: "Add a follow-up", final: true }]);
  });
  it("does not overwrite overlapping speakers sharing a segment identifier", () => {
    const first = updateVoiceTranscript([], { source: "agent", segmentId: "a", text: "Working", isFinal: false }, "unused");
    expect(updateVoiceTranscript(first, { source: "user", segmentId: "a", text: "Wait", isFinal: true }, "unused")).toHaveLength(2);
  });
});
