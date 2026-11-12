import { describe, expect, it } from "vitest";
import type { RunLogChunk } from "../adapters";
import {
  closeDanglingCodeFence,
  extractAssistantOutputText,
  parseSummaryDraftStream,
} from "./summary-draft-stream";

function delta(text: string, channel: "output" | "thought" = "output"): RunLogChunk {
  return {
    ts: "2026-07-15T00:00:00.000Z",
    stream: "stdout",
    chunk: JSON.stringify({ type: "acpx.text_delta", text, channel }),
  };
}

/** Split a string into N pieces to simulate token-by-token streaming deltas. */
function splitDeltas(text: string, size = 3): RunLogChunk[] {
  const chunks: RunLogChunk[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(delta(text.slice(i, i + size)));
  }
  return chunks;
}

describe("extractAssistantOutputText", () => {
  it("concatenates output-channel text deltas in order", () => {
    const chunks = [delta("Hello "), delta("world")];
    expect(extractAssistantOutputText(chunks)).toBe("Hello world");
  });

  it("ignores thought-channel deltas and non-text records", () => {
    const toolCall: RunLogChunk = {
      ts: "2026-07-15T00:00:00.000Z",
      stream: "stdout",
      chunk: JSON.stringify({ type: "acpx.tool_call", name: "Read", input: { path: "x" } }),
    };
    const nonJson: RunLogChunk = { ts: "t", stream: "system", chunk: "run queued" };
    const chunks = [delta("visible "), delta("secret", "thought"), toolCall, nonJson, delta("text")];
    expect(extractAssistantOutputText(chunks)).toBe("visible text");
  });
});

describe("parseSummaryDraftStream", () => {
  it("returns empty parse for empty text", () => {
    expect(parseSummaryDraftStream("")).toEqual({
      statusLine: null,
      statusLines: [],
      draft: null,
      draftClosed: false,
    });
  });

  it("extracts STATUS lines with the prefix stripped and tracks the latest", () => {
    const text = "STATUS: reading the slot…\nsome noise\nSTATUS: writing the summary…\n";
    const parsed = parseSummaryDraftStream(text);
    expect(parsed.statusLines).toEqual(["reading the slot…", "writing the summary…"]);
    expect(parsed.statusLine).toBe("writing the summary…");
  });

  it("requires STATUS markers at line start", () => {
    const parsed = parseSummaryDraftStream("noise STATUS: not a real status\n");
    expect(parsed.statusLine).toBeNull();
  });

  it("extracts a fully closed draft between the sentinels", () => {
    const text = [
      "STATUS: writing the summary…",
      "<<<SUMMARY-DRAFT>>>",
      "## Needs you",
      "- Approve the launch",
      "<<<END-SUMMARY-DRAFT>>>",
      "",
    ].join("\n");
    const parsed = parseSummaryDraftStream(text);
    expect(parsed.draft).toBe("## Needs you\n- Approve the launch");
    expect(parsed.draftClosed).toBe(true);
  });

  it("returns a partial draft while the closing sentinel has not arrived", () => {
    const text = "<<<SUMMARY-DRAFT>>>\n## Needs you\n- Approve";
    const parsed = parseSummaryDraftStream(text);
    expect(parsed.draft).toBe("## Needs you\n- Approve");
    expect(parsed.draftClosed).toBe(false);
  });

  it("rejoins markers split across streaming delta boundaries", () => {
    // The full protocol output, streamed in tiny 3-char slices, then reassembled
    // by extractAssistantOutputText exactly as the hook does.
    const full = [
      "STATUS: writing the summary…",
      "<<<SUMMARY-DRAFT>>>",
      "## Needs you",
      "Nothing urgent.",
      "<<<END-SUMMARY-DRAFT>>>",
    ].join("\n");
    const reassembled = extractAssistantOutputText(splitDeltas(full, 3));
    expect(reassembled).toBe(full);
    const parsed = parseSummaryDraftStream(reassembled);
    expect(parsed.statusLine).toBe("writing the summary…");
    expect(parsed.draft).toBe("## Needs you\nNothing urgent.");
    expect(parsed.draftClosed).toBe(true);
  });

  it("ignores an inline (non-line-start) start sentinel", () => {
    const parsed = parseSummaryDraftStream("prefix <<<SUMMARY-DRAFT>>> still prose\n");
    expect(parsed.draft).toBeNull();
  });

  it("yields no draft when the model skips the sentinels entirely", () => {
    const parsed = parseSummaryDraftStream("STATUS: writing…\n## Needs you\nJust prose, no markers.\n");
    expect(parsed.draft).toBeNull();
    expect(parsed.draftClosed).toBe(false);
  });
});

describe("closeDanglingCodeFence", () => {
  it("appends a closing fence when a code block is left open", () => {
    const md = "Here is code:\n```ts\nconst x = 1;";
    expect(closeDanglingCodeFence(md)).toBe("Here is code:\n```ts\nconst x = 1;\n```");
  });

  it("leaves balanced fences untouched", () => {
    const md = "```ts\nconst x = 1;\n```";
    expect(closeDanglingCodeFence(md)).toBe(md);
  });

  it("leaves fence-free markdown untouched", () => {
    const md = "## Needs you\n- one\n- two";
    expect(closeDanglingCodeFence(md)).toBe(md);
  });
});
