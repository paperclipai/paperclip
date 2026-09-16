import { describe, expect, it, vi } from "vitest";
import {
  parseSlackSessionStop,
  setSlackSessionStatus,
  slackSessionStatusForPublication,
} from "./chat-slack-sessions.js";

const stopEnvelope = {
  type: "event_callback",
  team_id: "T123456",
  event_id: "Ev123456",
  event: {
    type: "agent_session_stopped",
    channel: "C123456",
    user: "U123456",
    thread_ts: "1788790000.123456",
    event_ts: "1788790042.654321",
    streaming_message_ts: [],
  },
};

describe("Slack agent sessions", () => {
  it("parses native Stop without requiring an active Slack stream", () => {
    expect(parseSlackSessionStop(stopEnvelope, "T123456")).toEqual({
      providerEventId: "Ev123456",
      threadId: "slack:C123456:1788790000.123456",
      userId: "U123456",
      eventTimestamp: "1788790042.654321",
      occurredAt: new Date(1788790042654),
    });
  });

  it("rejects missing or foreign workspace and malformed identity or time", () => {
    expect(parseSlackSessionStop(stopEnvelope, null)).toBeNull();
    expect(parseSlackSessionStop(stopEnvelope, "TOTHER")).toBeNull();
    expect(
      parseSlackSessionStop({ ...stopEnvelope, team_id: undefined }, "T123456"),
    ).toBeNull();
    for (const patch of [
      { type: "message" },
      { channel: "C123:injected" },
      { user: "B123456" },
      { thread_ts: "1788790000.1:injected" },
      { event_ts: "NaN" },
      { event_ts: "0.000000" },
    ]) {
      expect(
        parseSlackSessionStop(
          { ...stopEnvelope, event: { ...stopEnvelope.event, ...patch } },
          "T123456",
        ),
      ).toBeNull();
    }
  });

  it("projects only coarse safe lifecycle and closes completed conversations", () => {
    for (const progressState of ["working", "queued"] as const) {
      expect(slackSessionStatusForPublication({ progressState }, false)).toBe(
        "processing",
      );
    }
    expect(
      slackSessionStatusForPublication(
        { progressState: "waiting_for_input" },
        false,
      ),
    ).toBe("suspended");
    expect(
      slackSessionStatusForPublication({ progressState: "failed" }, false),
    ).toBe("active");
    expect(slackSessionStatusForPublication({}, false)).toBe("active");
    expect(
      slackSessionStatusForPublication({ progressState: "working" }, true),
    ).toBe("closed");
  });

  it("sets the exact thread status without copying titles or identity overrides", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true }),
    );
    await expect(
      setSlackSessionStatus({
        botToken: "synthetic-canary",
        threadId: "slack:C123456:1788790000.123456",
        status: "processing",
        fetch,
      }),
    ).resolves.toBe("updated");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/agents.sessions.setStatus");
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(request?.body))).toEqual({
      channel_id: "C123456",
      thread_ts: "1788790000.123456",
      status: "processing",
    });
  });

  it.each([
    "feature_disabled",
    "unknown_method",
    "method_not_supported_for_channel_type",
  ])(
    "keeps basic delivery available when sessions return %s",
    async (error) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ ok: false, error }),
      );
      await expect(
        setSlackSessionStatus({
          botToken: "synthetic-canary",
          threadId: "slack:C123456:1788790000.123456",
          status: "active",
          fetch,
        }),
      ).resolves.toBe("unavailable");
    },
  );

  it("retains structured flood-control hints for durable retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "retry-after": "1800" } },
      ),
    );
    await expect(
      setSlackSessionStatus({
        botToken: "synthetic-canary",
        threadId: "slack:C123456:1788790000.123456",
        status: "active",
        fetch,
      }),
    ).rejects.toMatchObject({
      status: 429,
      retryAfter: 1800,
      data: { error: "ratelimited" },
    });
  });

  it("does not expose request credentials or provider error content", async () => {
    for (const fetch of [
      vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error("synthetic-canary");
      }),
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(
          {
            ok: false,
            error: "synthetic-canary",
            description: "synthetic-canary",
          },
          { status: 500 },
        ),
      ),
    ]) {
      const error = await setSlackSessionStatus({
        botToken: "synthetic-canary",
        threadId: "slack:C123456:1788790000.123456",
        status: "active",
        fetch,
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("synthetic-canary");
      expect(JSON.stringify(error)).not.toContain("synthetic-canary");
    }
  });

  it("rejects a malformed destination before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      setSlackSessionStatus({
        botToken: "synthetic-canary",
        threadId: "slack:C123456:1788790000.1:extra",
        status: "active",
        fetch,
      }),
    ).rejects.toThrow("Invalid Slack session");
    expect(fetch).not.toHaveBeenCalled();
  });
});
