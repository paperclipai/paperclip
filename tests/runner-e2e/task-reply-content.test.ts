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

it("uses the production company prefix and current task URL without accepting a changed target", () => {
  const observation = { body: "Read Outcome", pageUrl: "https://fixture.test/QA/issues/QA-123",
    content: [{ text: "Read " }, { href: "/QA/issues/QA-123#document-outcome", label: "Outcome" }] };
  for (const href of ["/issues/QA-123#document-outcome", "#document-outcome"])
    expect(taskReplyContentMatches(observation, `Read [Outcome](${href})`)).toBe(true);
  for (const href of ["/QA/issues/QA-999#document-outcome", "#document-other"])
    expect(taskReplyContentMatches(observation, `Read [Outcome](${href})`)).toBe(false);
  expect(taskReplyContentMatches({ ...observation, content: [{ text: "Read " },
    { href: "/OTHER/issues/QA-123#document-outcome", label: "Outcome" }] }, "Read [Outcome](/issues/QA-123#document-outcome)")).toBe(false);
});
