import { describe, it, expect } from "vitest";
import { slackShape } from "../slack.js";

describe("slackShape", () => {
  it("parses user-token nested response", () => {
    expect(
      slackShape.parseTokenResponse!({
        ok: true,
        authed_user: {
          access_token: "xoxp-USER",
          refresh_token: "xoxe-1-USER",
          expires_in: 43200,
          scope: "channels:read,chat:write",
        },
      }),
    ).toEqual({
      accessToken: "xoxp-USER",
      refreshToken: "xoxe-1-USER",
      expiresInSeconds: 43200,
      scope: ["channels:read", "chat:write"],
    });
  });

  it("parses bot-token flat response", () => {
    expect(
      slackShape.parseTokenResponse!({
        ok: true,
        access_token: "xoxb-BOT",
        expires_in: 43200,
        scope: "chat:write",
      }),
    ).toMatchObject({ accessToken: "xoxb-BOT", scope: ["chat:write"] });
  });

  it("parses team account info", () => {
    expect(
      slackShape.parseAccountInfo!({ team: { id: "T123", name: "Acme" } }),
    ).toEqual({ accountId: "T123", accountLabel: "Acme" });
  });

  it("throws when access_token is missing", () => {
    expect(() =>
      slackShape.parseTokenResponse!({ ok: false }),
    ).toThrow(/response_shape_violation/);
  });

  it("throws when team.id is missing", () => {
    expect(() => slackShape.parseAccountInfo!({})).toThrow(
      /response_shape_violation/,
    );
  });
});
