import { describe, expect, it } from "vitest";
import { githubAutomaticIssueEvent, githubBodyMentionsBot, githubExplicitMentionEvent } from "./chat-github-events.js";

function payload() {
  return {
    action: "opened", repository: { id: 12, full_name: "Test/Repo" },
    sender: { id: 77, login: "sender" },
    issue: { number: 2, title: "Question", body: null, user: { id: 42, login: "author", type: "User" }, labels: [{ name: "triage" }] },
  };
}
describe("GitHub issue event parsing", () => {
  it("preserves author versus sender authority and bounds untrusted content", () => {
    const input = payload();
    expect(githubAutomaticIssueEvent(input, "delivery")).toMatchObject({
      event: "issue_opened", deliveryId: "delivery", repositoryId: "12", repository: "test/repo",
      issueNumber: 2, body: "", author: { id: "42", isBot: false }, sender: { id: "77" }, labels: ["triage"],
    });
    expect(githubAutomaticIssueEvent({ ...input, issue: { ...input.issue, body: "x".repeat(30000) } }, "delivery")!.body).toHaveLength(24000);
  });
  it("rejects pull requests, other actions, malformed repositories and unsafe numeric IDs", () => {
    const input = payload();
    expect(githubAutomaticIssueEvent({ ...input, issue: { ...input.issue, pull_request: {} } }, "delivery")).toBeNull();
    expect(githubAutomaticIssueEvent({ ...input, action: "edited" }, "delivery")).toBeNull();
    expect(githubAutomaticIssueEvent({ ...input, repository: { id: 12, full_name: "test/repo/extra" } }, "delivery")).toBeNull();
    expect(githubAutomaticIssueEvent({ ...input, sender: { id: Number.MAX_SAFE_INTEGER + 1, login: "sender" } }, "delivery")).toBeNull();
    expect(githubAutomaticIssueEvent({ ...input, issue: { ...input.issue, number: 0 } }, "delivery")).toBeNull();
  });
});

describe("explicit GitHub mentions", () => {
  it.each(["@maya help", "@MAYA[bot] help", "Hi, @maya."])("recognizes the bot's exact bare and bot identity: %s", (body) => {
    expect(githubBodyMentionsBot(body, "maya[bot]")).toBe(true);
  });
  it.each(["@maya-other", "@mayabot", "x@maya", "@someone"])("does not match a different identity: %s", (body) => {
    expect(githubBodyMentionsBot(body, "maya[bot]")).toBe(false);
  });
  it.each(["issues", "pull_request", "issue_comment", "pull_request_review_comment", "pull_request_review"])("normalizes a %s request into the matching issue or PR thread", (event) => {
    const issue = { ...payload().issue, body: "@maya help" };
    const comment = { id: 123, body: "@maya[bot] help", in_reply_to_id: 99 };
    const input = {
      ...payload(), action: event === "pull_request_review" ? "submitted" : event.includes("comment") ? "created" : "opened",
      issue, pull_request: issue, comment, review: comment,
    };
    const mention = githubExplicitMentionEvent(event, input, "delivery", "maya[bot]");
    expect(mention).toMatchObject({ sender: { id: "77", login: "sender" }, edited: false });
    expect(mention!.threadId).toBe(`github:Test/Repo:${event === "issues" || event === "issue_comment" ? "issue:" : ""}2${event === "pull_request_review_comment" ? ":rc:99" : ""}`);
  });
  it("puts PR conversation comments in the PR thread, and preserves the SDK comment identity", () => {
    const input = { ...payload(), action: "created", issue: { ...payload().issue, pull_request: {} }, comment: { id: 123, body: "@maya help" } };
    expect(githubExplicitMentionEvent("issue_comment", input, "delivery", "maya")).toMatchObject({ threadId: "github:Test/Repo:2", messageId: "123", url: "https://github.com/test/repo/pull/2#issuecomment-123" });
  });
  it.each(["issues", "pull_request", "issue_comment", "pull_request_review_comment", "pull_request_review"])("recognizes a newly added mention in an edited %s body", (event) => {
    const target = { ...payload().issue, body: "@maya help" };
    const content = { id: 123, body: "@maya help" };
    const input = { ...payload(), action: "edited", issue: target, pull_request: target, comment: content, review: content, changes: { body: { from: null } } };
    expect(githubExplicitMentionEvent(event, input, "edit", "maya")).toMatchObject({ edited: true, messageId: "mention-event:edit", receiptReactionSupported: false });
  });
  it("admits an edit adding a mention under the editor's identity, but not a persistent mention", () => {
    const input = { ...payload(), action: "edited", issue: { ...payload().issue, body: "@maya help" }, changes: { body: { from: "Old description" } } };
    expect(githubExplicitMentionEvent("issues", input, "edit-delivery", "maya")).toMatchObject({ edited: true, messageId: "mention-event:edit-delivery", sender: { id: "77" } });
    expect(githubExplicitMentionEvent("issues", { ...input, changes: { body: { from: "@maya[bot] old request" } } }, "delivery", "maya")).toBeNull();
    expect(githubExplicitMentionEvent("issues", { ...input, changes: { title: { from: "Old title" } } }, "delivery", "maya")).toBeNull();
    expect(githubExplicitMentionEvent("issues", { ...input, changes: undefined }, "delivery", "maya")).toBeNull();
  });
  it.each(["synchronize", "reopened", "ready_for_review", "closed", "deleted"])("does not replay a description mention on %s", (action) => {
    const input = { ...payload(), action, pull_request: { ...payload().issue, body: "@maya help" } };
    expect(githubExplicitMentionEvent("pull_request", input, "delivery", "maya")).toBeNull();
  });
  it("ignores bot senders, title-only mentions, malformed payloads and unsafe IDs", () => {
    const input = { ...payload(), issue: { ...payload().issue, body: "@maya help" } };
    expect(githubExplicitMentionEvent("issues", { ...input, sender: { ...input.sender, type: "Bot" } }, "delivery", "maya")).toBeNull();
    expect(githubExplicitMentionEvent("issues", { ...input, issue: { ...input.issue, body: null, title: "@maya" } }, "delivery", "maya")).toBeNull();
    expect(githubExplicitMentionEvent("issues", { ...input, repository: { id: 1, full_name: "wrong/repo/extra" } }, "delivery", "maya")).toBeNull();
    expect(githubExplicitMentionEvent("issues", { ...input, sender: { id: Number.MAX_SAFE_INTEGER + 1, login: "sender" } }, "delivery", "maya")).toBeNull();
    expect(githubExplicitMentionEvent("issues", input, "", "maya")).toBeNull();
  });
});
