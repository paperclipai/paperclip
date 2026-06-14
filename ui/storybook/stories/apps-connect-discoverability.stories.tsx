import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TOOL_APP_GALLERY, type AppGalleryEntry } from "@paperclipai/shared";
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
