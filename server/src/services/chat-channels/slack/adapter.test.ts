import { SlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import { ConsoleLogger, type ChatInstance } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipSlackAdapter } from "./adapter.js";

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
    expect(received.text).toBe(original.text);
    expect(received.formatted).toEqual(original.formatted);
    expect(received.links).toEqual(original.links);
  });
});
