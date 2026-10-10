import { describe, expect, it } from "vitest";
import { buildSlackAppManifest, defaultSlackAppConfiguration, slackRegistrationSchema, slackAccountStateSchema } from "./slack-app-manifest.js";
import { createChatEndpointSchema, slackAppConfigurationSchema } from "./validators/chat-channels.js";

describe("Slack app manifest", () => {
  it("preserves older account setup state and validates optional verification delivery state", () => {
    const account = { externalUserId: "UINSTALLER", paperclipUserId: "board-user", status: "linked", welcomeStatus: "sent" };
    expect(slackAccountStateSchema.safeParse(account).success).toBe(true);
    for (const verificationStatus of ["pending", "sending", "sent", "failed", "uncertain"]) {
      expect(slackAccountStateSchema.safeParse({ ...account, verificationStatus }).success).toBe(true);
    }
    expect(slackAccountStateSchema.safeParse({ ...account, verificationStatus: "delivered" }).success).toBe(false);
  });
  it("uses readable, valid agent defaults and accepts them atomically with a new Slack draft", () => {
    expect(defaultSlackAppConfiguration("Maya")).toEqual({ appName: "maya-paperclip", botName: "maya", command: "/maya" });
    for (const name of ["Research Lead", "Áda Lovelace", "A.B_C", "", "Very long agent name that needs truncating"]) {
      expect(slackAppConfigurationSchema.safeParse(defaultSlackAppConfiguration(name)).success).toBe(true);
    }
    const request = { provider: "slack", assignedAgentId: "12345678-1234-4123-8123-123456789abc", slackApp: defaultSlackAppConfiguration("Maya") };
    expect(createChatEndpointSchema.safeParse(request).success).toBe(true);
    expect(createChatEndpointSchema.safeParse({ ...request, provider: "discord" }).success).toBe(false);
  });
  const input = { app: { appName: 'Research "Ops"', botName: "research-ops", command: "/research" }, agentName: "Maya", webhookUrl: "https://ingress.example/api/chat-webhooks/public/slack" };
  it("uses identical manual and automatic configuration except the OAuth redirect", () => {
    const manual = buildSlackAppManifest(input);
    const automatic = buildSlackAppManifest({ ...input, redirectUri: "https://board.example/api/chat-slack/oauth/callback" });
    expect(automatic).toEqual({ ...manual, oauth_config: { ...manual.oauth_config, redirect_urls: ["https://board.example/api/chat-slack/oauth/callback"] } });
    expect(manual.features.bot_user.display_name).toBe("research-ops");
    expect(manual.features.slash_commands[0]).toMatchObject({ command: "/research", url: input.webhookUrl, should_escape: false });
    expect(manual.settings.event_subscriptions.request_url).toBe(input.webhookUrl);
    expect(manual.settings.interactivity).toEqual({ is_enabled: true, request_url: input.webhookUrl });
    expect(manual.settings.socket_mode_enabled).toBe(false);
    // The reviewed provider permissions/events stay pinned across both creation paths.
    expect(manual.oauth_config.scopes.bot).toMatchSnapshot();
    expect(manual.settings.event_subscriptions.bot_events).toMatchSnapshot();
  });
  it("rejects arbitrary manifests, scopes, callback destinations, and refresh tokens", () => {
    const request = { requestId: "12345678-1234-4123-8123-123456789abc", credentials: { configurationToken: "temporary" } };
    expect(slackRegistrationSchema.safeParse(request).success).toBe(true);
    for (const key of ["manifest", "scopes", "callbackUri", "configurationRefreshToken", "avatarUrl"])
      expect(slackRegistrationSchema.safeParse({ ...request, [key]: "untrusted" }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { ...request.credentials, refreshToken: "untrusted" } }).success).toBe(false);
  });
});
