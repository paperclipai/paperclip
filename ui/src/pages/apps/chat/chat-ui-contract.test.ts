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
    expect(detail).toContain("purpose=chat&resume=${endpoint.id}");
    expect(detail).toContain("Finish setup");
    expect(detail).toContain("Reconnect");
    expect(detail).not.toContain("Change agent");
    for (const label of ["Pause", "Resume", "Reconnect", "Remove connection"]) {
      expect(activity).toContain(label);
      expect(settings).not.toContain(label);
    }
  });

  it("uses only executable provider credential flows", () => {
    const setup = source("./ChatEndpointSetup.tsx");
    for (const credential of [
      "botToken",
      "signingSecret",
      "appId",
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
    expect(setup).toContain("Generate webhook secret");
    expect(setup).toContain("will not show it again");
    expect(setup).toContain(
      "immediately invalidates GitHub webhook signatures",
    );
    expect(setup).not.toContain("/setprivacy");
    expect(setup).toContain("Create Azure Bot");
    expect(setup).toContain("Client secret value");
    expect(setup).toContain('scopes: ["personal", "team", "groupchat"]');
    expect(setup).toContain("resourceSpecific");
    expect(setup).toContain("ChannelMessage.Read.Group");
    expect(setup).toContain("ChatMessage.Read.Chat");
    expect(setup).toContain("not Microsoft Graph permissions in Entra");
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
    expect(setup).toContain("app_uninstalled");
    expect(setup).toContain("slackBotNameForAgent");
    expect(setup).not.toContain("- im:write");
    expect(setup).toContain("- reactions:write");
    expect(setup).not.toContain("always_online");
    expect(setup).toContain("- reactions:read");
    expect(setup).toContain("reaction_added");
    expect(setup).toContain("reaction_removed");
    expect(setup).not.toContain("No credentials");
    expect(setup).not.toContain("managed Microsoft app");
    expect(setup).toContain("endpoint.providerAccountId && !repairing");
    expect(setup).not.toContain('field("webhookSecret"');
    expect(setup).not.toContain("@paperclipai/teams-connect");
    expect(setup).not.toContain("Copy setup command");
    expect(setup).not.toContain("Add {agentName} to Slack");
    expect(setup).not.toContain("Create in GitHub");
  });
});
