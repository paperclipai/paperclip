import { expect, it } from "vitest";
import { taskReplyContentMatches } from "./task-reply-content.js";

it("parses CommonMark escapes, entities, inline formatting and paragraph boundaries", () => {
  expect(taskReplyContentMatches({ body: "Couldn't retrieve a_b & c. No retry." },
    "**Couldn't retrieve** `a_b` &amp; c.\n\nNo _retry_.")).toBe(true);
  expect(taskReplyContentMatches({ body: "Couldn't retrieve a_b & c. No retry. Extra." },
    "**Couldn't retrieve** `a_b` &amp; c.\n\nNo _retry_.")).toBe(false);
});

it("rejects unsupported Markdown rather than stripping unknown or invisible content", () => {
  for (const source of ["Visible <!-- hidden -->", "Visible ![image](https://fixture.test/image.png)", "~~Visible~~"])
    expect(taskReplyContentMatches({ body: "Visible" }, source)).toBe(false);
});
