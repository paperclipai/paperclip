import { describe, expect, it } from "vitest";
import { buildSlackAppManifest, defaultSlackAppConfiguration, slackRegistrationSchema, slackAccountStateSchema, slackConfigurationCredentialSaveSchema, slackRegistrationErrorMessage, SLACK_CHAT_BOT_SCOPES } from "./slack-app-manifest.js";
import { isSlackOptInScopeGroup, SLACK_ALL_BOT_SCOPES, SLACK_DEFAULT_BOT_SCOPES, SLACK_OPT_IN_SCOPE_GROUPS, slackBotScopes, slackManifestBotScopes, slackOptInGroupsChanged, slackOptInGroupsForSetup, slackOptInGroupsFromScopes, slackOptInScopeGroupsSchema, slackOptInScopes, slackRequestedOptInGroups, slackScopesAllowDmReads, slackSearchRedirectUri } from "./slack-scopes.js";
import { SLACK_BOT_TOOL_SCOPES } from "./slack-tools.js";
import { createChatEndpointSchema, slackAppConfigurationSchema } from "./validators/chat-channels.js";

describe("Slack app manifest", () => {
  it("allows DM reads only when all four DM user scopes were granted", () => {
    const search = ["search:read.public", "search:read.private", "search:read.files"];
    const dms = ["im:history", "im:read", "mpim:history", "mpim:read"];
    expect(slackScopesAllowDmReads(undefined)).toBe(false);
    expect(slackScopesAllowDmReads(null)).toBe(false);
    expect(slackScopesAllowDmReads([])).toBe(false);
    expect(slackScopesAllowDmReads(search)).toBe(false);
    expect(slackScopesAllowDmReads([...search, "im:history", "mpim:history"])).toBe(false);
    expect(slackScopesAllowDmReads([...search, ...dms])).toBe(true);
  });
  it("declares the personal-search redirect URL and user scopes only when asked, keeping the install redirect first", () => {
    const common = { app: defaultSlackAppConfiguration("Maya"), agentName: "Maya", webhookUrl: "https://p.example/w", redirectUri: "https://p.example/api/chat-slack/oauth/callback" };
    const plain = buildSlackAppManifest(common);
    expect(plain.oauth_config.redirect_urls).toEqual([common.redirectUri]);
    expect("user" in plain.oauth_config.scopes).toBe(false);
    const search = buildSlackAppManifest({ ...common, searchRedirectUri: "https://p.example/api/slack/search/callback" });
    expect(search.oauth_config.redirect_urls).toEqual([common.redirectUri, "https://p.example/api/slack/search/callback"]);
    expect((search.oauth_config.scopes as { user?: string[] }).user).toEqual(["search:read.public", "search:read.private", "search:read.files", "im:history", "im:read", "mpim:history", "mpim:read"]);
    expect(slackSearchRedirectUri("https://p.example/some/base?x=1")).toBe("https://p.example/api/slack/search/callback");
  });
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
  it("defaults the app and bot names from the company when one is given, and keeps the command per agent", () => {
    expect(defaultSlackAppConfiguration("Maya", "Redesign Health")).toEqual({ appName: "Redesign Health", botName: "redesign-health", command: "/maya" });
    // Two agents in one company share the names but never a slash command.
    expect(defaultSlackAppConfiguration("Chief of Staff", "Redesign Health").command).toBe("/chief-of-staff");
    for (const company of ["Redesign Health", "Café & Co.", "  Padded  ", "A".repeat(80), "x"]) {
      expect(slackAppConfigurationSchema.safeParse(defaultSlackAppConfiguration("Maya", company)).success, company).toBe(true);
    }
    expect(defaultSlackAppConfiguration("Maya", "A".repeat(80)).appName).toHaveLength(35);
    // A cut never splits an emoji into a lone surrogate, and the bot slug never ends on a separator.
    const emoji = defaultSlackAppConfiguration("Maya", `${"a".repeat(34)}😀tail`).appName;
    expect(emoji).toBe("a".repeat(34));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji)).toBe(false); // no lone surrogate
    expect(slackAppConfigurationSchema.safeParse(defaultSlackAppConfiguration("Maya", `${"a".repeat(34)}😀tail`)).success).toBe(true);
    expect(defaultSlackAppConfiguration("Maya", `${"a".repeat(33)}😀tail`).appName).toBe(`${"a".repeat(33)}😀`);
    expect(defaultSlackAppConfiguration("Maya", "chat adapters browser e2e 179374705").botName).toBe("chat-adapters-browser-e2");
    expect(defaultSlackAppConfiguration("Maya", "abcdefghijklmnopqrstuvw xyz").botName).toBe("abcdefghijklmnopqrstuvw");
    // Emoji-only company names have nothing usable for the slug, so the agent defaults apply.
    expect(defaultSlackAppConfiguration("Maya", "😀😀")).toEqual({ appName: "maya-paperclip", botName: "maya", command: "/maya" });
    // Nothing usable in the company name (or no company): fall back to the agent defaults.
    for (const company of ["!!!", "", "   ", undefined]) {
      expect(defaultSlackAppConfiguration("Maya", company)).toEqual({ appName: "maya-paperclip", botName: "maya", command: "/maya" });
    }
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
    expect(manual.features).toHaveProperty("agent_view");
    expect(manual.features).not.toHaveProperty("assistant_view");
    expect(manual.features.bot_user).not.toHaveProperty("always_online");
    expect(manual.features.app_home).toEqual({
      home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false,
    });
    // The reviewed provider events stay pinned across both creation paths.
    expect(manual.settings.event_subscriptions.bot_events).toMatchSnapshot();
  });
  it("requests default bot scopes including im:write when no opt-ins are enabled", () => {
    expect([...buildSlackAppManifest(input).oauth_config.scopes.bot].sort()).toEqual([
      "app_mentions:read", "assistant:write", "bookmarks:read", "bookmarks:write",
      "canvases:read", "canvases:write", "channels:history", "channels:read",
      "channels:write.topic", "chat:write", "commands", "emoji:read", "files:read",
      "groups:history", "groups:read", "groups:write.topic", "im:history", "im:read",
      "im:write", "lists:read", "lists:write", "mpim:history", "mpim:read", "pins:read",
      "pins:write", "reactions:read", "reactions:write", "users:read", "users:read.email",
    ]);
    expect(SLACK_DEFAULT_BOT_SCOPES).toHaveLength(29);
    expect(SLACK_OPT_IN_SCOPE_GROUPS).toEqual(["channel_management", "file_upload"]);
    expect(isSlackOptInScopeGroup("proactive_dms")).toBe(false);
    // Read history, DM creation, and reply stay in the default set.
    for (const scope of ["channels:history", "groups:history", "im:history", "im:write", "mpim:history", "chat:write"]) {
      expect(SLACK_DEFAULT_BOT_SCOPES).toContain(scope);
    }
  });
  it.each([
    ["channel_management", ["channels:manage", "groups:write"]],
    ["file_upload", ["files:write"]],
  ] as const)("adds exactly the %s group's scopes", (group, scopes) => {
    const defaults = new Set<string>(SLACK_DEFAULT_BOT_SCOPES);
    expect(slackBotScopes([group]).filter(scope => !defaults.has(scope)).sort()).toEqual([...scopes].sort());
    expect(slackBotScopes([group]).sort()).toEqual([...SLACK_DEFAULT_BOT_SCOPES, ...scopes].sort());
  });
  it("adds every enabled group and never duplicates a scope", () => {
    expect(slackBotScopes(SLACK_OPT_IN_SCOPE_GROUPS).sort()).toEqual([...SLACK_ALL_BOT_SCOPES].sort());
    expect(new Set(SLACK_ALL_BOT_SCOPES).size).toBe(SLACK_ALL_BOT_SCOPES.length);
    expect(SLACK_ALL_BOT_SCOPES.filter(scope => !SLACK_DEFAULT_BOT_SCOPES.includes(scope as never)).sort()).toEqual([
      "channels:manage", "files:write", "groups:write",
    ]);
  });
  it("never requests the personal search scopes in the bot manifest", () => {
    const manifest = buildSlackAppManifest({ ...input, optInScopeGroups: SLACK_OPT_IN_SCOPE_GROUPS });
    expect(manifest.oauth_config.scopes.bot.some(scope => scope.startsWith("search:read"))).toBe(false);
  });
  it("derives the legacy combined list from the default and opt-in scopes", () => {
    expect([...SLACK_BOT_TOOL_SCOPES].sort()).toEqual([...SLACK_ALL_BOT_SCOPES].sort());
    // The manual-app chat floor is the old chat set minus the now opt-in files:write.
    // It must exclude im:write so existing apps without im:write remain reconnectable.
    const defaults = new Set<string>(SLACK_DEFAULT_BOT_SCOPES);
    expect(SLACK_CHAT_BOT_SCOPES.every(scope => defaults.has(scope))).toBe(true);
    expect(SLACK_CHAT_BOT_SCOPES).not.toContain("files:write");
    expect(SLACK_CHAT_BOT_SCOPES).not.toContain("im:write");
    expect(SLACK_CHAT_BOT_SCOPES).toHaveLength(16);
  });
  it("rejects arbitrary manifests, scopes, callback destinations, and refresh tokens", () => {
    const request = { requestId: "12345678-1234-4123-8123-123456789abc", credentials: { configurationToken: "temporary" } };
    expect(slackRegistrationSchema.safeParse(request).success).toBe(true);
    for (const key of ["manifest", "scopes", "callbackUri", "configurationRefreshToken", "avatarUrl"])
      expect(slackRegistrationSchema.safeParse({ ...request, [key]: "untrusted" }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { ...request.credentials, refreshToken: "untrusted" } }).success).toBe(false);
  });
  it("accepts a saved configuration credential id as an alternative to an access token", () => {
    const request = { requestId: "12345678-1234-4123-8123-123456789abc" };
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationCredentialId: "12345678-1234-4123-8123-123456789abc" } }).success).toBe(true);
    // Both variants are strict: neither extra keys nor a second source is accepted.
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationCredentialId: "12345678-1234-4123-8123-123456789abc", configurationToken: "temporary" } }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationCredentialId: "not-a-uuid" } }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationCredentialId: "12345678-1234-4123-8123-123456789abc", extra: "untrusted" } }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationToken: "temporary", extra: "untrusted" } }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: {} }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { refreshToken: "xoxe-1-untrusted" } }).success).toBe(false);
  });
  it("validates a saved refresh token shape strictly", () => {
    const save = (credentials: unknown) => slackConfigurationCredentialSaveSchema.safeParse({ credentials }).success;
    expect(save({ refreshToken: "xoxe-1-abc" })).toBe(true);
    expect(save({ refreshToken: "  xoxe-1-padded  " })).toBe(true);
    expect(save({ refreshToken: "xoxp-1234" })).toBe(false);
    expect(save({ refreshToken: "" })).toBe(false);
    expect(save({ refreshToken: "xoxe-1-abc", extra: "untrusted" })).toBe(false);
    expect(slackConfigurationCredentialSaveSchema.safeParse({ credentials: { refreshToken: "xoxe-1-abc" }, extra: true }).success).toBe(false);
  });
  it("accepts shared only as a boolean beside the credentials", () => {
    const parse = (shared: unknown) => slackConfigurationCredentialSaveSchema.safeParse({ credentials: { refreshToken: "xoxe-1-abc" }, shared }).success;
    expect(parse(true)).toBe(true);
    expect(parse(false)).toBe(true);
    expect(parse("true")).toBe(false);
    expect(parse(1)).toBe(false);
    expect(slackConfigurationCredentialSaveSchema.safeParse({ credentials: { refreshToken: "xoxe-1-abc" } }).success).toBe(true);
    // It travels beside the credentials, never inside them.
    expect(slackConfigurationCredentialSaveSchema.safeParse({ credentials: { refreshToken: "xoxe-1-abc", shared: true } }).success).toBe(false);
  });
  it("returns specific messages for the saved-credential failure codes", () => {
    for (const code of ["slack_configuration_refresh_invalid", "slack_configuration_refresh_required", "slack_configuration_refresh_uncertain", "slack_configuration_refresh_busy", "slack_configuration_shared_forbidden", "slack_configuration_credential_mismatch", "slack_configuration_credential_forbidden"]) {
      expect(slackRegistrationErrorMessage(code)).not.toBe(slackRegistrationErrorMessage("unknown-code"));
    }
    expect(slackRegistrationErrorMessage("slack_configuration_refresh_invalid")).toContain("refresh token");
    expect(slackRegistrationErrorMessage("slack_configuration_token_invalid")).toContain("use a saved refresh token");
    expect(slackRegistrationErrorMessage("slack_dm_scope_missing")).toContain("Reconnect this agent's Slack app so Slack grants permission to open direct messages (im:write).");
    expect(slackRegistrationErrorMessage("slack_install_scopes_missing")).toContain("such as the direct-message (im:write) permission");
  });
});

