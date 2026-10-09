import { useLayoutEffect, useState } from "react";
import { ChatEndpointSetup } from "@/pages/apps/chat/ChatEndpointSetup";
import { Button } from "@/components/ui/button";
import { ChatSetupSidebar } from "@/components/chat/ChatSetupNavigation";
import { ChatSetupSidebarProvider } from "@/context/ChatSetupSidebarContext";
import { type ChatEndpoint } from "@/api/chatEndpoints";
import { storybookAgents, storybookAuthSession } from "./paperclipData";
import { defaultSlackAppConfiguration } from "@paperclipai/shared";

export type SlackSetupScenario = "choose" | "create" | "manual" | "install" | "declined" | "approval_denied" | "uncertain" | "manifest_pending" | "recovery" | "verify" | "avatar_failed" | "welcome_failed" | "success";

/** Production wizard over a local provider fixture. No requests go to Slack. */
export function SlackSetupFixture({ scenario = "create", managed = false, managedAvailable = true, workspaceCount = 1 }: { scenario?: SlackSetupScenario; managed?: boolean; managedAvailable?: boolean; workspaceCount?: number }) {
  const [ready, setReady] = useState(false);
  const [signalVerification, setSignalVerification] = useState<() => void>(() => () => {});
  useLayoutEffect(() => {
    const original = window.fetch;
    let agent = { ...storybookAgents[0], name: "Maya" };
    const agents = [agent, { ...storybookAgents[1], name: "Research Lead" }];
    const endpoint: ChatEndpoint = {
      id: "slack-story", companyId: "company-storybook", provider: "slack", status: "draft",
      assignedAgentId: agent.id, assignedAgentName: agent.name, allowUnlinkedPeople: false,
      setup: { step: "provider_setup", slackSetupMethod: scenario === "manual" ? "manual" : managed ? "managed" : "automatic",
        slackApp: defaultSlackAppConfiguration(agent.name),
        webhookUrl: "https://ingress.example/api/chat-webhooks/slack-story/slack",
        slackOAuthCallbackUri: "https://board.example/api/chat-slack/oauth/callback",
      },
    };
    const grantId = "11111111-1111-4111-8111-111111111111";
    let authorized = workspaceCount > 0 || new URLSearchParams(window.location.search).get("slackFixtureAuthorized") === "1";
    const created = () => {
      endpoint.setup!.slackRegistration = { status: "install", ...(managed ? { managerGrantId: grantId } : {}), appId: "ASTORY", managementUrl: "https://api.slack.com/apps/ASTORY" };
      endpoint.setup!.slackAvatar = scenario === "avatar_failed" ? { status: "failed", errorCode: "slack_avatar_upload_failed" } : { status: "uploaded", uploadedAt: new Date().toISOString() };
    };
    let linked = false;
    const installed = () => {
      created(); endpoint.setup!.slackRegistration!.status = "configured";
      linked = true;
      endpoint.setup!.slackAccount = { externalUserId: "UPERSON", paperclipUserId: storybookAuthSession.user.id, status: "linked", welcomeStatus: scenario === "welcome_failed" ? "failed" : "sent", ...(scenario === "welcome_failed" ? {} : { dmChannelId: "DSTORY" }) };
      endpoint.status = "verifying"; endpoint.providerAccountId = "TSTORY"; endpoint.botExternalId = "USTORY"; endpoint.botUsername = "maya";
    };
    if (["install", "declined", "approval_denied", "recovery", "manifest_pending"].includes(scenario)) created();
    if (scenario === "manifest_pending") endpoint.setup!.slackRegistration!.errorCode = "slack_manifest_update_pending";
    if (scenario === "declined") endpoint.setup!.slackRegistration!.errorCode = managed ? "slack_approval_pending" : "slack_install_declined";
    if (scenario === "approval_denied") endpoint.setup!.slackRegistration!.errorCode = "slack_approval_denied";
    if (scenario === "recovery") endpoint.setup!.slackRegistration = { ...endpoint.setup!.slackRegistration!, status: "credentials_saved", errorCode: "slack_configuration_incomplete" };
    if (scenario === "uncertain") endpoint.setup!.slackRegistration = { status: "uncertain", ...(managed ? { managerGrantId: grantId } : {}), errorCode: "slack_creation_uncertain", managementUrl: "https://api.slack.com/apps" };
    if (["verify", "avatar_failed", "welcome_failed", "success"].includes(scenario)) installed();
    if (["avatar_failed", "welcome_failed", "success"].includes(scenario)) {
      endpoint.setup!.webhookVerifiedAt = new Date().toISOString();
      endpoint.setup!.step = "test";
      endpoint.setup!.testStartedAt = new Date().toISOString();
    }
    setSignalVerification(() => () => { endpoint.setup!.webhookVerifiedAt = new Date().toISOString(); });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const path = url.pathname;
      if (path === "/api/companies/company-storybook/chat-slack/setup-options") return Response.json({ managedAvailable: managed && managedAvailable, defaultMethod: managed && managedAvailable ? "managed" : "automatic", workspaces: managed && authorized ? Array.from({ length: Math.max(1, workspaceCount) }, (_, i) => ({ grantId: i ? "22222222-2222-4222-8222-222222222222" : grantId, workspaceId: `TSTORY${i}`, workspaceName: i ? "Research workspace" : "Paperclip", userId: "UPERSON" })) : [] });
      if (path === "/api/chat-endpoints/slack-story/slack/managed/authorize") {
        authorized = true;
        const returnUrl = new URL(window.location.href);
        returnUrl.hash = "";
        returnUrl.searchParams.set("slackFixtureAuthorized", "1");
        return Response.json({ authorizationUrl: returnUrl.toString(), expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      if (path === "/api/chat-endpoints/slack-story/slack/managed/provision") { installed(); return Response.json({}); }
      if (path === "/api/companies/company-storybook/agents") return Response.json(agents);
      if (path === `/api/agents/${agent.id}`) return Response.json(agent);
      if (path === "/api/companies/company-storybook/chat-endpoints") {
        const input = JSON.parse(String(init?.body ?? "{}"));
        agent = agents.find(value => value.id === input.assignedAgentId) ?? agent;
        endpoint.assignedAgentId = agent.id; endpoint.assignedAgentName = agent.name;
        endpoint.setup!.slackApp = input.slackApp ?? defaultSlackAppConfiguration(agent.name);
        return Response.json(endpoint);
      }
      if (path === "/api/chat-endpoints/slack-story") {
        if (init?.method === "PATCH") {
          const { slackApp, slackSetupMethod } = JSON.parse(String(init.body));
          if (slackApp) endpoint.setup!.slackApp = slackApp;
          if (slackSetupMethod) endpoint.setup!.slackSetupMethod = slackSetupMethod;
        }
        return Response.json(endpoint);
      }
      if (path === "/api/chat-endpoints/slack-story/slack/registration") { created(); return Response.json(endpoint); }
      if (path === "/api/chat-endpoints/slack-story/slack/install") {
        installed();
        return Response.json({ authorizationUrl: `${window.location.href.split("#")[0]}#simulated-slack-consent`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      if (path === "/api/chat-endpoints/slack-story/slack/resume") { installed(); return Response.json(endpoint); }
      if (path === "/api/chat-endpoints/slack-story/setup") {
        const { action } = JSON.parse(String(init?.body));
        if (action === "verify") { endpoint.setup!.step = "test"; endpoint.setup!.testStartedAt = new Date().toISOString(); }
        else installed();
        return Response.json(endpoint);
      }
      if (path === "/api/chat-endpoints/slack-story/principals") return Response.json([{
        id: "slack-person", principalId: "slack-person", externalLabel: "Preview person", externalDetail: "Preview workspace",
        status: linked ? "linked" : "pending", paperclipUserId: linked ? storybookAuthSession.user.id : null,
        lastConnectAt: new Date().toISOString(),
      }]);
      if (path.endsWith("/slack-person/link-intent")) return Response.json({ confirmationUrl: "https://board.example/confirm?token=fixture" });
      if (path === "/api/chat-identity-links/confirm") { linked = true; return Response.json({ ok: true }); }
      if (path.endsWith("/test-status")) return Response.json({ messageReceivedAt: null });
      if (path.endsWith("/finish")) { endpoint.status = "active"; endpoint.setup!.step = "complete"; return Response.json(endpoint); }
      return original(input, init);
    };
    setReady(true);
    return () => { window.fetch = original; };
  }, [scenario, managed, managedAvailable, workspaceCount]);
  return <div className="space-y-6 p-6">
    <aside className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm text-muted-foreground">
      Preview fixture: Slack consent, callbacks, and identity discovery are simulated.
      <Button variant="outline" size="sm" onClick={signalVerification}>Simulate connection evidence</Button>
    </aside>
    {ready && <ChatSetupSidebarProvider><div className="flex flex-col gap-8 md:flex-row"><aside className="w-56 shrink-0"><ChatSetupSidebar /></aside><main className="min-w-0 flex-1"><ChatEndpointSetup /></main></div></ChatSetupSidebarProvider>}
  </div>;
}
