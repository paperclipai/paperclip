import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IssueArtifactFile } from "@/components/artifacts/IssueArtifactCard";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, userEvent, waitFor } from "storybook/test";
import { DocumentCard } from "@/components/artifacts/RichArtifactCards";
import { TextAttachmentPreview } from "@/components/task-side-panel/TaskAttachmentPanel";
import { FileContentViewer } from "@/components/FileViewerSheet";
import { MarkdownBody } from "@/components/MarkdownBody";
import { patchContent, patchMarkdown, patchText } from "../../support/patch-preview";

const meta = {
  id: "documents-patch-preview",
  title: "Tasks and conversations/Documents, attachments, and work products/Patch previews",
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: ["documents-artifacts/attachments", "documents-artifacts/documents"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production click-to-preview attachment card, document cards, attachment and workspace source views, and Markdown. Simulated attachment fetch and static patch data includes long unbroken lines, multiple files, and literal HTML. No live storage or save.",
    },
  },
  beforeEach: () => {
    const originalFetch = window.fetch;
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
      if (path === "/api/attachments/patch-story/content") return new Response(patchText, { headers: { "content-type": "application/octet-stream" } });
      return originalFetch(input, init);
    };
    window.fetch = fixtureFetch;
    return () => { if (window.fetch === fixtureFetch) window.fetch = originalFetch; };
  },
  decorators: [(Story) => <main className="min-h-screen bg-background p-4 text-foreground"><Story /></main>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const card = {
  title: "Preview layout fix", summary: "Contain long patch lines in the document preview.",
  author: "Engineer", updatedAt: "Just now", filename: "preview-layout.patch", body: patchText,
};

function InlineAttachment() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}><div className="w-full max-w-md"><IssueArtifactFile
    {...card} id="patch-story" attachmentId="patch-story" contentType="application/octet-stream"
    contentPath="/api/attachments/patch-story/content" downloadPath="/api/attachments/patch-story/content?download=1" byteSize={patchText.length}
  /></div></QueryClientProvider>;
}

export const InlinePatch: Story = {
  render: () => <InlineAttachment />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector('[data-patch-line="add"]')).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Preview patch" }));
    await waitFor(() => expect(canvasElement.querySelector('[data-patch-line="add"]')).not.toBeNull());
    await userEvent.click(canvas.getByRole("button", { name: "Read document" }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
    await expect(dialog.querySelector("pre")?.textContent).toBe(patchText);
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  },
};

export const MarkdownCard: Story = {
  render: () => <div className="w-full max-w-md"><DocumentCard {...card} filename="review.md" body={patchMarkdown} /></div>,
};

export const AttachmentTab: Story = {
  render: () => <div className="h-screen min-w-0 max-w-3xl"><TextAttachmentPreview title="preview-layout.patch" text={patchText} markdown={false} downloadUrl="data:text/x-patch,fixture" /></div>,
};

export const WorkspaceTab: Story = {
  render: () => <div className="flex h-screen min-w-0 max-w-3xl flex-col"><FileContentViewer content={patchContent} highlightedLine={8} /></div>,
};

export const Document: Story = {
  render: () => <div className="min-w-0 max-w-3xl"><MarkdownBody>{patchMarkdown}</MarkdownBody></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const source = canvasElement.querySelector("pre code");
    await expect(source?.textContent).toBe(patchText);
    await userEvent.click(canvas.getByRole("button", { name: "Wrap lines" }));
    await expect(canvas.getByRole("button", { name: "Unwrap lines" })).toHaveAttribute("aria-pressed", "true");
    await expect(source?.textContent).toBe(patchText);
  },
};
