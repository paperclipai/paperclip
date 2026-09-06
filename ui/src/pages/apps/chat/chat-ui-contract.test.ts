import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("chat connector UI contract", () => {
  it("keeps the exact dual-purpose choice and immutable searchable agent selection", () => {
    const setup = source("./ChatEndpointSetup.tsx");
    expect(setup).toContain("Chat with an agent");
    expect(setup).toContain("Use this connection as an agent tool");
    expect(setup).toContain("<AgentSelect");
    expect(setup).not.toContain("Change agent");
  });

  it("provides every settled detail tab and no detach control", () => {
    const detail = source("./ChatEndpointDetail.tsx");
    for (const tab of ["settings", "access", "conversations", "activity"]) {
      expect(detail).toContain(`"${tab}"`);
    }
    expect(detail).not.toContain('"overview"');
    expect(detail).toContain("Open {providerNames[provider]}");
    expect(detail).toContain("Open task");
    expect(detail.toLowerCase()).not.toContain("detach");
  });

  it("shows independent Slack callback surfaces and public URL drift", () => {
    const detail = source("./ChatEndpointDetail.tsx");
    expect(detail).toContain("Slack callback health");
    expect(detail).toContain("Events API");
    expect(detail).toContain("Interactivity");
    expect(detail).toContain("Slash command");
    expect(detail).toContain("callbacksNeedUpdate");
    expect(detail).toContain("Slack callback URLs need an update");
    expect(detail).toContain("Not observed");
  });

  it("lists every supported provider in the agent channel empty state", () => {
    const panel = source("../../../components/chat/AgentChannelsPanel.tsx");
    expect(panel).toContain(
      "Connect Slack, GitHub, Discord, Microsoft Teams, or Telegram from",
    );
  });

  it("keeps provider capabilities automatic and settings focused on plausible reach", () => {
    const detail = source("./ChatEndpointDetail.tsx");
    expect(detail).toContain("Allow direct messages");
    expect(detail).toContain("Allow group chats");
    expect(detail).not.toContain("Enable streaming");
    expect(detail).not.toContain("Delivery transport");
  });

  it("offers only real connection lifecycle actions", () => {
    const detail = source("./ChatEndpointDetail.tsx");
    const settings = detail.slice(
      detail.indexOf("function Settings"),
      detail.indexOf("function SettingToggle"),
    );
    const activity = detail.slice(detail.indexOf("function Activity"));
    expect(detail).toContain('"pause" | "resume" | "remove"');
    expect(detail).toContain("Remove this connection?");
    expect(detail).toContain("purpose=chat&resume=${endpoint.id}&reconnect=1");
    expect(detail).toContain("Finish setup");
    expect(detail).toContain("Reconnect");
    expect(detail).not.toContain("Change agent");
    for (const label of ["Pause", "Resume", "Reconnect", "Remove connection"]) {
      expect(activity).toContain(label);
      expect(settings).not.toContain(label);
    }
  });

  it("states the provider boundary for reconnect and removal", () => {
    const detail = source("./ChatEndpointDetail.tsx");
    const setup = source("./ChatEndpointSetup.tsx");
    for (const reconnectCopy of [
      "does not reinstall the app or change its workspace or channel membership",
      "does not reinstall the App or change repository access",
      "does not add or remove the bot from the server",
      "does not upload or reinstall the Teams app",
      "automatically refreshes its Paperclip webhook and command menu",
    ]) {
      expect(detail).toContain(reconnectCopy);
      expect(setup).toContain(reconnectCopy);
    }
    for (const removalCopy of [
      "It does not uninstall the Slack app",
      "It does not uninstall the GitHub App",
      "It does not uninstall the bot",
      "It does not uninstall the Teams app",
      "queues durable removal of its Telegram webhook and command menu",
      "After Telegram confirms that cleanup, Paperclip retires the saved token",
      "BotFather bot and its chat memberships remain",
    ]) {
      expect(detail).toContain(removalCopy);
    }
  });

  it("uses only executable provider credential flows", () => {
    const setup = source("./ChatEndpointSetup.tsx");
    for (const credential of [
      "botToken",
      "signingSecret",
      "appId",
      "applicationId",
      "guildId",
      "clientId",
      "tenantId",
      "clientSecret",
    ]) {
      expect(setup).toContain(`\"${credential}\"`);
    }
    expect(setup).toContain("credentials.privateKey");
    expect(setup).toContain("Bring your own Slack app");
    expect(setup).toContain("Create or connect a GitHub App");
    expect(setup).toContain("create a single-tenant app registration");
    expect(setup).toContain("Create a bot with BotFather");
    expect(setup).toContain("Create one dedicated Discord application");
    expect(setup).toContain("enable Message Content Intent");
    expect(setup).toMatch(/Create\s+Public Threads/);
    expect(setup).toContain("permissions=309237763136&scope=bot");
    expect(setup).not.toContain("applications.commands");
    expect(setup).toContain("Generate webhook secret");
    expect(setup).toContain("will not show it again");
    expect(setup).toContain('params.get("reconnect") === "1"');
    expect(setup).toContain(
      "Leave the token blank to reuse the saved credential",
    );
    expect(setup).toContain(
      "Leave credentials blank to reuse the saved values",
    );
    expect(setup).toContain(
      "immediately invalidates GitHub webhook signatures",
    );
    expect(setup).toContain("generatingSetupSecret ||\n            pending");
    expect(setup).not.toContain("/setprivacy");
    expect(setup).toContain("/task@bot_username");
    expect(setup).toContain("registers its command menu automatically");
    expect(setup).toContain(
      "ordinary\n          mentions are not delivered to bots",
    );
    expect(setup).toContain("Create Azure Bot");
    expect(setup).toContain("Microsoft 365 work or school organization");
    expect(setup).toContain("teams.live.com");
    expect(setup).toContain("commercial cloud tenants only");
    expect(setup).toContain("GCC High");
    expect(setup).toContain("operated by 21Vianet");
    expect(setup).toContain("Client secret value");
    expect(setup).toContain("Microsoft portal field map");
    expect(setup).toContain(
      "Accounts in this organizational directory only (Single tenant)",
    );
    expect(setup).toContain("Use existing app registration");
    expect(setup).toContain("Settings · Configuration");
    expect(setup).toContain("Configure · App features · Bot");
    expect(setup).toContain("Configure · Permissions");
    expect(setup).toContain("Upload an app · Upload a custom app");
    expect(setup).toContain("Copy manifest settings");
    expect(setup).toContain("disabled={!credentials.clientId?.trim()}");
    expect(setup).toContain(
      "Enter the Application / Client ID above before copying",
    );
    expect(setup).toContain("not a complete app package");
    expect(setup).toContain('scopes: ["personal", "team", "groupchat"]');
    expect(setup).toContain("resourceSpecific");
    expect(setup).toContain("ChannelMessage.Read.Group");
    expect(setup).toContain("ChatMessage.Read.Chat");
    expect(setup).toContain("not Microsoft Graph permissions in Entra");
    expect(setup).toContain("does not use Teams single sign-on");
    expect(setup).toContain("does not require a");
    expect(setup).toContain("webApplicationInfo");
    expect(setup).not.toContain("api://paperclip-chat/");
    expect(setup).toContain("not private channels");
    expect(setup).toContain("native file receipt only in personal chat");
    expect(setup).toContain("issue_comment");
    expect(setup).toContain("pull_request");
    expect(setup).toContain("pull_request_review_comment");
    expect(setup).toContain("Enable SSL verification");
    expect(setup).toContain("Only on this account");
    expect(setup).toContain('WebkitTextSecurity: "disc"');
    expect(setup).toContain("Start Slack message test");
    expect(setup).toContain("member_joined_channel");
    expect(setup).toContain("member_left_channel");
    expect(setup).toContain("channel_left");
    expect(setup).toContain("group_left");
    expect(setup).toContain("group_archive");
    expect(setup).toContain("group_unarchive");
    expect(setup).toContain("group_rename");
    expect(setup).toContain("app_uninstalled");
    expect(setup).toContain("Paperclip records Interactivity");
    expect(setup).toContain("command health only after each signed callback");
    expect(setup).toContain("slackBotNameForAgent");
    expect(setup).not.toContain("- im:write");
    expect(setup).toContain("- reactions:write");
    expect(setup).not.toContain("always_online");
    expect(setup).toContain("- reactions:read");
    expect(setup).toContain("reaction_added");
    expect(setup).toContain("reaction_removed");
    expect(setup).toContain("home_tab_enabled: false");
    expect(setup).toContain("messages_tab_enabled: true");
    expect(setup).toContain("messages_tab_read_only_enabled: false");
    expect(setup).not.toContain("No credentials");
    expect(setup).not.toContain("managed Microsoft app");
    expect(setup).toContain("endpoint.providerAccountId && !repairing");
    expect(setup).not.toContain('field("webhookSecret"');
    expect(setup).not.toContain("@paperclipai/teams-connect");
    expect(setup).not.toContain("Copy setup command");
    expect(setup).not.toContain("Add {agentName} to Slack");
    expect(setup).not.toContain("Create in GitHub");
  });

  it("keeps the current GitHub review artifact on the shipped customer-owned App path", () => {
    const viewer = source("../../../../../doc/plans/chat-adapters/index.html");
    const generator = source(
      "../../../../../doc/plans/chat-adapters/generate-wireframes-v8.mjs",
    );
    const setupData = source(
      "../../../../../doc/plans/chat-adapters/setup-wireframe-data-v8.mjs",
    );
    const setupWireframe = source(
      "../../../../../doc/plans/chat-adapters/wireframes-v8/16-github-create.svg",
    );

    expect(viewer).toContain("Create or connect a GitHub App");
    expect(viewer).toContain("Generate webhook secret");
    expect(setupWireframe).toContain("GitHub App ID");
    expect(setupWireframe).toContain("Private key (PEM)");
    expect(viewer).toContain("Metadata read");
    expect(viewer).toContain("Pull request review comment events");
    expect(viewer).not.toContain('id="s45"');
    expect(viewer).not.toContain('id="s47"');
    expect(viewer).not.toContain("Posts Paperclip's App Manifest to GitHub");
    expect(viewer).not.toContain("credential-free App Manifest path");
    expect(generator).toContain("./setup-wireframe-data-v8.mjs");
    expect(generator).not.toContain("./setup-wireframe-data-v6.mjs");
    expect(setupData).not.toContain('primary: "Create in GitHub"');
  });
});
