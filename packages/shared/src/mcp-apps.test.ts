import { describe, expect, it } from "vitest";
import {
  MCP_APP_MIME_TYPE,
  buildMcpAppCsp,
  mcpAppToolCallableFromApp,
  mcpAppToolVisibleToModel,
  readMcpAppResource,
  readMcpAppToolUi,
  sanitizeMcpAppCspSource,
} from "./mcp-apps.js";

describe("readMcpAppToolUi", () => {
  it("reads _meta.ui.resourceUri with the default visibility", () => {
    expect(readMcpAppToolUi({ ui: { resourceUri: "ui://circleback/meetings" } })).toEqual({
      resourceUri: "ui://circleback/meetings",
      visibility: ["model", "app"],
    });
  });

  it("accepts the deprecated flat key and an explicit visibility", () => {
    expect(readMcpAppToolUi({ "ui/resourceUri": "ui://x/view" })?.resourceUri).toBe("ui://x/view");
    const appOnly = readMcpAppToolUi({ ui: { resourceUri: "ui://x/view", visibility: ["app", "bogus"] } });
    expect(appOnly?.visibility).toEqual(["app"]);
    expect(mcpAppToolVisibleToModel(appOnly)).toBe(false);
    expect(mcpAppToolCallableFromApp(appOnly)).toBe(true);
  });

  it("keeps visibility for an app-only helper without a view", () => {
    const helper = readMcpAppToolUi({ ui: { visibility: ["app"] } });
    expect(helper).toEqual({ resourceUri: null, visibility: ["app"] });
    expect(mcpAppToolVisibleToModel(helper)).toBe(false);
    expect(mcpAppToolVisibleToModel(readMcpAppToolUi({ ui: { resourceUri: "https://evil.example", visibility: ["app"] } }))).toBe(false);
    expect(mcpAppToolVisibleToModel(readMcpAppToolUi({ ui: { visibility: [] } }))).toBe(false);
  });

  it("ignores tools without a ui:// view", () => {
    expect(readMcpAppToolUi(undefined)).toBeNull();
    expect(readMcpAppToolUi({ ui: { resourceUri: "https://evil.example/view" } })).toBeNull();
    expect(mcpAppToolVisibleToModel(null)).toBe(true);
  });
});

describe("readMcpAppResource", () => {
  const uri = "ui://circleback/meetings";
  it("reads text content with its csp and border hints", () => {
    const resource = readMcpAppResource({
      contents: [{
        uri,
        mimeType: MCP_APP_MIME_TYPE,
        text: "<html><body>hi</body></html>",
        _meta: { ui: { csp: { resourceDomains: ["https://cdn.circleback.ai"] }, prefersBorder: false } },
      }],
    }, uri);
    expect(resource).toMatchObject({ html: "<html><body>hi</body></html>", prefersBorder: false, csp: { resourceDomains: ["https://cdn.circleback.ai"] } });
  });

  it("decodes base64 blob content", () => {
    const blob = Buffer.from("<p>café</p>", "utf8").toString("base64");
    expect(readMcpAppResource({ contents: [{ uri, mimeType: "text/html; profile=mcp-app", blob }] }, uri)?.html).toBe("<p>café</p>");
  });

  it("rejects other mime types and other resources", () => {
    expect(readMcpAppResource({ contents: [{ uri, mimeType: "text/html", text: "<p>x</p>" }] }, uri)).toBeNull();
    expect(readMcpAppResource({ contents: [{ uri: "ui://other", mimeType: MCP_APP_MIME_TYPE, text: "<p>x</p>" }] }, uri)).toBeNull();
  });
});

describe("buildMcpAppCsp", () => {
  it("defaults to no network access", () => {
    const csp = buildMcpAppCsp({});
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  it("adds only well-formed https origins the server declared", () => {
    const csp = buildMcpAppCsp({
      connectDomains: ["https://api.circleback.ai", "https://x.com; script-src *", "http://insecure.example", "*"],
      resourceDomains: ["https://*.circleback.ai"],
    });
    expect(csp).toContain("connect-src https://api.circleback.ai;");
    expect(csp).toContain("script-src 'unsafe-inline' https://*.circleback.ai;");
    expect(csp).not.toContain("insecure");
    expect(csp).not.toMatch(/script-src \*/);
  });

  it("sanitizes sources", () => {
    expect(sanitizeMcpAppCspSource("https://Example.COM/")).toBe("https://example.com");
    expect(sanitizeMcpAppCspSource("'unsafe-eval'")).toBeNull();
    expect(sanitizeMcpAppCspSource("https://a.com/path")).toBeNull();
  });
});
