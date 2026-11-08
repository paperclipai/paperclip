import { expect, it } from "vitest";
import { inboxAuthorCommentMatches } from "./inbox-author-contract.js";

const expected = { companyId: "company", issueId: "issue", ownerUserId: "owner", authorUserId: "fixture-human", body: "Fresh fixture update" };
const comment = { id: "comment", companyId: "company", issueId: "issue", body: expected.body,
  authorUserId: "fixture-human", authorAgentId: null, createdByRunId: null };
it("requires the independently authenticated human's exact saved activity", () => {
  expect(inboxAuthorCommentMatches(comment, expected)).toBe(true);
});
it.each([
  undefined, null, { ...comment, id: "" }, { ...comment, companyId: "foreign" }, { ...comment, issueId: "foreign" },
  { ...comment, body: "stale or replaced activity" }, { ...comment, authorUserId: "owner" },
  { ...comment, authorUserId: null, authorAgentId: "fixture-agent" },
  { ...comment, authorAgentId: "agent" }, { ...comment, createdByRunId: "run" },
])("rejects wrong or missing external human activity %#", value => {
  expect(inboxAuthorCommentMatches(value, expected)).toBe(false);
});
it("rejects a fixture claiming the current user's identity or no author", () => {
  expect(inboxAuthorCommentMatches({ ...comment, authorUserId: "owner" }, { ...expected, authorUserId: "owner" })).toBe(false);
  expect(inboxAuthorCommentMatches(comment, { ...expected, authorUserId: "" })).toBe(false);
});
