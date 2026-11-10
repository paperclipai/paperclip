import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { expect, userEvent, within } from "storybook/test";
import { ExecutionBlockerNotice } from "@/components/ExecutionBlockerNotice";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { queryKeys } from "@/lib/queryKeys";
import { i18n } from "@/i18n";
import { recoveryAction } from "../../support/workspace-finalization-recovery/fixtures";

const action = {
  ...recoveryAction, status: "resolved" as const, outcome: "blocked" as const,
  cause: "legacy_execution_requires_reconciliation", returnOwnerAgentId: "fixture-worker",
  evidence: { runId: "00000000-0000-4000-8000-000000000826", automaticRecovery: { replay: "blocked" } },
};
const blocker: ExecutionBlocker = {
  recoveryActionId: action.id, runId: action.evidence.runId, agentId: action.returnOwnerAgentId,
  cause: action.cause, runStatus: "cancelled", canContinue: false, canRetry: false, savedMessageCount: 0,
  runError: "Execution stopped without a recorded cancellation request: Disposition repair suppressed: existing_execution",
  nextAction: "Review the stopped run without replaying uncertain actions.",
};
const access = { userId: "user-board", companyIds: [action.companyId], source: "session", isInstanceAdmin: false,
  memberships: [{ companyId: action.companyId, membershipRole: "operator", status: "active" }] };
type Scenario = "review" | "loading" | "missing" | "read-error" | "rejected" | "pending" | "viewer" | "locale-fallback" | "long-labels" | "lost-response";

/** Production API client and notice, with isolated in-memory HTTP responses.
 * This fixture never contacts an execution provider or a live mutation route. */
function ReviewFixture({ scenario }: { scenario: Scenario }) {
  const [translations] = useState(() => {
    const instance = i18n.cloneInstance({ lng: scenario === "locale-fallback" ? "ar" : "en", forkResourceStore: true });
    if (scenario === "long-labels") instance.addResourceBundle("en", "translation", { stoppedRun: {
      review: "Review the recorded outcomes of this stopped execution",
      cancel: "Cancel this review",
      save: "Save the verified outcomes and request continuation",
    } }, true, true);
    return instance;
  });
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState<ExecutionBlocker | null>(blocker);
  const [receipt, setReceipt] = useState<unknown>(null);
  useEffect(() => {
    const original = window.fetch;
    let saved = false;
    let savedResult: { recoveryAction: unknown } | null = null;
    client.setQueryData(queryKeys.auth.session, { user: { id: access.userId } });
    const mockFetch: typeof window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (url.pathname === "/api/cli-auth/me") return Response.json(scenario === "viewer"
        ? { ...access, memberships: [{ ...access.memberships[0], membershipRole: "viewer" }] } : access);
      if (!url.pathname.startsWith(`/api/issues/${action.sourceIssueId}`)) return original(input, init);
      if (url.pathname.endsWith("/recovery-actions/resolve")) {
        if (scenario === "pending") return new Promise<Response>(() => {});
        if (scenario === "rejected") return Response.json({ error: "The previous provider is still running. Review its state before trying again." }, { status: 409 });
        const body = JSON.parse(String(init?.body));
        const result = { issue: { id: action.sourceIssueId, companyId: action.companyId, status: "todo" }, recoveryAction: {
          ...action, outcome: "handed_back", evidence: { runId: action.evidence.runId, continuationDelivery: "pending", executionReconciliation: {
            ...body.executionReconciliation, actorId: access.userId, recordedAt: "2026-11-08T12:00:00Z",
          } },
        } };
        saved = true; savedResult = result; setReceipt(result);
        if (scenario === "lost-response") return Response.json({ error: "The response was interrupted after saving." }, { status: 503 });
        setCurrent(null);
        return Response.json(result);
      }
      if (url.pathname.endsWith("/recovery-actions")) {
        if (url.searchParams.has("inspectSourceActionId") && savedResult) return Response.json({ active: null, actions: [savedResult.recoveryAction] });
        if (scenario === "loading") return new Promise<Response>(() => {});
        if (scenario === "read-error") return Response.json({ error: "Recovery record unavailable" }, { status: 503 });
        return Response.json({ active: null, actions: saved || scenario === "missing" ? [] : [action] });
      }
      return Response.json({ error: "No fixture for this request" }, { status: 501 });
    };
    window.fetch = mockFetch; setReady(true);
    return () => { if (window.fetch === mockFetch) window.fetch = original; client.clear(); };
  }, [client, scenario]);
  return <I18nextProvider i18n={translations}><QueryClientProvider client={client}>
    <main lang={translations.language} dir={translations.dir()} className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 text-foreground">
      <TaskChatBubble item={{ id: "fixture-message", kind: "message", author: "human", authorName: "Alex",
        text: "Finish the saved task after reviewing the stopped attempt." }} />
      {ready ? <ExecutionBlockerNotice issueId={action.sourceIssueId} companyId={action.companyId}
        executionBlocker={current} presentation={null} canRetry={false} onRetry={() => {}} /> : null}
      {receipt ? <details><summary>Fixture receipt (no provider execution)</summary><pre className="overflow-auto text-xs">{JSON.stringify(receipt, null, 2)}</pre></details> : null}
    </main>
  </QueryClientProvider></I18nextProvider>;
}

const meta = {
  id: "stopped-run-review", title: "Projects and execution/Recovery/Stopped run review",
  component: ReviewFixture, args: { scenario: "review" }, render: args => <ReviewFixture key={args.scenario} {...args} />,
  parameters: { layout: "fullscreen", paperclip: {
    capabilities: ["recovery/diagnosis", "recovery/source-action"], implementation: "production", boundary: "fixtures",
    notes: "Settled legacy no-replay hold with active:null. Production notice and HTTP client; fixture responses cover review, loading, missing record, rejection, pending, read-only access and receipt persistence. Server authority and stop proof are covered by isolated route tests, not these simulated responses.",
  } },
} satisfies Meta<typeof ReviewFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Review: Story = {};
export const Expanded: Story = { play: async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: "Review stopped run" }));
} };
export const Loading: Story = { args: { scenario: "loading" } };
export const MissingRecord: Story = { args: { scenario: "missing" } };
export const ReadError: Story = { args: { scenario: "read-error" } };
export const Rejected: Story = { args: { scenario: "rejected" } };
export const Pending: Story = { args: { scenario: "pending" } };
export const ReadOnly: Story = { args: { scenario: "viewer" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
export const LocaleFallback: Story = { args: { scenario: "locale-fallback" } };
export const LongLabels: Story = { args: { scenario: "long-labels" } };
export const LostResponse: Story = { args: { scenario: "lost-response" } };
export const Saved: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Review stopped run" }));
  await userEvent.click(canvas.getByLabelText("No actions were performed"));
  await userEvent.type(canvas.getByLabelText("Outcome evidence"), "The stopped run logs and external receipts confirm that no action was performed.");
  await userEvent.click(canvas.getByRole("button", { name: "Save and continue" }));
  await expect(await canvas.findByRole("status")).toHaveTextContent("Outcome review saved");
} };
