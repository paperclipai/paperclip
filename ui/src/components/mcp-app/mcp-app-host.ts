import {
  buildMcpAppCsp,
  MCP_APPS_PROTOCOL_VERSION,
  type McpAppCallToolResult,
  type McpAppResourceCsp,
} from "@paperclipai/shared";

/**
 * Host side of the MCP Apps postMessage protocol (spec 2026-01-26). Pure and
 * transport-agnostic: the iframe component feeds it messages from the view and
 * it answers through `post`.
 */

export interface McpAppHostContext {
  theme: "light" | "dark";
  displayMode: "inline";
  availableDisplayModes: ["inline"];
  containerDimensions: { maxHeight: number; width?: number };
  locale: string;
  timeZone: string;
  platform: "web";
  userAgent?: string;
  toolInfo: { id: string; tool: { name: string; inputSchema: Record<string, unknown> } };
  styles?: { variables: Record<string, string> };
}

export interface McpAppHostOptions {
  post: (message: unknown) => void;
  hostContext: () => McpAppHostContext;
  toolInput: Record<string, unknown>;
  toolResult: McpAppCallToolResult;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpAppCallToolResult>;
  openLink: (url: string) => void;
  onSizeChanged: (size: { width?: number; height?: number }) => void;
  onLog?: (entry: unknown) => void;
}

type JsonRpcId = string | number;
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const SERVER_ERROR = -32000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  const message = record(value);
  return message?.jsonrpc === "2.0" && (typeof message.method === "string" || "id" in message);
}

/** Only http(s) links leave the sandbox, and always into a new browsing context. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createMcpAppHost(options: McpAppHostOptions) {
  let initialized = false;
  // Set once this document has sent `ui/initialize`. Requests that act on the
  // user's behalf are refused before it.
  let handshakeStarted = false;
  let toolDataSent = false;
  let nextRequestId = 1;
  let disposed = false;

  const respond = (id: JsonRpcId, result: unknown) => options.post({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) => options.post({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method: string, params: unknown) => {
    // The host must not send anything before the view reports it is initialized.
    if (initialized && !disposed) options.post({ jsonrpc: "2.0", method, params });
  };

  function sendToolData() {
    if (toolDataSent) return;
    toolDataSent = true;
    notify("ui/notifications/tool-input", { arguments: options.toolInput });
    notify("ui/notifications/tool-result", options.toolResult);
  }

  async function handleRequest(message: JsonRpcMessage & { id: JsonRpcId; method: string }) {
    const params = record(message.params) ?? {};
    if (!handshakeStarted && message.method !== "ui/initialize" && message.method !== "ping") {
      fail(message.id, SERVER_ERROR, "The view must call ui/initialize first");
      return;
    }
    switch (message.method) {
      case "ui/initialize":
        handshakeStarted = true;
        respond(message.id, {
          protocolVersion: MCP_APPS_PROTOCOL_VERSION,
          hostInfo: { name: "Paperclip", version: "1.0.0" },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            logging: {},
            sandbox: { permissions: {}, csp: {} },
          },
          hostContext: options.hostContext(),
        });
        return;
      case "ping":
        respond(message.id, {});
        return;
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = record(params.arguments) ?? {};
        if (!name) {
          fail(message.id, INVALID_PARAMS, "params.name is required");
          return;
        }
        try {
          respond(message.id, await options.callTool(name, args));
        } catch (error) {
          fail(message.id, SERVER_ERROR, error instanceof Error ? error.message : "Tool call failed");
        }
        return;
      }
      case "ui/open-link": {
        const url = safeExternalUrl(params.url);
        if (!url) {
          fail(message.id, SERVER_ERROR, "Only http and https links can be opened");
          return;
        }
        options.openLink(url);
        respond(message.id, {});
        return;
      }
      case "ui/request-display-mode":
        respond(message.id, { mode: "inline" });
        return;
      case "ui/update-model-context":
        // Accepted; Paperclip does not yet feed view context back to the agent.
        respond(message.id, {});
        return;
      default:
        fail(message.id, METHOD_NOT_FOUND, `${message.method} is not supported by Paperclip`);
    }
  }

  function handleNotification(message: JsonRpcMessage & { method: string }) {
    const params = record(message.params) ?? {};
    switch (message.method) {
      case "ui/notifications/initialized":
        initialized = true;
        sendToolData();
        return;
      case "ui/notifications/size-changed":
        options.onSizeChanged({
          width: typeof params.width === "number" ? params.width : undefined,
          height: typeof params.height === "number" ? params.height : undefined,
        });
        return;
      case "notifications/message":
        options.onLog?.(params);
        return;
      default:
        return;
    }
  }

  return {
    /** Feed one message received from the view. Malformed messages are ignored. */
    receive(data: unknown) {
      if (disposed || !isJsonRpcMessage(data)) return;
      if (typeof data.method === "string" && data.id !== undefined) {
        void handleRequest(data as JsonRpcMessage & { id: JsonRpcId; method: string });
      } else if (typeof data.method === "string") {
        handleNotification(data as JsonRpcMessage & { method: string });
      }
      // Responses to host requests (teardown) need no handling.
    },
    hostContextChanged(partial: Partial<McpAppHostContext>) {
      notify("ui/notifications/host-context-changed", partial);
    },
    /** Sends `ui/resource-teardown` and stops handling messages. */
    teardown(reason = "The view was closed") {
      if (initialized && !disposed) {
        options.post({ jsonrpc: "2.0", id: `teardown-${nextRequestId++}`, method: "ui/resource-teardown", params: { reason } });
      }
      disposed = true;
    },
    get initialized() {
      return initialized;
    },
  };
}

