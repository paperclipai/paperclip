import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("chat connector UI contract", () => {
  it("describes the close command as a conversation control rather than a task status change", () => {
    const setup = source("./ChatEndpointSetup.tsx");
    expect(setup).toContain("Close the active chat conversation");
    expect(setup).not.toContain("Close the active Paperclip task");
  });

  it("retries the selected failed run from every Board entry point", () => {
    for (const file of [
      "AgentDetail.tsx",
      "AgentDetail.production.tsx",
      "Inbox.tsx",
      "LegacyInbox.tsx",
    ]) {
      const page = source(`../../${file}`);
      expect(page).toMatch(
        /agentsApi\.retryFailedRun\(\s*run\.agentId,\s*run\.id,\s*run\.companyId,?\s*\)/,
      );
      expect(page).not.toContain('reason: "retry_failed_run"');
      expect(page).toContain("newRun.runId");
      expect(page).toContain("newRun.issueId");
    }
    const issue = source("../../IssueDetail.tsx");
    expect(issue).toMatch(
      /agentsApi\.retryFailedRun\(\s*failedRun\.agentId,\s*failedRun\.runId,\s*companyId/,
    );
    expect(issue).toContain("Retry queued");
    for (const file of ["Inbox.tsx", "LegacyInbox.tsx"]) {
      const page = source(`../../${file}`);
      expect(page).toMatch(
        /const retryRunMutation = useMutation\(\{[\s\S]*?onError: \(error\) => \{\s*pushToast\(\{\s*title: "Run retry failed"/,
      );
    }
  });
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
      "Connect AgentMail, Slack, GitHub, Discord, Microsoft Teams, or Telegram from",
    );
  });

  it("keeps provider capabilities automatic and settings focused on plausible reach", () => {
    const detail = source("./ChatEndpointDetail.tsx");
    const setup = source("./ChatEndpointSetup.tsx");
    expect(detail).toContain("Allow direct messages");
    expect(detail).toContain("Allow group chats");
    expect(detail).toContain("Their tasks run only with an isolated workspace");
    expect(detail).toContain("otherwise Paperclip safely refuses the request");
    expect(setup).toContain("Link the account you’re testing");
    expect(setup).toContain("Paperclip does not replay the refused request");
    expect(setup).toContain("Review identity access");
    expect(setup).toContain("instanceSettingsApi.getExperimental()");
    expect(setup).toContain("chatEndpointsApi.listPrincipals(endpointId)");
    expect(setup).toContain("queryKeys.chatEndpoints.detail(next.id)");
    expect(setup).toContain('target="_blank" rel="noopener noreferrer"');
    expect(detail).not.toContain("Enable streaming");
    expect(detail).not.toContain("Delivery transport");
  });

  it("explains Discord's independent per-server direct-message restriction", () => {
    const detail = source("./ChatEndpointDetail.tsx");
    expect(detail).toContain('endpoint.provider === "discord"');
    expect(detail).toContain(
      "People must also enable Direct Messages in their shared Discord server’s Privacy Settings.",
    );
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
    expect(detail).toContain('? "" : "&reconnect=1"');
    expect(detail).toContain("Finish setup");
    expect(detail).toContain("Continue setup");
    expect(detail).toContain('endpoint.setup?.step !== "complete"');
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
    expect(setup).toContain('scopes: ["personal", "team", "groupChat"]');
    expect(setup).toContain('scopes: ["personal", "groupChat"]');
    expect(setup).toContain('title: "/status"');
    expect(setup).toContain('title: "/new"');
    expect(setup).toContain('title: "/close"');
    expect(setup).not.toContain("supportsTargetedMessages");
    expect(setup).toContain("resourceSpecific");
    expect(setup).toContain("ChannelMessage.Read.Group");
    expect(setup).toContain("ChatMessage.Read.Chat");
    expect(setup).toContain("not Microsoft Graph permissions in Entra");
    expect(setup).toContain("does not use Teams single sign-on");
    expect(setup).toContain("webApplicationInfo");
    expect(setup).toContain('resource: "https://paperclip.ing"');
    expect(setup).toContain("only associates the RSC");
    expect(setup).toContain("you do not need to register an Entra");
    expect(setup).toContain("receive every message");
    expect(setup).toContain("One team install covers its standard");
    expect(setup).toContain("Private and shared channels require");
    expect(setup).not.toContain(
      "does not require a <code>webApplicationInfo</code>",
    );
    expect(setup).not.toContain("api://paperclip-chat/");
    expect(setup).toContain("not private channels");
    expect(setup).toContain("native file receipt and consent-based sending");
    expect(setup).toContain("issue_comment");
    expect(setup).toContain("pull_request");
    expect(setup).toContain("pull_request_review_comment");
    expect(setup).toContain("Enable SSL verification");
    expect(setup).toContain("Only on this account");
    expect(setup).toContain('type="password"');
    expect(setup).not.toContain("WebkitTextSecurity");
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
    expect(setup).toContain("- assistant:write");
    expect(setup).toContain("agent_view:");
    expect(setup).toContain("agent_session_stopped");
    expect(setup).not.toContain("assistant_view:");
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

  it("keeps provider setup failures visible without rendering submitted credentials", () => {
    const setup = source("./ChatEndpointSetup.tsx");
    const setupError = source("./chat-setup-error.ts");
    expect(setup).toContain("sanitizedSetupErrorMessage");
    expect(setup).toContain('role="alert"');
    expect(setupError).toContain('message.replaceAll(candidate, "[redacted]")');
    expect(setupError).toContain("return encodeURIComponent(value)");
    expect(setup).toContain("onMutate: () => setSetupError(null)");
    expect(setup).not.toContain('title: "Connection failed"');
  });

  it("keeps GitHub setup on the shipped customer-owned App path", () => {
    const setup = source("./ChatEndpointSetup.tsx");
    const generator = source(
      "../../../../../doc/plans/chat-adapters/generate-wireframes-v8.mjs",
    );
    const setupData = source(
      "../../../../../doc/plans/chat-adapters/setup-wireframe-data-v8.mjs",
    );
    expect(setup).toContain("Generate webhook secret");
    expect(setup).toContain("GitHub App ID");
    expect(setup).toContain("Private key (PEM)");
    expect(setup).toContain("Choose .pem file");
    expect(setup).toContain("Choose GitHub App private key file");
    expect(setup).toContain("readGitHubPrivateKeyFile");
    expect(setup).toContain("privateKeyReadGuard.invalidate()");
    expect(setup).toContain("privateKeyFileLoading ||");
    expect(setup).toContain("Show private key");
    expect(setup).toContain('type="password"');
    expect(setup).toContain('event.clipboardData.getData("text")');
    expect(setup).not.toContain("WebkitTextSecurity");
    expect(generator).toContain("./setup-wireframe-data-v8.mjs");
    expect(generator).not.toContain("./setup-wireframe-data-v6.mjs");
    expect(setupData).not.toContain('primary: "Create in GitHub"');
  });
});
