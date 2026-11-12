import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { McpAppCallToolResult, McpAppResource } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { createMcpAppHost, mcpAppDocument, type McpAppHostContext } from "./mcp-app-host";

const MAX_HEIGHT = 640;
const INITIAL_HEIGHT = 120;
const STYLE_VARIABLES: Array<[string, string]> = [
  ["--color-background-primary", "--background"],
  ["--color-background-secondary", "--muted"],
  ["--color-text-primary", "--foreground"],
  ["--color-text-secondary", "--muted-foreground"],
  ["--color-border-primary", "--border"],
  ["--font-sans", "--font-sans"],
  ["--border-radius-md", "--radius"],
];

function resolvedTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function hostStyleVariables(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const computed = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const [specName, tokenName] of STYLE_VARIABLES) {
    const value = computed.getPropertyValue(tokenName).trim();
    if (value) variables[specName] = value;
  }
  return variables;
}

export interface McpAppFrameProps {
  title: string;
  viewId: string;
  toolName: string;
  resource: McpAppResource;
  toolInput: Record<string, unknown>;
  toolResult: McpAppCallToolResult;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpAppCallToolResult>;
  className?: string;
}

/**
 * Renders an MCP Apps view. The document runs in an opaque-origin iframe
 * (`sandbox="allow-scripts"`, never `allow-same-origin`): it cannot reach
 * Paperclip's DOM, cookies or storage, and its network access is limited to
 * the origins its server declared. Everything else goes through the
 * postMessage protocol in `mcp-app-host.ts`.
 */
export function McpAppFrame({ title, viewId, toolName, resource, toolInput, toolResult, callTool, className }: McpAppFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  // One mount is one iframe element and one document. A second `load` means the
  // frame left the view's document: that frame and its channel are discarded.
  const [generation, setGeneration] = useState(0);
  const srcDoc = useMemo(() => mcpAppDocument(resource.html, resource.csp), [resource.html, resource.csp]);
  // A refetch of the same view hands over new object identities. The host reads
  // the latest values through refs, so it lives exactly as long as its document.
  const latest = useRef({ callTool, toolInput, toolResult });
  latest.current = { callTool, toolInput, toolResult };
  // A different document is a different frame: remount the iframe with a new host.
  const documentVersion = useRef({ srcDoc, version: 0 });
  if (documentVersion.current.srcDoc !== srcDoc) {
    documentVersion.current = { srcDoc, version: documentVersion.current.version + 1 };
  }
  const frameKey = `${generation}:${documentVersion.current.version}`;

  // Layout effect: the listener must exist before the view's first script posts `ui/initialize`.
  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const hostContext = (): McpAppHostContext => ({
      theme: resolvedTheme(),
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { maxHeight: MAX_HEIGHT, ...(iframe.clientWidth ? { width: iframe.clientWidth } : {}) },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: "web",
      userAgent: "Paperclip",
      toolInfo: { id: viewId, tool: { name: toolName, inputSchema: { type: "object" } } },
      styles: { variables: hostStyleVariables() },
    });
    const host = createMcpAppHost({
      // The view's origin is opaque ("null"), so target "*"; the message only
      // ever goes to this iframe's own window.
      post: (message) => iframe.contentWindow?.postMessage(message, "*"),
      hostContext,
      get toolInput() { return latest.current.toolInput; },
      get toolResult() { return latest.current.toolResult; },
      callTool: (name, args) => latest.current.callTool(name, args),
      openLink: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      onSizeChanged: ({ height: next }) => {
        if (typeof next === "number" && Number.isFinite(next) && next > 0) {
          setHeight(Math.min(MAX_HEIGHT, Math.ceil(next)));
        }
      },
    });
    let loads = 0;
    let navigatedAway = false;
    const onLoad = () => {
      loads += 1;
      if (loads > 1 && !navigatedAway) {
        navigatedAway = true;
        host.teardown("The view left its document");
        setGeneration((value) => value + 1);
      }
    };
    iframe.addEventListener("load", onLoad);
    const onMessage = (event: MessageEvent) => {
      if (navigatedAway || event.source !== iframe.contentWindow) return;
      host.receive(event.data);
    };
    window.addEventListener("message", onMessage);
    const themeObserver = new MutationObserver(() => host.hostContextChanged({ theme: resolvedTheme(), styles: { variables: hostStyleVariables() } }));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      themeObserver.disconnect();
      iframe.removeEventListener("load", onLoad);
      host.teardown();
      window.removeEventListener("message", onMessage);
    };
    // srcDoc is captured by frameKey; tool input and result are read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey, viewId, toolName]);

  return (
    <iframe
      key={frameKey}
      ref={iframeRef}
      title={title}
      srcDoc={srcDoc}
      // Never add allow-same-origin: the opaque origin is the boundary between
      // the provider's view and Paperclip's session. No popups either: links
      // go through `ui/open-link`, which the host opens with noopener.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
      data-testid="mcp-app-frame"
      style={{ height }}
      className={cn("block w-full border-0 bg-transparent", className)}
    />
  );
}