describe("Slack opt-in setup state", () => {
  it("keeps opt-ins off for a new agent and reads back exactly what was requested", () => {
    expect(slackRequestedOptInGroups({ slackOptInScopeGroups: [] })).toEqual([]);
    expect(slackRequestedOptInGroups({ slackOptInScopeGroups: ["file_upload"] })).toEqual(["file_upload"]);
    // A legacy requested value is parsed away rather than erroring (TECH-8783).
    expect(slackRequestedOptInGroups({ slackOptInScopeGroups: ["proactive_dms"] })).toEqual([]);
    expect(slackRequestedOptInGroups({ slackOptInScopeGroups: ["proactive_dms", "file_upload"] })).toEqual(["file_upload"]);
    expect(slackOptInGroupsForSetup({ slackOptInScopeGroups: [] })).toEqual([]);
  });
  it("only treats a fieldless row as a legacy full grant when a prior install exists", () => {
    // S1/S2: a brand-new endpoint has nothing installed, legacy or not.
    expect(slackOptInGroupsForSetup({})).toEqual([]);
    expect(slackOptInGroupsChanged({})).toBe(false);
    // A row that predates TECH-7988 already holds every scope.
    const legacyGroups = slackOptInGroupsForSetup({}, { legacyInstall: true });
    expect(legacyGroups).toEqual(SLACK_OPT_IN_SCOPE_GROUPS);
    expect(legacyGroups).not.toContain("proactive_dms");
    expect(slackOptInGroupsChanged({}, { legacyInstall: true })).toBe(false);
    // A recorded request without an installed marker is fail-closed: the
    // caller snapshots the legacy grant first (see `applySlackOptInManifestChange`).
    expect(slackOptInGroupsForSetup({ slackOptInScopeGroups: [] }, { legacyInstall: true })).toEqual([]);
    // With that snapshot in place, trimming the request is a real change.
    const trimmed = {
      slackOptInScopeGroups: [] as const,
      slackInstalledOptInScopeGroups: [...SLACK_OPT_IN_SCOPE_GROUPS],
    };
    expect(slackOptInGroupsChanged(trimmed)).toBe(true);
    expect(slackOptInGroupsForSetup(trimmed)).toEqual(SLACK_OPT_IN_SCOPE_GROUPS);
  });
  it("never falls back to the requested groups", () => {
    // S2: requested but not installed exposes nothing.
    expect(slackOptInGroupsForSetup({ slackOptInScopeGroups: ["file_upload"] })).toEqual([]);
    const pending = { slackOptInScopeGroups: ["file_upload"] as const, slackInstalledOptInScopeGroups: [] };
    expect(slackOptInGroupsForSetup(pending)).toEqual([]);
    expect(slackOptInGroupsChanged(pending)).toBe(true);
    expect(slackOptInGroupsForSetup({ ...pending, slackInstalledOptInScopeGroups: ["file_upload"] })).toEqual(["file_upload"]);
    expect(slackOptInGroupsChanged({ ...pending, slackInstalledOptInScopeGroups: ["file_upload"] })).toBe(false);
  });
  it("derives the installed groups from a manifest's bot scopes", () => {
    const manifest = buildSlackAppManifest({ app: { appName: "Maya", botName: "maya", command: "/maya" }, agentName: "Maya", webhookUrl: "https://x/hook" });
    expect(slackOptInGroupsFromScopes(slackManifestBotScopes(manifest))).toEqual([]);
    const withGroups = buildSlackAppManifest({ app: { appName: "Maya", botName: "maya", command: "/maya" }, agentName: "Maya", webhookUrl: "https://x/hook", optInScopeGroups: ["channel_management", "file_upload"] });
    expect(slackOptInGroupsFromScopes(slackManifestBotScopes(withGroups))).toEqual(["channel_management", "file_upload"]);
  });
  it("dedupes and validates opt-in requests", () => {
    expect(slackOptInScopeGroupsSchema.parse(["file_upload", "file_upload", "proactive_dms"])).toEqual(["file_upload"]);
    expect(slackOptInScopes(["proactive_dms"] as never)).toEqual([]);
    expect(slackOptInScopeGroupsSchema.safeParse(["not_a_group"]).success).toBe(false);
    expect(slackOptInScopeGroupsSchema.safeParse(["channel_management", "proactive_dms", "file_upload", "channel_management"]).success).toBe(true);
    expect(slackOptInScopeGroupsSchema.parse(["channel_management", "proactive_dms", "file_upload", "channel_management"])).toEqual(["channel_management", "file_upload"]);
  });
});
