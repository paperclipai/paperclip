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
});
