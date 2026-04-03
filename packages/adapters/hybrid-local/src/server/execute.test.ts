import { describe, expect, it } from "vitest";

const HANDOFF_REGEX = /^\s*HANDOFF:\s*true\b.*$/im;

function extractHandoffMarker(text: string): { requested: boolean; cleaned: string } {
  if (!text) return { requested: false, cleaned: text };
  const requested = HANDOFF_REGEX.test(text);
  if (!requested) return { requested: false, cleaned: text };
  const cleaned = text
    .split(/\r?\n/)
    .filter((line) => !HANDOFF_REGEX.test(line))
    .join("\n")
    .trim();
  return { requested: true, cleaned };
}

describe("extractHandoffMarker", () => {
  it("returns false when no marker present", () => {
    const input = "All good. No handoff.";
    expect(extractHandoffMarker(input)).toEqual({ requested: false, cleaned: input });
  });

  it("detects and strips HANDOFF marker", () => {
    const input = "Need code changes.\nHANDOFF: true";
    expect(extractHandoffMarker(input)).toEqual({
      requested: true,
      cleaned: "Need code changes.",
    });
  });

  it("removes marker line even with extra whitespace", () => {
    const input = "Plan summary.\n\n  HANDOFF: true  \n";
    expect(extractHandoffMarker(input)).toEqual({
      requested: true,
      cleaned: "Plan summary.",
    });
  });
});
