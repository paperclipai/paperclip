import { describe, expect, it } from "vitest";
import {
  buildJoinDefaultsPayloadForAccept,
  canReplayOpenClawGatewayInviteAccept,
  mergeJoinDefaultsPayloadForReplay,
} from "../routes/access.js";

describe("canReplayOpenClawGatewayInviteAccept", () => {
  it("allows replay only for openclaw_gateway agent joins in pending or approved state", () => {
    expect(
      canReplayOpenClawGatewayInviteAccept({
        requestType: "agent",
        adapterType: "openclaw_gateway",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw_gateway",
          status: "pending_approval",
        },
      }),
    ).toBe(true);

    expect(
      canReplayOpenClawGatewayInviteAccept({
        requestType: "agent",
        adapterType: "openclaw_gateway",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw_gateway",
          status: "approved",
        },
      }),
    ).toBe(true);

    expect(
      canReplayOpenClawGatewayInviteAccept({
        requestType: "agent",
        adapterType: "openclaw_gateway",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw_gateway",
          status: "rejected",
        },
      }),
    ).toBe(false);

    expect(
      canReplayOpenClawGatewayInviteAccept({
        requestType: "human",
        adapterType: "openclaw_gateway",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw_gateway",
          status: "pending_approval",
        },
      }),
    ).toBe(false);
  });
});

describe("mergeJoinDefaultsPayloadForReplay", () => {
  it("merges replay payloads and allows gateway token override", () => {
    const merged = mergeJoinDefaultsPayloadForReplay(
      {
        url: "ws://old.example:18789",
        paperclipApiUrl: "http://host.docker.internal:3100",
        headers: {
          "x-openclaw-token": "old-token-1234567890",
          "x-custom": "keep-me",
        },
      },
      {
        paperclipApiUrl: "https://paperclip.example.com",
        headers: {
          "x-openclaw-token": "new-token-1234567890",
        },
      },
    );

    const normalized = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: merged,
      inboundOpenClawAuthHeader: null,
    }) as Record<string, unknown>;

    expect(normalized.url).toBe("ws://old.example:18789");
    expect(normalized.paperclipApiUrl).toBe("https://paperclip.example.com");
    expect(normalized.headers).toMatchObject({
      "x-openclaw-token": "new-token-1234567890",
      "x-custom": "keep-me",
    });
  });
});
