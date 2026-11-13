import { describe, expect, it, vi } from "vitest";
import { createMcpAppHost, MCP_APP_NAVIGATION_GUARD, mcpAppDocument, safeExternalUrl, type McpAppHostContext } from "./mcp-app-host";

const hostContext: McpAppHostContext = {
  theme: "dark",
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  containerDimensions: { maxHeight: 640 },
  locale: "en-US",
  timeZone: "UTC",
  platform: "web",
  toolInfo: { id: "view-1", tool: { name: "DisplayMeetings", inputSchema: { type: "object" } } },
};

function setup(overrides: Partial<Parameters<typeof createMcpAppHost>[0]> = {}) {
  const posted: any[] = [];
  const options = {
    post: (message: unknown) => posted.push(message),
    hostContext: () => hostContext,
    toolInput: { meetingIds: ["m1"] },
    toolResult: { content: [{ type: "text", text: "ok" }], structuredContent: { meetings: [{ id: "m1" }] } },
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "called" }] })),
    openLink: vi.fn(),
    onSizeChanged: vi.fn(),
    ...overrides,
  };
  return { host: createMcpAppHost(options), posted, options };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createMcpAppHost", () => {
  it("answers ui/initialize with the host context and sends nothing before initialized", async () => {
    const { host, posted } = setup();
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26" } });
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ id: 1, result: { protocolVersion: "2026-01-26", hostInfo: { name: "Paperclip" }, hostContext: { theme: "dark" } } });
    host.hostContextChanged({ theme: "light" });
    expect(posted).toHaveLength(1);
  });

  it("sends tool-input then tool-result once the view is initialized", () => {
    const { host, posted } = setup();
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(posted.map((message) => message.method)).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]);
    expect(posted[0].params).toEqual({ arguments: { meetingIds: ["m1"] } });
    expect(posted[1].params.structuredContent).toEqual({ meetings: [{ id: "m1" }] });
  });

  it("proxies tools/call and reports failures as JSON-RPC errors", async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "called" }] })
      .mockRejectedValueOnce(new Error("denied"));
    const { host, posted } = setup({ callTool });
    host.receive({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
    host.receive({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "ReadMeetings", arguments: { ids: ["m1"] } } });
    host.receive({ jsonrpc: "2.0", id: "b", method: "tools/call", params: { name: "DeleteTag" } });
    await flush();
    expect(callTool).toHaveBeenCalledWith("ReadMeetings", { ids: ["m1"] });
    expect(posted.find((message) => message.id === "a")).toMatchObject({ result: { content: [{ text: "called" }] } });
    expect(posted.find((message) => message.id === "b")).toMatchObject({ error: { code: -32000, message: "denied" } });
  });

  it("opens only http(s) links and rejects unknown methods", async () => {
    const { host, posted, options } = setup();
    host.receive({ jsonrpc: "2.0", id: 0, method: "ui/initialize", params: {} });
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url: "https://app.circleback.ai/meetings/m1" } });
    host.receive({ jsonrpc: "2.0", id: 2, method: "ui/open-link", params: { url: "javascript:alert(1)" } });
    host.receive({ jsonrpc: "2.0", id: 3, method: "ui/message", params: { role: "user", content: { type: "text", text: "hi" } } });
    await flush();
    expect(options.openLink).toHaveBeenCalledTimes(1);
    expect(options.openLink).toHaveBeenCalledWith("https://app.circleback.ai/meetings/m1");
    expect(posted.find((message) => message.id === 2)).toMatchObject({ error: { code: -32000 } });
    expect(posted.find((message) => message.id === 3)).toMatchObject({ error: { code: -32601 } });
  });

  it("refuses tool calls and links before the view's ui/initialize", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const { host, posted, options } = setup({ callTool });
    host.receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "DeleteTag", arguments: {} } });
    host.receive({ jsonrpc: "2.0", id: 2, method: "ui/open-link", params: { url: "https://evil.example" } });
    host.receive({ jsonrpc: "2.0", id: 3, method: "ping" });
    await flush();
    expect(callTool).not.toHaveBeenCalled();
    expect(options.openLink).not.toHaveBeenCalled();
    expect(posted.find((message) => message.id === 1)).toMatchObject({ error: { code: -32000 } });
    expect(posted.find((message) => message.id === 2)).toMatchObject({ error: { code: -32000 } });
    expect(posted.find((message) => message.id === 3)).toMatchObject({ result: {} });
  });

  it("reports size changes, ignores malformed messages and stops after teardown", () => {
    const { host, posted, options } = setup();
    host.receive({ method: "ui/notifications/size-changed", params: { height: 200 } });
    host.receive("not json-rpc");
    expect(options.onSizeChanged).not.toHaveBeenCalled();
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 200 } });
    expect(options.onSizeChanged).toHaveBeenCalledWith({ height: 200, width: undefined });
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    host.teardown();
    expect(posted.at(-1)).toMatchObject({ method: "ui/resource-teardown" });
    const count = posted.length;
    host.receive({ jsonrpc: "2.0", id: 9, method: "ping" });
    expect(posted).toHaveLength(count);
  });
});

