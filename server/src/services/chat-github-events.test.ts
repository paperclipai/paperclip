import type { GitHubReviewEventContext, GitHubReviewPolicy } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { githubAutomaticIssueEvent, githubBodyMentionsBot, githubCommentMentionsOnlyInCode, githubExplicitMentionEvent } from "./chat-github-events.js";
import { createInboundEnvelope } from "./chat-channels/inbound/envelope.js";

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
  it.each([
    "Quoting the runbook:\n```\n@maya notes\n```",
    "See `echo @maya[bot]` in the script",
    "~~~\n@maya ping\n~~~",
    "- quoted\n    ```\n    @maya inside list fence\n    ```",
    "Unclosed fence:\n```\n@maya",
    "`code``` @maya `",
    "text\n\n    @maya indented code",
  ])("ignores a bot mention inside code: %s", (body) => {
    expect(githubBodyMentionsBot(body, "maya[bot]")).toBe(false);
  });
  it.each([
    "~~~\r\nlog\r\n~~~\r\n@maya please help",
    "    ~~~\n\n@maya please help",
    "para\n    ~~~\n\n@maya please help",
  ])("still recognizes a mention rendered outside code: %s", (body) => {
    expect(githubBodyMentionsBot(body, "maya[bot]")).toBe(true);
  });
  it("still recognizes a prose mention next to code that names the bot", () => {
    expect(githubBodyMentionsBot("Log:\n```\n@maya x\n```\n@maya please look", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("`@maya` said to ping @maya", "maya[bot]")).toBe(true);
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

  it("keeps a mention in a list continuation paragraph after a blank line", () => {
    expect(githubBodyMentionsBot("- item\n\n    @maya help", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("- item\n\n      @maya help", "maya[bot]")).toBe(false);
    expect(githubBodyMentionsBot("- item\n\n    ```\n      @maya help\n    ```", "maya[bot]")).toBe(false);
  });

  it("counts tab stops so two tabs after a list marker are an indented code block", () => {
    expect(githubBodyMentionsBot("- item\n\n\t@maya", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("- item\n\n\t\t@maya", "maya[bot]")).toBe(false);
    expect(githubBodyMentionsBot("text\n\n\t\t@maya", "maya[bot]")).toBe(false);
  });

  it("ends a list's unclosed fence when a paragraph leaves the list", () => {
    expect(githubBodyMentionsBot("- item\n\n    ```\n    log\n\n@maya help", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("- item\n\n    ```\n    @maya log\n    more\n\n@maya help", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("- item\n\n    ```\n    @maya log\nmore text", "maya[bot]")).toBe(false);
    expect(githubBodyMentionsBot("- item\n\n    ```\n    log\n```\n@maya log", "maya[bot]")).toBe(false);
  });

  it("ends the list before a less-indented line, which can be top-level code", () => {
    expect(githubBodyMentionsBot("100. item\n\n     ~~~\n     log\n\n    @maya", "maya[bot]")).toBe(false);
    expect(githubBodyMentionsBot("100. item\n\n    @maya", "maya[bot]")).toBe(false);
    expect(githubBodyMentionsBot("100. item\n\n     @maya", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("100. item\n\n     ~~~\n     @maya log\n     ~~~\n    @maya", "maya[bot]")).toBe(false);
  });

  it("keeps list context through a lazily indented paragraph continuation", () => {
    expect(githubBodyMentionsBot("100. item\n    continuation\n\n     @maya help", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("100. item\n    @maya help", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("100. item\n    continuation\n\n    @maya", "maya[bot]")).toBe(false);
  });

  it("keeps a fence-looking lazy continuation as list paragraph text", () => {
    // "    ~~~"/"    ```" sit below the list content column, so they continue
    // the item's paragraph as text instead of opening a code fence.
    expect(githubBodyMentionsBot("100. item\n    ~~~\n@maya help", "maya[bot]")).toBe(true);
    expect(githubBodyMentionsBot("100. item\n    ```\n@maya help", "maya[bot]")).toBe(true);
    // A fence at the list content column still opens inside the item.
    expect(githubBodyMentionsBot("100. item\n     ~~~\n     @maya help\n     ~~~", "maya[bot]")).toBe(false);
    // A top-level fence at column zero still interrupts the list.
    expect(githubBodyMentionsBot("100. item\n~~~\n@maya help\n~~~", "maya[bot]")).toBe(false);
  });

  it("downgrades a code-only mention trigger before the envelope is addressed", async () => {
    const message = {
      id: "m1", text: "@maya", isMention: true,
      author: { userId: "u1", fullName: "A", userName: "a" },
      attachments: [], metadata: {},
      raw: { comment: { body: "Use `@maya` for this" } },
    };
    const thread = { id: "github:Acme/Repo:issue:2", channelId: "github:acme/repo", channel: { name: "acme/repo" }, isDM: false };
    const endpoint = { id: "e1", companyId: "c1", provider: "github", botUsername: "maya[bot]", providerAccountId: "1", botExternalId: "b1" };
    const githubManualMessages = new WeakMap<object, { policy: GitHubReviewPolicy; revision: number; event: "mention" | "comment" }>();
    githubManualMessages.set(message, { policy: {} as GitHubReviewPolicy, revision: 1, event: "mention" });
    const { prepareInboundEnvelope } = createInboundEnvelope({} as never, {
      runtimeFor: async () => ({}) as never,
      sanitizeFilename: (v) => v ?? null,
      githubManualMessages,
      githubAutomaticMessages: new WeakMap(),
      githubIssueMessages: new WeakMap(),
      githubCommentMentionsOnlyInCode,
    });
    const envelope = await prepareInboundEnvelope({
      endpoint, thread, message,
      trigger: "mention",
      receiptReactionSupported: false,
      recoveredProviderUrl: null,
      admittedDeliveryId: null,
      suppressSetupDestinationActivation: false,
      slackSlashControl: false,
    } as never);
    expect(envelope.addressed).toBe(false);
    expect(envelope.eventKind).toBe("message");
    expect(envelope.normalized.trigger).toBe("unaddressed_message");
    expect(envelope.normalized.message.mentionedBot).toBe(false);
    expect(envelope.redactedDestinationNormalized.trigger).toBe("unaddressed_message");
  });

  it("keeps the automatic mention trigger when generated text names no bot", async () => {
    const message = {
      id: "m2", text: "GitHub pull request opened for the assigned Paperclip agent.", isMention: true,
      author: { userId: "u1", fullName: "A", userName: "a" },
      attachments: [], metadata: {}, raw: {},
    };
    const thread = { id: "github:Acme/Repo:3", channelId: "github:acme/repo", channel: { name: "acme/repo" }, isDM: false };
    const endpoint = { id: "e1", companyId: "c1", provider: "github", botUsername: "maya[bot]", providerAccountId: "1", botExternalId: "b1" };
    const githubAutomaticMessages = new WeakMap<object, { context: GitHubReviewEventContext; revision: number; policy: GitHubReviewPolicy }>();
    githubAutomaticMessages.set(message, { context: {} as GitHubReviewEventContext, revision: 1, policy: {} as GitHubReviewPolicy });
    const { prepareInboundEnvelope } = createInboundEnvelope({} as never, {
      runtimeFor: async () => ({}) as never,
      sanitizeFilename: (v) => v ?? null,
      githubManualMessages: new WeakMap(),
      githubAutomaticMessages,
      githubIssueMessages: new WeakMap(),
      githubCommentMentionsOnlyInCode,
    });
    const envelope = await prepareInboundEnvelope({
      endpoint, thread, message,
      trigger: "mention",
      receiptReactionSupported: false,
      recoveredProviderUrl: null,
      admittedDeliveryId: null,
      suppressSetupDestinationActivation: false,
      slackSlashControl: false,
    } as never);
    expect(envelope.addressed).toBe(true);
    expect(envelope.eventKind).toBe("mention");
    expect(envelope.normalized.trigger).toBe("mention");
    expect(envelope.normalized.message.mentionedBot).toBe(true);
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
