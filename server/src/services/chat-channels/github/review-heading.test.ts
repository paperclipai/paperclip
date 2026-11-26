import { describe, expect, it } from "vitest";
import { githubReviewHeading } from "./review-heading.js";

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
