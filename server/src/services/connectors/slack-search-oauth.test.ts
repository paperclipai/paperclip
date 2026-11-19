import { describe, expect, it } from "vitest";
import { slackOAuthErrorMessage } from "./slack-search-oauth.js";

describe("slackOAuthErrorMessage", () => {
  it.each([
    ["bad_client_secret", /Client Secret.*not the Signing Secret/],
    ["invalid_client_id", /Client ID/],
    ["bad_redirect_uri", /redirect URL/],
    ["invalid_code", /expired or was already used/],
    ["code_already_used", /expired or was already used/],
  ])("maps %s to an actionable message", (code, pattern) => {
    expect(slackOAuthErrorMessage(code)).toMatch(pattern);
  });

  it("includes an unknown but well-formed Slack code", () => {
    expect(slackOAuthErrorMessage("team_not_authorized")).toContain("(team_not_authorized)");
  });

  it.each([undefined, 42, "Bad Code!", "x".repeat(65), "<script>"])(
    "falls back to the generic message for untrusted value %j",
    (code) => {
      const message = slackOAuthErrorMessage(code);
      expect(message).toBe("Slack rejected authorization. Check the app credentials and redirect URL.");
    },
  );
});

describe("slackSearchOAuthService exchange errors", () => {
  it("returns a specific 422 for the interactive exchange and a reconnect message for refresh", async () => {
    const { slackSearchOAuthService } = await import("./slack-search-oauth.js");
    const respond = (error: unknown) => (async () => Response.json({ ok: false, error })) as unknown as typeof fetch;
    const exchangeWith = (fetchImpl: typeof fetch, body: Record<string, string>) =>
      (slackSearchOAuthService({} as never, "https://p.example", fetchImpl) as unknown as {
        __exchange: (b: Record<string, string>) => Promise<unknown>;
      }).__exchange(body);
    await expect(exchangeWith(respond("bad_client_secret"), { code: "c" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Signing Secret"),
      details: { slackError: "bad_client_secret" },
    });
    await expect(exchangeWith(respond("bad_client_secret"), { grant_type: "refresh_token" })).rejects.toMatchObject({
      message: expect.stringContaining("Reconnect Slack search"),
    });
    await expect(exchangeWith(respond("<bad>"), { code: "c" })).rejects.toMatchObject({
      details: { slackError: undefined },
    });
  });
});
