import { expect, it } from "vitest";
import { taskReplyContentMatches } from "./task-reply-content.js";

it("parses CommonMark escapes, entities, inline formatting and paragraph boundaries", () => {
  expect(taskReplyContentMatches({ body: "Visible" }, "~~Visible~~")).toBe(true);
  expect(taskReplyContentMatches({ body: "Couldn't retrieve a_b & c. No retry." },
    "**Couldn't retrieve** `a_b` &amp; c.\n\nNo _retry_.")).toBe(true);
  expect(taskReplyContentMatches({ body: "Couldn't retrieve a_b & c. No retry. Extra." },
    "**Couldn't retrieve** `a_b` &amp; c.\n\nNo _retry_.")).toBe(false);
});

it("rejects unsupported Markdown rather than stripping unknown or invisible content", () => {
  for (const source of ["Visible <!-- hidden -->", "Visible ![image](https://fixture.test/image.png)", "|Column|\n|---|\n|Visible|"])
    expect(taskReplyContentMatches({ body: "Visible" }, source)).toBe(false);
});

it("matches generated GFM checkboxes and rejects changed check states", () => {
  const observation = { body: "Finished Next", content: [{ checked: true }, { text: " Finished " }, { checked: false }, { text: " Next" }] };
  expect(taskReplyContentMatches(observation, "- [x] Finished\n- [ ] Next")).toBe(true);
  expect(taskReplyContentMatches(observation, "- [ ] Finished\n- [ ] Next")).toBe(false);
});

it("uses production GFM autolinks and issue linking with the viewer's known companies", () => {
  const context = { pageUrl: "https://fixture.test/QA/issues/QA-1", knownCompanyPrefixes: ["QA"] };
  expect(taskReplyContentMatches({ ...context, body: "Depends on QA-123.", content: [{ text: "Depends on " },
    { href: "/QA/issues/QA-123", label: "QA-123", decorated: true }, { text: "." }] }, "Depends on QA-123.")).toBe(true);
  expect(taskReplyContentMatches({ ...context, body: "See https://example.com/", content: [{ text: "See " },
    { href: "https://example.com/", label: "https://example.com/" }] }, "See https://example.com/")).toBe(true);
  expect(taskReplyContentMatches({ ...context, body: "Depends on TREE-604." }, "Depends on TREE-604.")).toBe(true);
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
