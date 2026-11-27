import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { MarkdownWordStreaming } from "@/components/MarkdownWordStreaming";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "@/components/MarkdownBody";

const references: MarkdownExternalReferenceMap = {
  "https://github.com/acme/web/pull/241": {
    providerKey: "github", objectType: "pull_request", displayKey: "GitHub pull request",
    statusCategory: "succeeded", statusIconKey: "git-merge", liveness: "fresh",
    statusLabel: "Merged", displayTitle: "Keep inline links readable",
  },
};

function Sample({ label, markdown, resolved = false }: { label: string; markdown: string; resolved?: boolean }) {
  return <section className="flex min-w-0 flex-col gap-3">
    <h2 className="text-xs font-semibold text-muted-foreground">{label}</h2>
    <MarkdownBody linkIssueReferences={false} externalReferences={resolved ? references : undefined}>{markdown}</MarkdownBody>
  </section>;
}

function InlineLinksGallery() {
  return <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
    <header className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">INLINE LINKS</p>
      <h1 className="text-2xl font-semibold">A little more context, right in the line.</h1>
      <p className="text-sm text-muted-foreground">GitHub references stay compact. Each resource has a familiar icon.</p>
    </header>
    <Sample label="In a conversation" markdown={
      "The fix is ready at https://github.com/acme/web/pull/241. It closes https://github.com/acme/web/issues/42 and updates https://github.com/acme/web. Please take a look before the next release."
    } />
    <Sample label="Repository · Pull request · Issue · GitHub" markdown={
      "https://github.com/paperclipai/paperclip\n\nhttps://github.com/paperclipai/paperclip/pull/4099\n\nhttps://github.com/paperclipai/paperclip/issues/1778\n\n[GitHub Actions](https://github.com/features/actions)"
    } />
    <Sample label="Your words stay yours" markdown={
      '[Review the changes](https://github.com/acme/web/pull/241) and [**read** the issue](https://github.com/acme/web/issues/42).\n\n[Jump to the review comment](https://github.com/acme/web/pull/241/files?diff=split#discussion_r123 "Review comment on the exact diff") or open the [repository](https://github.com/acme/web).'
    } />
    <Sample label="Connected metadata keeps its status and title" resolved markdown={
      "Already shipped: [Keep inline links readable](https://github.com/acme/web/pull/241)."
    } />
    <Sample label="Other destinations keep their usual treatment" markdown={
      "Read the [documentation](https://example.com/docs), open [company settings](/company/settings), or share https://github.com.example.com/acme/web/pull/241.\n\nCode stays literal: `https://github.com/acme/web/pull/241`."
    } />
    <Sample label="Long references still wrap" markdown={
      "Follow https://github.com/an-organization-with-a-long-name/a-repository-with-an-equally-long-name/pull/123456/files?diff=split#discussion_r123456."
    } />
  </main>;
}

const meta = {
  id: "tasks-inline-links",
  title: "Tasks and conversations/Task creation and lifecycle/Inline links",
  component: InlineLinksGallery,
  parameters: {
    paperclip: {
      capabilities: ["tasks/discussion"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Mounts MarkdownBody with synthetic text and one host-resolved metadata fixture. Covers URL-derived GitHub repository, pull request and issue icons, authored labels, exact anchors, generic links, code, wrapping, streaming playback labels, and existing connected status. No remote metadata requests, provider actions, or production persistence.",
    },
  },
} satisfies Meta<typeof InlineLinksGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pr = canvas.getByRole("link", { name: "GitHub pull request: acme/web#241" });
    await expect(pr).toHaveAttribute("href", "https://github.com/acme/web/pull/241");
    await expect(pr).toHaveAttribute("target", "_blank");
    await expect(pr.querySelector(".lucide-git-pull-request")).not.toBeNull();
    const issue = canvas.getByRole("link", { name: "GitHub issue: acme/web#42" });
    await expect(issue.querySelector(".lucide-circle-dot")).not.toBeNull();
    await expect(canvas.getByRole("link", { name: "GitHub pull request: Review the changes" })).toBeVisible();
    await expect(canvas.getByRole("link", { name: "GitHub pull request Merged: Keep inline links readable" })).toHaveAttribute("data-external-status", "succeeded");
    await expect(canvas.getByText("https://github.com/acme/web/pull/241", { selector: "code" })).toBeVisible();
  },
};

export const Narrow: Story = {
  ...Playground,
  parameters: { waitForViewport: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

export const Streaming: Story = {
  ...Playground,
  decorators: [(Story) => <MarkdownWordStreaming.Provider value><Story /></MarkdownWordStreaming.Provider>],
};
