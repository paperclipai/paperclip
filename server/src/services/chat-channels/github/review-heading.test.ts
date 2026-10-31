import { describe, expect, it } from "vitest";
import { githubReviewHeading, githubReviewSummary } from "./review-heading.js";

describe("GitHub review heading", () => {
  it("uses the GitHub bot display name independently of the assigned agent", () => {
    expect(githubReviewHeading({ botDisplayName: "Ponytail Bottybois Review", botUsername: "ponytail-bottybois-review[bot]", agentName: "Ponytail", score: 3 }))
      .toBe("## Ponytail Bottybois Review — 3/5");
  });
  it("falls back to the bot login, then the agent name, for older connections", () => {
    expect(githubReviewHeading({ botDisplayName: null, botUsername: "ponytail[bot]", agentName: "Ponytail", score: null }))
      .toBe("## ponytail — Incomplete");
    expect(githubReviewHeading({ botDisplayName: " ", botUsername: null, agentName: "Ponytail", score: 5 }))
      .toBe("## Ponytail — 5/5");
  });
  it("keeps provider display names from injecting Markdown or additional lines", () => {
    expect(githubReviewHeading({ botDisplayName: "[Bot](https://example.test)\n<script>", botUsername: null, agentName: "Fallback", score: 4 }))
      .toBe("## \\[Bot\\](https://example.test) \\<script\\> — 4/5");
  });
});

describe("GitHub review summary", () => {
  const identity = { botDisplayName: "New Review Bot", botUsername: "reviewer[bot]", agentName: "Reviewer", score: 4 };

  it.each(["4/5", "2/5", "Incomplete"])("replaces copied %s headings with the structured score", rating => {
    expect(githubReviewSummary({ ...identity,
      summary: `## New Review Bot — ${rating}\n\n## Paperclip Review — 3/5\n\nReview body.`,
      rationale: `## New Review Bot — ${rating}\n\nScore evidence.`,
    })).toBe("## New Review Bot — 4/5\n\nReview body.\n\nScore evidence.");
  });

  it("keeps an incomplete assessment authoritative", () => {
    expect(githubReviewSummary({ ...identity, score: null,
      summary: "## New Review Bot — 5/5\n\nPartial review.", rationale: "Missing context.",
    })).toBe("## New Review Bot — Incomplete\n\nPartial review.\n\nMissing context.");
  });

  it.each([
    ["Review_Bot", "Review\\_Bot"],
    ["[Review]", "\\[Review\\]"],
    ["Review\\Bot", "Review\\\\Bot"],
  ])("accepts plain and escaped copied names for %s", (botDisplayName, escapedName) => {
    expect(githubReviewSummary({ ...identity, botDisplayName,
      summary: `## ${botDisplayName} — 2/5\n\n## ${escapedName} — 3/5\n\nReview body.`,
      rationale: `## ${botDisplayName} — 4/5\n\nScore evidence.`,
    })).toBe(`## ${escapedName} — 4/5\n\nReview body.\n\nScore evidence.`);
  });

  it("preserves other headings and quoted score lines inside the review body", () => {
    const summary = "## Findings\n\nReview body.\n\n```markdown\n## New Review Bot — 2/5\n```";
    const rationale = "## Other Bot — 3/5\n\nComparison evidence.";
    expect(githubReviewSummary({ ...identity, summary, rationale }))
      .toBe(`## New Review Bot — 4/5\n\n${summary}\n\n${rationale}`);
  });

  it("preserves indented code after removing a copied heading", () => {
    const code = "    ## New Review Bot — 2/5\n    example()";
    expect(githubReviewSummary({ ...identity, summary: `## New Review Bot — 4/5\n\n${code}`, rationale: "Evidence." }))
      .toBe(`## New Review Bot — 4/5\n\n${code}\n\nEvidence.`);
  });
});
