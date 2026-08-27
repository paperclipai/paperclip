import { APP_STORE_DEFINITIONS, appSupportsCatalogSetup } from "@paperclipai/shared";
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
    expect(isMcpDirectOAuthConnectSlug("asana")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug("github")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug("slack")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug(null)).toBe(false);
  });

  it("admits every capability-backed catalog deep link", () => {
    expect(canEnterAppsConnect(new URLSearchParams("source=notion"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=jira"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=asana"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=github"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("source=context7"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("source=zapier"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=unknown"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("byo=1&source=zapier"))).toBe(true);
  });

  it("admits retained hidden-provider reconnects without opening fresh setup", () => {
    expect(canEnterAppsConnect(new URLSearchParams("source=github"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("source=github&reconnect=connection-1"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=unknown&reconnect=connection-1"))).toBe(false);
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

  it("routes every capability-backed catalog definition through its source deep link", () => {
    const connectableApps = APP_STORE_DEFINITIONS.filter(appSupportsCatalogSetup);

    expect(connectableApps.length).toBeGreaterThan(0);
    for (const app of connectableApps) {
      const href = appSourceConnectHref(app.slug);
      const searchParams = new URL(href, "http://paperclip.test").searchParams;

      expect(canEnterAppsConnect(searchParams), app.slug).toBe(true);
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
});
