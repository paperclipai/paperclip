import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { recognizeLinkPreview, type LinkPreviewState } from "@paperclipai/shared";
import { MarkdownBody } from "@/components/MarkdownBody";
import { LinkPreviewProvider } from "@/context/LinkPreviewContext";
import { startPersistedQueryCache } from "@/lib/persisted-query-cache";
import { queryKeys } from "@/lib/queryKeys";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

interface PreviewArgs { state: LinkPreviewState; mode: "ready" | "loading" | "unavailable" | "failure"; longTitle: boolean }

function PreviewExample({ client: restoredClient }: PreviewArgs & { client?: QueryClient }) {
  const [localClient] = useState(() => new QueryClient());
  const client = restoredClient ?? localClient;
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

function PersistedPreviewExample(args: PreviewArgs) {
  const [client] = useState(() => new QueryClient());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-board" } });
    client.setQueryData(queryKeys.companies.list("user-board"), { companies: [{ id: "company-storybook" }] });
    const cache = startPersistedQueryCache(client, { buildId: "link-preview-story-v1" });
    setReady(true);
    return () => { cache.dispose(); client.clear(); };
  }, [client]);
  return ready ? <PreviewExample {...args} client={client} /> : null;
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
      notes: "Production MarkdownBody, LinkPreviewProvider, query cache, and anchored hover card. HTTP fixtures cover deferred lookup, shared duplicate status, known PR states, loading, unavailable and failed reads. Real pointer and keyboard interactions are checked in tests/storybook-visual/link-previews.spec.ts. No live GitHub authorization, task persistence, or provider mutations.",
    },
  },
} satisfies Meta<PreviewArgs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {};
export const ReloadCache: Story = {
  render: args => <PersistedPreviewExample {...args} />,
  parameters: { paperclip: { notes: "Production browser read-cache persistence with fixture account/company identity. Load a PR, then reload this iframe to retain the learned status. Fresh previews reuse their original read time; stale previews refresh only on hover or focus. No live provider authorization is claimed." } },
};
export const Open: Story = {};
export const Merged: Story = { args: { state: "merged" } };
export const Conflicts: Story = { args: { state: "conflicts" } };
export const Draft: Story = { args: { state: "draft" } };
export const Closed: Story = { args: { state: "closed" } };
export const Loading: Story = { args: { mode: "loading" } };
export const Unavailable: Story = { args: { mode: "unavailable" } };
export const FailedRead: Story = { args: { mode: "failure" } };
export const Narrow: Story = {
  args: { state: "merged", longTitle: true },
  globals: { viewport: { value: "mobile1", isRotated: false } }, parameters: { waitForViewport: true },
};
