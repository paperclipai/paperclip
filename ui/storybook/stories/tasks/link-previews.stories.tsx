import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { recognizeLinkPreview, type LinkPreviewState } from "@paperclipai/shared";
import { MarkdownBody } from "@/components/MarkdownBody";
import { LinkPreviewProvider } from "@/context/LinkPreviewContext";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

interface PreviewArgs { state: LinkPreviewState; mode: "ready" | "loading" | "unavailable" | "failure"; longTitle: boolean }

function PreviewExample(_args: PreviewArgs) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>
    <LinkPreviewProvider companyId="company-storybook" userId="user-board">
      <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-medium">Pull request links</h1>
          <p className="text-sm text-muted-foreground">Hover or focus a link for context. Repeated links share what we learn.</p>
        </header>
        <section data-testid="first-mention">
          <MarkdownBody linkIssueReferences={false}>{"The fix is ready at https://github.com/acme/web/pull/241. Please review it before release."}</MarkdownBody>
        </section>
        <section data-testid="second-mention">
          <MarkdownBody linkIssueReferences={false}>{'[Review the same pull request](https://www.github.com/Acme/Web/pull/241/files?diff=split#discussion_r123 "Exact review location") from another message.'}</MarkdownBody>
        </section>
        <MarkdownBody linkIssueReferences={false}>{"Other links stay simple: [repository](https://github.com/acme/web), [build](https://example.com/build/42), and `https://github.com/acme/web/pull/241`."}</MarkdownBody>
      </main>
    </LinkPreviewProvider>
  </QueryClientProvider>;
}

const meta = {
  id: "tasks-link-previews",
  title: "Tasks and conversations/Task creation and lifecycle/Link previews",
  component: PreviewExample,
  args: { state: "open", mode: "ready", longTitle: false },
  beforeEach: ({ args }) => {
    const fixture = prepareFixtureApi([{
      path: "/api/companies/company-storybook/link-preview",
      state: args.mode === "loading" ? "loading" : args.mode === "failure" ? "failure" : "ready",
      read: () => ({
        preview: args.mode === "unavailable" ? null : {
          target: recognizeLinkPreview("https://github.com/acme/web/pull/241")!,
          title: args.longTitle ? "Preserve the exact review location and share pull request status across conversations, documents, and long references in narrow layouts" : "Keep inline links readable",
          state: args.state, author: "octocat", updatedAt: "2026-11-10T12:00:00Z",
        },
        maxAgeMs: 60_000,
      }),
    }]);
    return fixture.cleanup;
  },
  parameters: {
    paperclip: {
      capabilities: ["tasks/discussion"], status: "current", implementation: "production", boundary: "fixtures",
      notes: "Production MarkdownBody, LinkPreviewProvider, query cache, and anchored hover card. HTTP fixtures cover deferred lookup, shared duplicate status, known PR states, loading, unavailable and failed reads. No live GitHub authorization, task persistence, or provider mutations.",
    },
  },
} satisfies Meta<PreviewArgs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {};
const openPreview: Story["play"] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const first = within(canvas.getByTestId("first-mention")).getByRole("link");
  await expect(first).toHaveAttribute("data-link-state", "unknown");
  await userEvent.tab();
  await expect(first).toHaveFocus();
  const body = within(canvasElement.ownerDocument.body);
  await waitFor(() => expect(body.getByRole("tooltip")).toBeVisible());
  if (args.mode === "ready") {
    await waitFor(() => expect(first).toHaveAttribute("data-link-state", args.state));
    await expect(within(canvas.getByTestId("second-mention")).getByRole("link")).toHaveAttribute("data-link-state", args.state);
  } else if (args.mode === "loading") {
    await expect(body.getByRole("status")).toHaveTextContent("Loading pull request…");
  } else {
    await waitFor(() => expect(body.queryByRole("status")).toBeNull());
    await expect(first).toHaveAttribute("data-link-state", "unknown");
  }
};
export const Open: Story = { play: openPreview };
export const Merged: Story = { args: { state: "merged" }, play: openPreview };
export const Conflicts: Story = { args: { state: "conflicts" }, play: openPreview };
export const Draft: Story = { args: { state: "draft" }, play: openPreview };
export const Closed: Story = { args: { state: "closed" }, play: openPreview };
export const Loading: Story = { args: { mode: "loading" }, play: openPreview };
export const Unavailable: Story = { args: { mode: "unavailable" }, play: openPreview };
export const FailedRead: Story = { args: { mode: "failure" }, play: openPreview };
export const Narrow: Story = {
  args: { state: "merged", longTitle: true }, play: openPreview,
  globals: { viewport: { value: "mobile1", isRotated: false } }, parameters: { waitForViewport: true },
};
