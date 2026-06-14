import { useEffect, useMemo, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TOOL_APP_GALLERY,
  type AppGalleryEntry,
  type McpJsonImportPreview,
} from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { AppsConnect } from "@/pages/apps/AppsConnect";
import { PasteConfigTab } from "@/pages/tools/PasteConfigTab";

/**
 * PAP-11091 — discoverability copy for remote MCP URLs.
 *
 * Two surfaces, captured for the UXDesigner re-review:
 *  1. Apps Connect gallery — the "Connect with a link" field now advertises that
 *     any remote tool URL (incl. a local MCP server) works, with a localhost
 *     example in the placeholder.
 *  2. The Advanced "Paste a config" tab — a hint that routes a bare URL back to
 *     the gallery's link flow.
 */

const COMPANY = "company-storybook";

const GALLERY: AppGalleryEntry[] = TOOL_APP_GALLERY.slice(0, 6) as AppGalleryEntry[];

function seededClient() {
  const c = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false },
    },
  });
  c.setQueryData(queryKeys.apps.gallery(COMPANY), { apps: GALLERY });
  return c;
}

function GalleryHost() {
  const client = useMemo(() => seededClient(), []);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-4xl p-6">
        <AppsConnect />
      </div>
    </QueryClientProvider>
  );
}

function PasteConfigHost() {
  const client = useMemo(() => seededClient(), []);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-3xl p-6">
        <PasteConfigTab companyId={COMPANY} />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Apps/Connect discoverability (PAP-11091)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const GalleryLinkAffordance: Story = {
  name: "Gallery — Connect with a link",
  render: () => <GalleryHost />,
};

export const PasteConfigRedirectHint: Story = {
  name: "Paste a config — redirect hint",
  render: () => <PasteConfigHost />,
};

/**
 * PAP-11092 / PAP-11094 — preview states after "Check config" runs.
 *
 * Stubs the import-json POST so the preview renders without a backend, then
 * auto-fills the textarea and clicks "Check config" so the screenshot lands on
 * the activation hand-off (Continue buttons + footer copy).
 */
function PreviewHost({ preview, snippet }: { preview: McpJsonImportPreview; snippet: string }) {
  const client = useMemo(() => seededClient(), []);
  const ranRef = useRef(false);

  useEffect(() => {
    const realFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/tools/mcp/import-json")) {
        return new Response(JSON.stringify(preview), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof window.fetch;
    return () => {
      window.fetch = realFetch;
    };
  }, [preview]);

  useEffect(() => {
    if (ranRef.current) return;
    let cancelled = false;
    const tick = window.setInterval(() => {
      if (cancelled) return;
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.textContent?.trim().startsWith("Check config"),
      );
      if (!textarea || !button) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, snippet);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      window.setTimeout(() => {
        button.click();
        ranRef.current = true;
        window.clearInterval(tick);
      }, 30);
    }, 50);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [snippet]);

  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-3xl p-6">
        <PasteConfigTab companyId={COMPANY} />
      </div>
    </QueryClientProvider>
  );
}

const REMOTE_PREVIEW: McpJsonImportPreview = {
  drafts: [
    {
      name: "kv-demo",
      transport: "remote_http",
      status: "draft",
      config: { url: "http://127.0.0.1:8848/mcp" },
      credentialRefs: [],
      warnings: [],
    },
  ],
};

const MIXED_PREVIEW: McpJsonImportPreview = {
  drafts: [
    {
      name: "linear",
      transport: "remote_http",
      status: "draft",
      config: { url: "https://mcp.linear.app/sse" },
      credentialRefs: [
        { name: "LINEAR_API_KEY", secretId: "draft-1", placement: "header", key: "LINEAR_API_KEY" },
      ],
      warnings: [],
    },
    {
      name: "github",
      transport: "local_stdio",
      status: "draft",
      config: { importedCommand: "npx -y @modelcontextprotocol/server-github", importedArgs: [] },
      credentialRefs: [
        { name: "GITHUB_TOKEN", secretId: "draft-2", placement: "env", key: "GITHUB_TOKEN" },
      ],
      warnings: ["Imported stdio commands stay draft-only unless mapped to an approved Paperclip template."],
    },
  ],
};

const STDIO_PREVIEW: McpJsonImportPreview = {
  drafts: [
    {
      name: "github",
      transport: "local_stdio",
      status: "draft",
      config: { importedCommand: "npx -y @modelcontextprotocol/server-github", importedArgs: [] },
      credentialRefs: [
        { name: "GITHUB_TOKEN", secretId: "draft-3", placement: "env", key: "GITHUB_TOKEN" },
      ],
      warnings: ["Imported stdio commands stay draft-only unless mapped to an approved Paperclip template."],
    },
  ],
};

export const PasteConfigPreviewRemote: Story = {
  name: "Paste a config — remote draft (Continue)",
  render: () => (
    <PreviewHost
      preview={REMOTE_PREVIEW}
      snippet='{ "mcpServers": { "kv-demo": { "url": "http://127.0.0.1:8848/mcp" } } }'
    />
  ),
};

export const PasteConfigPreviewMixed: Story = {
  name: "Paste a config — mixed remote + stdio",
  render: () => (
    <PreviewHost
      preview={MIXED_PREVIEW}
      snippet='{ "mcpServers": { "linear": { "url": "https://mcp.linear.app/sse" }, "github": { "command": "npx -y @modelcontextprotocol/server-github" } } }'
    />
  ),
};

export const PasteConfigPreviewStdioOnly: Story = {
  name: "Paste a config — stdio only (draft, no Continue)",
  render: () => (
    <PreviewHost
      preview={STDIO_PREVIEW}
      snippet='{ "mcpServers": { "github": { "command": "npx -y @modelcontextprotocol/server-github" } } }'
    />
  ),
};
