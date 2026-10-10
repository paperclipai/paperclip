import { APP_STORE_DEFINITIONS, aiConnectionRouterAppDefinition, appSupportsCatalogSetup } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  MCP_DIRECT_OAUTH_CONNECT_SLUGS,
  appSourceConnectHref,
  appSourceResumeHref,
  canEnterAppsConnect,
  isMcpDirectOAuthConnectSlug,
  resolveAppsConnectRouteKey,
  vercelConnectSourceHref,
} from "./app-connect-policy";

describe("app connect policy", () => {
  it("derives automatic OAuth entry points from app capabilities", () => {
    expect(MCP_DIRECT_OAUTH_CONNECT_SLUGS).toEqual(expect.arrayContaining(["jira", "notion", "sentry"]));
    expect(isMcpDirectOAuthConnectSlug("notion")).toBe(true);
    expect(isMcpDirectOAuthConnectSlug("jira")).toBe(true);
    // Asana and GitHub need an available Paperclip-managed profile for
    // one-click sign-in. The static catalog defaults to their custom-app path.
    expect(isMcpDirectOAuthConnectSlug("asana")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug("github")).toBe(false);
    // Slack requires a customer-registered OAuth client.
    expect(isMcpDirectOAuthConnectSlug("slack")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug(null)).toBe(false);
  });

  it("admits every capability-backed catalog deep link", () => {
    expect(canEnterAppsConnect(new URLSearchParams("source=notion"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=jira"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=asana"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=github"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=context7"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=zapier"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=unknown"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("source=model-provider"))).toBe(false);
    for (const source of ["responses-api", "messages-api", "chat-completions-api", "bedrock", "local", "google", "openrouter"]) {
      expect(canEnterAppsConnect(new URLSearchParams({ source })), source).toBe(true);
    }
    expect(canEnterAppsConnect(new URLSearchParams("byo=1"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("byo=1&source=zapier"))).toBe(false);
  });

  it("keeps only exact custom MCP reconnects on the legacy BYO query contract", () => {
    expect(canEnterAppsConnect(new URLSearchParams(
      "byo=1&reconnect=connection-1&applicationId=application-1&link=https%3A%2F%2Fmcp.example.com",
    ))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams(
      "byo=1&reconnect=connection-1&applicationId=application-1",
    ))).toBe(false);
  });

  it("preserves supported Slack tool setup and exact known-provider reconnects", () => {
    // Slack's current customer-owned OAuth tool method supports catalog setup.
    expect(canEnterAppsConnect(new URLSearchParams("source=slack"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=slack&reconnect=connection-1"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=unknown&reconnect=connection-1"))).toBe(false);
  });

  it("admits hidden providers only for known-provider retained setup routes", () => {
    expect(canEnterAppsConnect(new URLSearchParams("source=monday"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("source=monday&resume=connection-1"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=monday&reconnect=connection-1"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=unknown&resume=connection-1"))).toBe(false);
  });

  it("builds a generic source deep link", () => {
    expect(appSourceConnectHref("notion")).toBe("/apps/connect?source=notion");
    expect(appSourceConnectHref("notion", "intent-1"))
      .toBe("/apps/connect?source=notion&intent=intent-1");
    expect(appSourceResumeHref("notion", "11111111-1111-4111-8111-111111111111")).toBe(
      "/apps/connect?source=notion&resume=11111111-1111-4111-8111-111111111111",
    );
    expect(vercelConnectSourceHref()).toBe("/apps/vercel-connect");
    expect(vercelConnectSourceHref("notion")).toBe("/apps/vercel-connect?source=notion");
  });

  it("lets installed router connectors reach host catalog validation", () => {
    const pool = aiConnectionRouterAppDefinition("example.pool", { name: "AI connection pool", description: "Use saved connections" });
    const params = new URL(appSourceConnectHref(pool.slug), "http://paperclip.test").searchParams;
    expect(canEnterAppsConnect(params)).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=ai-router-invalid"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("source=ai-router-1"))).toBe(false);
  });

  it("routes every capability-backed catalog definition through its source deep link", () => {
    const connectableApps = APP_STORE_DEFINITIONS.filter(appSupportsCatalogSetup);

    expect(connectableApps.length).toBeGreaterThan(0);
    for (const app of connectableApps) {
      const href = appSourceConnectHref(app.slug);
      const searchParams = new URL(href, "http://paperclip.test").searchParams;

      expect(canEnterAppsConnect(searchParams, { chatConnectorsEnabled: true, githubReviewBotsEnabled: true }), app.slug).toBe(true);
      expect(resolveAppsConnectRouteKey({ sourceSlug: searchParams.get("source") }), app.slug).toBe(app.slug);
    }
  });

  it("preserves explicit route precedence while accepting every authentication mode", () => {
    expect(resolveAppsConnectRouteKey({ serviceSlug: "jira", appKey: "asana", sourceSlug: "mem0" })).toBe("jira");
    expect(resolveAppsConnectRouteKey({ appKey: "asana", sourceSlug: "mem0" })).toBe("asana");
    expect(resolveAppsConnectRouteKey({ sourceSlug: "mem0" })).toBe("mem0");
    expect(resolveAppsConnectRouteKey({ sourceSlug: "context7" })).toBe("context7");
    expect(resolveAppsConnectRouteKey({ sourceSlug: "supabase" })).toBe("supabase");
    expect(resolveAppsConnectRouteKey({})).toBeUndefined();
  });

  it("admits the GitHub bot independently of chat setup and keeps tools available", () => {
    const bot = new URLSearchParams("source=github-code-review-bot");
    expect(canEnterAppsConnect(bot, { chatConnectorsEnabled: true })).toBe(false);
    expect(canEnterAppsConnect(bot, { githubReviewBotsEnabled: true })).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=discord"), { githubReviewBotsEnabled: true })).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("source=github"))).toBe(true);
  });
  it("retains GitHub tools but denies chat-only deep links while chat connectors are disabled", () => {
    expect(canEnterAppsConnect(new URLSearchParams("source=github"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=agentmail"))).toBe(true);
    for (const source of ["discord", "telegram", "microsoft-teams"]) {
      expect(canEnterAppsConnect(new URLSearchParams({ source })), source).toBe(false);
      expect(canEnterAppsConnect(new URLSearchParams({ source, reconnect: "connection-1" })), source).toBe(false);
    }
  });
});