/**
 * The view document with its CSP installed before any of its markup is parsed.
 * The meta tag goes right after the doctype; the parser hoists it into the
 * implicit head, so the view's own `<html>`/`<head>` merge after it and the
 * document keeps standards mode.
 */
export function mcpAppDocument(html: string, csp: McpAppResourceCsp): string {
  const policy = buildMcpAppCsp(csp).replace(/"/g, "&quot;");
  const body = html.replace(/^﻿?\s*<!doctype[^>]*>/i, "");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><script>${MCP_APP_NAVIGATION_GUARD}</script>${body}`;
}

/**
 * Views render only where the navigation guard can cancel script-driven
 * navigations of the frame (location assignment, meta refresh), which needs the
 * Navigation API. The parent and the sandboxed frame run in the same engine.
 */
export function mcpAppNavigationGuardSupported(target: unknown = typeof window === "undefined" ? undefined : window): boolean {
  const navigation = (target as { navigation?: { addEventListener?: unknown } } | undefined)?.navigation;
  return typeof navigation?.addEventListener === "function";
}

/**
 * Runs before the view's own scripts. The view's frame must never load another
 * document: that document would inherit the frame's message channel. The
 * sandbox allows no popups, so every way out goes through the host's
 * `ui/open-link` (http and https only, opened in a new tab with noopener):
 * - cross-document navigations of the frame are cancelled (Navigation API);
 * - link clicks, whatever their target, are routed to the host;
 * - `window.open` posts to the host and returns null.
 * Same-document navigations (pushState, hashes) still work.
 */
export const MCP_APP_NAVIGATION_GUARD = `(function(){
var n=0;function open(u){try{u=String(new URL(String(u),document.baseURI))}catch(_){return;}if(/^https?:/i.test(u))parent.postMessage({jsonrpc:"2.0",id:"paperclip-link-"+(++n),method:"ui/open-link",params:{url:u}},"*");}
window.open=function(u){if(u!=null&&u!=="")open(u);return null;};
var nav=window.navigation;
if(nav&&nav.addEventListener)nav.addEventListener("navigate",function(e){var d=e.destination;if(!d||d.sameDocument||e.downloadRequest||!e.cancelable)return;e.preventDefault();open(d.url);});
document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null;if(!a||e.defaultPrevented)return;if((a.getAttribute("href")||"").charAt(0)==="#")return;e.preventDefault();open(a.href);},true);
})();`;