describe("mcpAppDocument", () => {
  it("installs the CSP before the view's markup and keeps one doctype", () => {
    const doc = mcpAppDocument("<!DOCTYPE html><html><head><script>1</script></head></html>", { connectDomains: ["https://api.circleback.ai"] });
    expect(doc.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc).toContain("connect-src https://api.circleback.ai");
  });

  it("runs the navigation guard before any of the view's scripts", () => {
    const doc = mcpAppDocument("<html><head><script>window.viewStarted = true</script></head></html>", {});
    expect(doc.indexOf(MCP_APP_NAVIGATION_GUARD)).toBeGreaterThan(doc.indexOf("Content-Security-Policy"));
    expect(doc.indexOf(MCP_APP_NAVIGATION_GUARD)).toBeLessThan(doc.indexOf("window.viewStarted"));
  });

  it("routes links of any target and window.open through ui/open-link", () => {
    const posted: unknown[] = [];
    const parentWindow = { postMessage: (message: unknown) => posted.push(message) };
    const anchors: Array<{ href: string; attrs: Record<string, string> }> = [
      { href: "https://app.circleback.ai/meetings/m1", attrs: { href: "https://app.circleback.ai/meetings/m1", target: "_blank" } },
      { href: "https://app.circleback.ai/meetings/m2", attrs: { href: "https://app.circleback.ai/meetings/m2" } },
      { href: "about:srcdoc#top", attrs: { href: "#top" } },
      { href: "javascript:alert(1)", attrs: { href: "javascript:alert(1)" } },
    ];
    let clickHandler: ((event: unknown) => void) | null = null;
    const fakeWindow: Record<string, unknown> = { open: () => "real window" };
    const fakeDocument = {
      baseURI: "about:srcdoc",
      addEventListener: (type: string, handler: (event: unknown) => void) => { if (type === "click") clickHandler = handler; },
    };
    new Function("window", "document", "parent", MCP_APP_NAVIGATION_GUARD)(fakeWindow, fakeDocument, parentWindow);
    const prevented: boolean[] = [];
    for (const anchor of anchors) {
      let defaultPrevented = false;
      clickHandler!({
        defaultPrevented: false,
        preventDefault: () => { defaultPrevented = true; },
        target: { closest: () => ({ href: anchor.href, getAttribute: (name: string) => anchor.attrs[name] ?? null }) },
      });
      prevented.push(defaultPrevented);
    }
    expect((fakeWindow.open as (url: string) => unknown)("https://circleback.ai/meetings/m3")).toBeNull();
    expect(prevented).toEqual([true, true, false, true]);
    expect(posted.map((message) => (message as { params: { url: string } }).params.url)).toEqual([
      "https://app.circleback.ai/meetings/m1",
      "https://app.circleback.ai/meetings/m2",
      "https://circleback.ai/meetings/m3",
    ]);
  });

  it("allows only http(s) external urls", () => {
    expect(safeExternalUrl("https://circleback.ai")).toBe("https://circleback.ai/");
    expect(safeExternalUrl("data:text/html,x")).toBeNull();
  });
});
