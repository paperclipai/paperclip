import { describe, expect, it } from "vitest";
import {
  MCP_DIRECT_OAUTH_CONNECT_SLUGS,
  appSourceConnectHref,
  canEnterAppsConnect,
  isMcpDirectOAuthConnectSlug,
} from "./app-connect-policy";

describe("app connect policy", () => {
  it("allowlists the discovery-first MCP OAuth apps", () => {
    expect(MCP_DIRECT_OAUTH_CONNECT_SLUGS).toEqual(["notion", "linear"]);
    expect(isMcpDirectOAuthConnectSlug("notion")).toBe(true);
    expect(isMcpDirectOAuthConnectSlug("linear")).toBe(true);
    expect(isMcpDirectOAuthConnectSlug("github")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug("slack")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug(null)).toBe(false);
  });

  it("admits direct OAuth deep links without opening other source slugs", () => {
    expect(canEnterAppsConnect(new URLSearchParams("source=notion"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=linear"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=github"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("source=zapier"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("byo=1&source=zapier"))).toBe(true);
  });

  it("builds a generic source deep link", () => {
    expect(appSourceConnectHref("notion")).toBe("/apps/connect?source=notion");
  });
});
