import { describe, expect, it } from "vitest";
import { agentBubbleDateLabel } from "./AgentBubbleActionRow";

describe("agentBubbleDateLabel", () => {
  it("returns an empty string for undefined", () => {
    expect(agentBubbleDateLabel(undefined)).toBe("");
  });

  it("includes both date and time for a recent message (within 7 days)", () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const label = agentBubbleDateLabel(recent);
    // Must contain a time indicator (AM or PM) — not just a relative "ago" string
    expect(label).toMatch(/AM|PM/);
    // Must also contain the year so the date is present
    expect(label).toMatch(/\d{4}/);
  });

  it("includes both date and time for a message older than 7 days", () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const label = agentBubbleDateLabel(old);
    expect(label).toMatch(/AM|PM/);
    expect(label).toMatch(/\d{4}/);
  });

  it("never returns a relative-only string like '2h ago'", () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(agentBubbleDateLabel(recent)).not.toMatch(/ago/);
  });

  it("accepts a Date object as well as an ISO string", () => {
    const date = new Date("2026-01-15T10:30:00Z");
    const label = agentBubbleDateLabel(date);
    expect(label).toMatch(/AM|PM/);
    expect(label).toMatch(/2026/);
  });
});
