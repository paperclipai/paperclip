import { describe, expect, it } from "vitest";

const fixedLegacySessionRegex = /(?:session[_ ]id\s*:\s*|session[_ ]saved[:\s]+)([a-zA-Z0-9_-]+)/i;

describe("Hermes session id parsing safety", () => {
  it("does not treat Hermes 'session ID from a previous CLI run' hint text as session id 'from'", () => {
    const combined = "Session not found: from\nUse a session ID from a previous CLI run (hermes sessions list).\n";

    expect(combined.match(fixedLegacySessionRegex)?.[1]).toBeUndefined();
  });

  it("still accepts explicit legacy session_id output", () => {
    const combined = "\nsession_id: 20260509_142000_8af893\n";

    expect(combined.match(fixedLegacySessionRegex)?.[1]).toBe("20260509_142000_8af893");
  });

  it("documents the unsafe legacy pattern that Paperclip sanitizes at the registry boundary", () => {
    const unsafeLegacyRegex = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;
    const combined = "Session not found: from\nUse a session ID from a previous CLI run (hermes sessions list).\n";

    expect(combined.match(unsafeLegacyRegex)?.[1]).toBe("from");
    expect(combined.match(fixedLegacySessionRegex)?.[1]).toBeUndefined();
  });
});
