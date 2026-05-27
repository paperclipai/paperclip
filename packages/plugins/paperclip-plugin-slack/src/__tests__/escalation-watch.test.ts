import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  formatHumanDecisionEscalationMessage,
  postHumanDecisionEscalation,
  shouldSuppressHumanDecisionEscalation,
} from "../escalation-watch.js";
import { DEFAULT_CONFIG, ESCALATION_NEEDS_HUMAN_DECISION_EVENT } from "../constants.js";

const mkEvent = (): PluginEvent => ({
  eventId: "event-1",
  eventType: ESCALATION_NEEDS_HUMAN_DECISION_EVENT as any,
  occurredAt: "2026-05-27T09:00:00.000Z",
  entityId: "issue-uuid-1",
  entityType: "issue",
  companyId: "company-1",
  payload: {
    issueId: "issue-uuid-1",
    identifier: "BLO-7685",
    title: "Slack escalation watch is stranded",
    assigneeName: "CodexCoder",
    blockedBy: [
      {
        id: "11111111-2222-3333-4444-555555555555",
        identifier: "BLO-7684",
        title: "Emit event",
      },
    ],
  },
});

const mkCtx = () => {
  const values = new Map<string, unknown>();
  const fetch = vi.fn().mockResolvedValue({
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: true, ts: "171.42" }),
  });
  return {
    ctx: {
      http: { fetch },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      state: {
        get: vi.fn(async ({ stateKey }: { stateKey: string }) => values.get(stateKey)),
        set: vi.fn(async ({ stateKey }: { stateKey: string }, value: unknown) => {
          values.set(stateKey, value);
        }),
      },
      activity: { log: vi.fn(async () => {}) },
      metrics: { write: vi.fn(async () => {}) },
    },
    fetch,
  };
};

describe("formatHumanDecisionEscalationMessage", () => {
  it("renders issue links, take-ownership action, assignee, and blocker identifiers", () => {
    const message = formatHumanDecisionEscalationMessage(mkEvent(), {
      paperclipBaseUrl: "https://paperclip.blockcast.network",
    });
    const body = JSON.stringify(message);

    expect(message.text).toContain("BLO-7685");
    expect(body).toContain("https://paperclip.blockcast.network/BLO/issues/BLO-7685");
    expect(body).toContain("?reassign=user");
    expect(body).toContain("CodexCoder");
    expect(body).toContain("BLO-7684");
    expect(body).not.toContain("11111111-2222-3333-4444-555555555555");
  });
});

describe("shouldSuppressHumanDecisionEscalation", () => {
  it("suppresses repeats inside the dedupe window", () => {
    expect(
      shouldSuppressHumanDecisionEscalation(
        "2026-05-27T09:00:00.000Z",
        Date.parse("2026-05-27T09:30:00.000Z"),
        3600000,
      ),
    ).toBe(true);
  });

  it("allows repeats after the dedupe window expires", () => {
    expect(
      shouldSuppressHumanDecisionEscalation(
        "2026-05-27T09:00:00.000Z",
        Date.parse("2026-05-27T10:01:00.000Z"),
        3600000,
      ),
    ).toBe(false);
  });
});

describe("postHumanDecisionEscalation", () => {
  it("posts exactly one Slack message for duplicate events inside the dedupe window", async () => {
    const { ctx, fetch } = mkCtx();
    const config = {
      ...DEFAULT_CONFIG,
      slackTokenRef: "token-ref",
      escalationChatId: "C0B1ULYM770",
      paperclipBaseUrl: "https://paperclip.blockcast.network",
      escalationDedupeWindowMs: 3600000,
    };

    const first = await postHumanDecisionEscalation(
      ctx as any,
      "xoxb-test",
      config,
      mkEvent(),
      Date.parse("2026-05-27T09:00:00.000Z"),
    );
    const second = await postHumanDecisionEscalation(
      ctx as any,
      "xoxb-test",
      config,
      mkEvent(),
      Date.parse("2026-05-27T09:30:00.000Z"),
    );

    expect(first).toEqual({ posted: true, deduped: false, ts: "171.42" });
    expect(second).toEqual({ posted: false, deduped: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.channel).toBe("C0B1ULYM770");
    expect(JSON.stringify(body)).toContain("BLO-7684");
    expect(JSON.stringify(body)).not.toContain("11111111-2222-3333-4444-555555555555");
  });
});
