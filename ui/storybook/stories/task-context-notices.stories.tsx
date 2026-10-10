import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, within } from "storybook/test";
import { ExternallyConnectedTaskBanner } from "@/components/chat/ExternallyConnectedTaskBanner";
import { ExecutionBlockerNotice } from "@/components/ExecutionBlockerNotice";
import { EmailMessageCard } from "@/components/EmailMessageCard";
import { queryKeys } from "@/lib/queryKeys";

const shellSectionClass = "mx-auto w-full max-w-(--tc-shell-max-w)";

function TaskContextNotices() {
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    cache.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: true });
    cache.setQueryData(["issue-chat-binding", "demo", "context-notices"], {
      endpointId: "slack-demo", provider: "slack", externalLabel: "#design · Card styling",
      externalUrl: "https://slack.com", conversationId: "demo-thread", assignedAgentLocked: true,
    });
    cache.setQueryData(queryKeys.issues.runs("context-notices"), []);
    return cache;
  });
  return (
    <QueryClientProvider client={client}>
      <main className="min-h-screen bg-background p-6 text-foreground">
        <div className="w-full space-y-3">
          <h1 className={`${shellSectionClass} text-xl font-semibold`}>Chat connection and recovery</h1>
          <ExternallyConnectedTaskBanner className={`${shellSectionClass} mt-3`} companyId="demo" issueId="context-notices" />
          <ExecutionBlockerNotice className={shellSectionClass} companyId="demo" issueId="context-notices" onRetried={() => {}}
            blocker={{ recoveryActionId: "demo-recovery", runId: null, agentId: null, cause: "action_outcome_unknown",
              nextAction: "Inspect the run before continuing. Recorded work is preserved." }} />
          <div className={shellSectionClass}>
          <EmailMessageCard contextNotice issueId="context-notices" message={{
            id: "email-demo", providerMessageId: "email-demo", direction: "inbound",
            from: "operator@example.com", to: ["agent@example.com"], subject: "Card styling",
            text: "Please keep the connection and recovery cards consistent.",
            fullText: "Please keep the connection and recovery cards consistent.",
            commentId: null, attachmentIds: [], timestamp: "2026-10-09T12:00:00Z", automatic: false,
          }} />
          </div>
        </div>
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Tasks/Context notices",
  component: TaskContextNotices,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TaskContextNotices>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectionAndRecovery: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const connection = await canvas.findByRole("region", { name: "External conversation" });
    const recovery = canvas.getByRole("status", { name: "Task recovery" });
    const email = canvas.getByRole("article", { name: "Email received" });
    for (const card of [recovery, email]) {
      await expect(card.getBoundingClientRect().width).toBe(connection.getBoundingClientRect().width);
      await expect(getComputedStyle(card).backgroundColor).toBe(getComputedStyle(connection).backgroundColor);
      await expect(getComputedStyle(card).padding).toBe(getComputedStyle(connection).padding);
      await expect(getComputedStyle(card).borderRadius).toBe(getComputedStyle(connection).borderRadius);
    }
  },
};
