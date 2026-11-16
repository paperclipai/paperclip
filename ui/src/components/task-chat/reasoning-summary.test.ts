import { describe, expect, it } from "vitest";
import { hasReasoningHeadlines, latestReasoningHeadline, reasoningSummarySections } from "./reasoning-summary";

const CODEX = "**Tracing the retry path**\n\nThe worker retries on 5xx.\n\n**Verifying edge cases**\n\nTwo workers can claim one retry.";

describe("reasoning summary sections", () => {
  it("starts a section at every provider headline and keeps its prose", () => {
    expect(reasoningSummarySections(CODEX)).toEqual([
      { headline: "Tracing the retry path", body: "The worker retries on 5xx." },
      { headline: "Verifying edge cases", body: "Two workers can claim one retry." },
    ]);
  });

  it("splits headline-only parts streamed with blank-line separators", () => {
    const sections = reasoningSummarySections("**Reading the worker**\n\n**Checking `event_id`**");
    expect(sections.map((section) => section.headline)).toEqual(["Reading the worker", "Checking event_id"]);
    expect(latestReasoningHeadline("**Reading the worker**\n\n**Checking `event_id`**")).toBe("Checking event_id");
  });

  it("leaves prose-only summaries as one headline-free section", () => {
    const sections = reasoningSummarySections("The user wants **no** contract change.\nSo keep it small.");
    expect(hasReasoningHeadlines(sections)).toBe(false);
    expect(sections).toHaveLength(1);
    expect(latestReasoningHeadline("Plain prose.")).toBeNull();
  });

  it("shows a headline while its closing emphasis is still streaming", () => {
    expect(latestReasoningHeadline("**Tracing the retry path**\n\n**Verifying edge")).toBe("Verifying edge");
    expect(latestReasoningHeadline("**Tracing the retry path**\n\nThe **worker")).toBe("Tracing the retry path");
  });

  it("keeps bold lines inside fenced code as code, not headlines", () => {
    const text = "**Drafting the example**\n\n```md\n**Example**\nbody\n```\n\nDone.";
    const sections = reasoningSummarySections(text);
    expect(sections.map((section) => section.headline)).toEqual(["Drafting the example"]);
    expect(sections[0]?.body).toContain("**Example**");
    expect(latestReasoningHeadline(text)).toBe("Drafting the example");
  });

  it("treats single-line triple-backtick code as inline, not an open fence", () => {
    const text = "**Checking the constant**\n\n```const x = 1```\n\n**Verifying edge cases**";
    expect(reasoningSummarySections(text).map((section) => section.headline))
      .toEqual(["Checking the constant", "Verifying edge cases"]);
    expect(latestReasoningHeadline(text)).toBe("Verifying edge cases");
  });

  it("closes a fence only with a matching fence of at least the same length", () => {
    const text = "**Drafting**\n\n````md\n```\n**Inside**\n````\n\n**After the sample**";
    expect(reasoningSummarySections(text).map((section) => section.headline)).toEqual(["Drafting", "After the sample"]);
  });
});
