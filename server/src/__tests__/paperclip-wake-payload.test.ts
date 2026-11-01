import { describe, expect, it } from "vitest";
import { normalizePaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";

describe("paperclip wake payload normalization", () => {
  it("replaces markdown image attachments in inline comment bodies", () => {
    const normalized = normalizePaperclipWakePayload({
      comments: [
        {
          id: "c1",
          issueId: "i1",
          body: "Please review ![error screenshot](https://cdn.example.com/image.png) before merge",
          createdAt: "2026-04-08T16:40:00.000Z",
          author: { type: "user", id: "u1" },
        },
      ],
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.comments).toHaveLength(1);
    expect(normalized?.comments[0]?.body).toBe(
      "Please review [image attachment omitted: https://cdn.example.com/image.png] before merge",
    );
  });

  it("keeps parenthesized image URLs intact when sanitizing markdown image attachments", () => {
    const normalized = normalizePaperclipWakePayload({
      comments: [
        {
          id: "c2",
          issueId: "i1",
          body: "Reference ![diagram](https://example.com/image(1).png) for context",
          createdAt: "2026-04-08T16:40:00.000Z",
          author: { type: "user", id: "u1" },
        },
      ],
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.comments).toHaveLength(1);
    expect(normalized?.comments[0]?.body).toBe(
      "Reference [image attachment omitted: https://example.com/image(1).png] for context",
    );
  });

  it("sanitizes an unclosed image link in linear time (ReDoS guard)", () => {
    // The naive nested-quantifier regex form backtracks exponentially on an
    // image link that is opened but never closed; ~30 characters already cost
    // seconds. The unrolled-loop form must stay linear even on a huge body.
    const hostile = `See ![x](${"a".repeat(50_000)}`;

    const startedAt = performance.now();
    const normalized = normalizePaperclipWakePayload({
      comments: [
        {
          id: "c3",
          issueId: "i1",
          body: hostile,
          createdAt: "2026-04-08T16:40:00.000Z",
          author: { type: "user", id: "u1" },
        },
      ],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(normalized?.comments).toHaveLength(1);
    // Unclosed link is not a match — body passes through unchanged.
    expect(normalized?.comments[0]?.body).toBe(hostile);
    // Linear scan finishes in well under a second; the vulnerable form would
    // effectively hang here.
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
