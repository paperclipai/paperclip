import { describe, expect, it } from "vitest";
import {
  buildCursorCloudSessionUrl,
  extractCursorAgentIdFromResultJson,
  extractCursorAgentIdFromTranscript,
  resolveCursorAgentIdForRun,
} from "./cursor-cloud-session";

const SAMPLE_ID = "bc-00000000-0000-0000-0000-000000000001";

describe("cursor-cloud-session", () => {
  it("builds the official Cursor agents URL", () => {
    expect(buildCursorCloudSessionUrl(SAMPLE_ID)).toBe(
      "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001",
    );
  });

  it("reads cursorAgentId from resultJson", () => {
    expect(extractCursorAgentIdFromResultJson({ cursorAgentId: SAMPLE_ID })).toBe(SAMPLE_ID);
  });

  it("reads sessionId from transcript init entries", () => {
    expect(
      extractCursorAgentIdFromTranscript([
        { kind: "init", sessionId: SAMPLE_ID },
      ]),
    ).toBe(SAMPLE_ID);
  });

  it("resolves only for cursor_cloud adapter runs", () => {
    expect(
      resolveCursorAgentIdForRun({
        adapterType: "opencode_local",
        resultJson: { cursorAgentId: SAMPLE_ID },
      }),
    ).toBeNull();

    expect(
      resolveCursorAgentIdForRun({
        adapterType: "cursor_cloud",
        resultJson: { cursorAgentId: SAMPLE_ID },
      }),
    ).toBe(SAMPLE_ID);
  });
});
