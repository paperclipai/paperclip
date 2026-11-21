import { SlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import { Chat, ConsoleLogger, type ChatInstance, type Message } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipSlackAdapter } from "./adapter.js";
import { slackMessageMeetsMentionRequirement, slackInboundRequestText } from "./messages.js";

afterEach(() => vi.useRealTimers());

describe("Slack inbound link latency", () => {
  it("accepts URL text and files without the SDK's two-second unfurl wait", async () => {
    vi.useFakeTimers();
    const state = { get: vi.fn(async () => null) };
    const chat = { getState: () => state } as unknown as ChatInstance;
    class Baseline extends SlackAdapter {
      parse(event: SlackEvent) { this.chat = chat; return this.parseSlackMessage(event, "slack:C123:1740000001.1"); }
    }
    class Candidate extends PaperclipSlackAdapter {
      parse(event: SlackEvent) { this.chat = chat; return this.parseSlackMessage(event, "slack:C123:1740000001.1"); }
    }
    const event = { type: "app_mention", channel: "C123", ts: "1740000001.1", username: "Test sender",
      text: "Review <https://example.com/review|this link>",
      files: [{ id: "F123", name: "notes.txt", mimetype: "text/plain", url_private: "https://files.slack.com/notes.txt" }],
    } as SlackEvent;
    const config = { botToken: "xoxb-synthetic", signingSecret: "synthetic", userName: "test-bot", logger: new ConsoleLogger("silent") };
    const received = await new Candidate(config).parse(event);
    expect(received.text).toBe("Review this link");
    expect(slackInboundRequestText(received)).toBe("Review this link (https://example.com/review)");
    expect(received.links).toMatchObject([{ url: "https://example.com/review" }]);
    expect(received.attachments).toMatchObject([{ name: "notes.txt", fetchData: expect.any(Function) }]);
    expect(state.get).not.toHaveBeenCalled();

    let baselineComplete = false;
    const baseline = new Baseline(config).parse(event).then((message) => { baselineComplete = true; return message; });
    await vi.advanceTimersByTimeAsync(1_950);
    expect(baselineComplete).toBe(false);
    expect(state.get).toHaveBeenCalledWith("slack:unfurls:1740000001.1");
    await vi.runAllTimersAsync();
    const original = await baseline;
    expect(original.text).toBe("Review this link");
    expect(received.formatted).toEqual(original.formatted);
    expect(received.links).toEqual(original.links);
  });
});

describe("Slack inbound link destinations", () => {
  const config = { botToken: "xoxb-synthetic", signingSecret: "synthetic", userName: "test-bot", logger: new ConsoleLogger("silent") };
  class Candidate extends PaperclipSlackAdapter {
    parse(event: SlackEvent) { return this.parseSlackMessage(event, "slack:C123:1740000001.1"); }
  }
  it.each([
    ["Review <https://example.com/project/123/replay/abc?from=recording&amp;return_to=%2Fhome|example.com/project/…/…>", "Review example.com/project/…/… (https://example.com/project/123/replay/abc?from=recording&return_to=%2Fhome)"],
    ["Bug <https://example.com/REP/chats/abc|example.com/REP/chats/…>", "Bug example.com/REP/chats/… (https://example.com/REP/chats/abc)"],
    ["<https://example.com/full|https://example.com/full>", "https://example.com/full"],
    ["<https://example.com/bare>", "https://example.com/bare"],
    ["plain *bold* and `code`", "plain bold and code"],
    ["`<https://example.com/code|literal>`", "[literal](https://example.com/code)"],
    ["<@U123> <#C123|general> &amp; &lt;words&gt;", "@U123 #general (C123) & <words>"],
    ["<https://example.com/a|same> <https://example.com/b|same>", "same (https://example.com/a) same (https://example.com/b)"],
  ])("preserves author links for async and sync parsing: %s", async (text, expected) => {
    const adapter = new Candidate(config);
    const event = { type: "message", channel: "C123", ts: "1740000001.1", username: "Test sender", text } as SlackEvent;
    const received = await adapter.parse(event);
    expect(slackInboundRequestText(received)).toBe(expected);
    expect(slackInboundRequestText(adapter.parseMessage(event))).toBe(expected);
  });
});

// Exercise the pinned SDK routing implementation, rather than a copy of its regex.
it("does not route a hidden link destination as a bot mention", () => {
  const adapter = new PaperclipSlackAdapter({ botToken: "xoxb-synthetic", signingSecret: "synthetic", userName: "test-bot", logger: new ConsoleLogger("silent") });
  const sdk = Object.create(Chat.prototype) as { setMentionFlags(adapter: PaperclipSlackAdapter, message: Message): boolean };
  for (const url of ["https://example.com/@test-bot", "https://example.com/?user=@test-bot"]) {
    const message = adapter.parseMessage({ type: "message", channel: "C123", ts: "1740000001.1", username: "Test sender", text: `Look <${url}|profile>` });
    expect(sdk.setMentionFlags(adapter, message)).toBe(false);
    expect(message.isMention).toBe(false);
    expect(slackMessageMeetsMentionRequirement({ requireAtMention: true }, { id: "slack:C123:1740000001.1", isDM: false }, "subscribed_message", message)).toBe(false);
  }
  const addressed = adapter.parseMessage({ type: "message", channel: "C123", ts: "1740000001.1", username: "Test sender", text: "@test-bot review this" });
  expect(sdk.setMentionFlags(adapter, addressed)).toBe(true);
  expect(slackMessageMeetsMentionRequirement({ requireAtMention: true }, { id: "slack:C123:1740000001.1", isDM: false }, "mention", addressed)).toBe(true);
});
