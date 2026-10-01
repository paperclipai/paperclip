import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  __liveUpdatesTestUtils,
  type CompanyLiveEventHandler,
} from "@/context/LiveUpdatesProvider";
import type {
  GetSummarySlotResponse,
  ListSummarySlotRevisionsResponse,
  SummarySlot,
  SummarySlotDocument,
  SummarySlotIssueRef,
  SummarySlotRevision,
} from "@paperclipai/shared";

import { SummarySlotCard } from "@/components/SummarySlotCard";
import type { BuiltInAgentState } from "@/api/builtInAgents";
import { queryKeys } from "@/lib/queryKeys";

// QA fixtures for PAP-13939 — mirror the shapes exercised by
// SummarySlotCard.test.tsx so the browser render matches the unit coverage.

const COMPANY_ID = "company-1";
const SCOPE_KIND = "project" as const;
const SCOPE_ID = "project-1";
const SLOT_KEY = "header" as const;

const LATEST_BODY = [
  "### Needs you",
  "",
  "- Approve the pricing plan — it has been waiting on you since yesterday.",
  "- Answer QA's question about the login flow.",
  "",
  "### Since you were last here",
  "",
  "The team finished the search filters and shipped the mobile layout. Two tasks are still in review; nothing else is stuck.",
].join("\n");

const OLD_BODY = [
  "### Needs you",
  "",
  "- Review the search filter PR before QA can start.",
].join("\n");

const MID_BODY = [
  "### Needs you",
  "",
  "- Confirm whether the board wants mobile screenshots in the release note.",
  "",
  "### Since you were last here",
  "",
  "The Summarizer drafted a shorter update, but QA had not finished the login smoke yet.",
].join("\n");

const RECENT_BODY = [
  "### Needs you",
  "",
  "- Answer QA's question about the login flow.",
  "",
  "### Since you were last here",
  "",
  "Search filters shipped and the mobile layout passed a first visual review.",
].join("\n");

function readySummarizer(): BuiltInAgentState {
  return {
    definition: {
      key: "summarizer",
      displayName: "Summarizer",
      featureKeys: ["summarizer"],
      shortPurpose: "Writes summaries",
      defaultInstructions: "Summarize",
      defaultRole: "Summarizer",
    },
    status: "ready",
    agentId: "agent-summarizer",
    agent: null,
    pauseReason: null,
    resources: [],
  };
}

function needsSetupSummarizer(): BuiltInAgentState {
  return { ...readySummarizer(), status: "needs_setup" };
}

function slot(overrides: Partial<SummarySlot> = {}): SummarySlot {
  return {
    id: "slot-1",
    companyId: COMPANY_ID,
    scopeKind: SCOPE_KIND,
    scopeId: SCOPE_ID,
    slotKey: SLOT_KEY,
    documentId: null,
    status: "idle",
    failureReason: null,
    generatingIssueId: null,
    lastGeneratedAt: null,
    lastGeneratedByAgentId: null,
    lastModel: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T16:12:00.000Z",
    ...overrides,
  };
}

function summaryDocument(overrides: Partial<SummarySlotDocument> = {}): SummarySlotDocument {
  return {
    id: "doc-1",
    companyId: COMPANY_ID,
    title: "Project summary",
    format: "markdown",
    body: LATEST_BODY,
    latestRevisionId: "rev-2",
    latestRevisionNumber: 2,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: "agent-summarizer",
    updatedByUserId: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-14T16:12:00.000Z",
    ...overrides,
  };
}

function issue(overrides: Partial<SummarySlotIssueRef> = {}): SummarySlotIssueRef {
  return {
    id: "issue-1",
    identifier: "PAP-14000",
    title: "Summarize project",
    status: "in_progress",
    ...overrides,
  };
}

function revision(overrides: Partial<SummarySlotRevision> = {}): SummarySlotRevision {
  return {
    id: "rev-1",
    companyId: COMPANY_ID,
    documentId: "doc-1",
    revisionNumber: 1,
    title: "Project summary",
    format: "markdown",
    body: OLD_BODY,
    changeSummary: null,
    createdByAgentId: "agent-summarizer",
    createdByUserId: null,
    createdByRunId: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

interface SeedInput {
  enableSummaries?: boolean;
  agent?: BuiltInAgentState;
  slotResponse?: GetSummarySlotResponse;
  revisionsResponse?: ListSummarySlotRevisionsResponse;
}

function Seed({ seed, children }: { seed: SeedInput; children: ReactNode }) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.instance.experimentalSettings, {
    enableSummaries: seed.enableSummaries ?? true,
  });
  if (seed.agent) {
    queryClient.setQueryData(queryKeys.builtInAgents.list(COMPANY_ID), [seed.agent]);
  }
  if (seed.slotResponse) {
    queryClient.setQueryData(
      queryKeys.summarySlots.detail(COMPANY_ID, SCOPE_KIND, SLOT_KEY, SCOPE_ID),
      seed.slotResponse,
    );
  }
  if (seed.revisionsResponse) {
    queryClient.setQueryData(
      queryKeys.summarySlots.revisions(COMPANY_ID, SCOPE_KIND, SLOT_KEY, SCOPE_ID),
      seed.revisionsResponse,
    );
  }
  return <>{children}</>;
}

function CardHarness({ seed, width }: { seed: SeedInput; width: number }) {
  return (
    <Seed seed={seed}>
      <div style={{ width, maxWidth: "100%" }}>
        <SummarySlotCard
          companyId={COMPANY_ID}
          scopeKind={SCOPE_KIND}
          scopeId={SCOPE_ID}
          slotKey={SLOT_KEY}
          title="Project summary"
          description="Summarizer keeps the latest project status, next step, and operator-needed items here."
        />
      </div>
    </Seed>
  );
}

const { LiveEventSubscriptionContext, dispatchLiveEventToSubscribers } = __liveUpdatesTestUtils;

// Wraps the card in the shared live-event subscription and pushes a single
// heartbeat.run.progress event once the card has mounted, so the generating
// state renders its live status line (PAP-13984).
function LiveStatusHarness({ seed, width, message }: { seed: SeedInput; width: number; message: string }) {
  const subscribersRef = useRef<Set<CompanyLiveEventHandler>>(new Set());
  const subscription = useRef({
    subscribe: (fn: CompanyLiveEventHandler) => {
      subscribersRef.current.add(fn);
      return () => {
        subscribersRef.current.delete(fn);
      };
    },
  });

  useEffect(() => {
    dispatchLiveEventToSubscribers(subscribersRef.current, COMPANY_ID, {
      id: 1,
      companyId: COMPANY_ID,
      type: "heartbeat.run.progress",
      createdAt: "2026-07-15T00:00:00.000Z",
      payload: { issueId: "issue-1", message },
    });
  }, [message]);

  return (
    <LiveEventSubscriptionContext.Provider value={subscription.current}>
      <CardHarness seed={seed} width={width} />
    </LiveEventSubscriptionContext.Provider>
  );
}

// Streams the summarize-status output protocol (STATUS lines + sentinel-wrapped
// draft) over the shared live-event socket so the card renders its token-streamed
// draft preview (PAP-13986). Learns the run id from a progress event first, then
// pushes the assistant `acpx.text_delta` records that carry the draft.
function StreamingDraftHarness({
  seed,
  width,
  draftText,
  sliceSize = 8,
}: {
  seed: SeedInput;
  width: number;
  draftText: string;
  sliceSize?: number;
}) {
  const subscribersRef = useRef<Set<CompanyLiveEventHandler>>(new Set());
  const subscription = useRef({
    subscribe: (fn: CompanyLiveEventHandler) => {
      subscribersRef.current.add(fn);
      return () => {
        subscribersRef.current.delete(fn);
      };
    },
  });

  useEffect(() => {
    const runId = "run-summary-1";
    dispatchLiveEventToSubscribers(subscribersRef.current, COMPANY_ID, {
      id: 1,
      companyId: COMPANY_ID,
      type: "heartbeat.run.progress",
      createdAt: "2026-07-15T00:00:00.000Z",
      payload: { issueId: "issue-1", runId },
    });
    // Defer the token deltas one tick so the learned run id has committed before
    // the log handler filters on it.
    const timer = window.setTimeout(() => {
      let seq = 1;
      for (let i = 0; i < draftText.length; i += sliceSize) {
        dispatchLiveEventToSubscribers(subscribersRef.current, COMPANY_ID, {
          id: seq + 1,
          companyId: COMPANY_ID,
          type: "heartbeat.run.log",
          createdAt: "2026-07-15T00:00:00.000Z",
          payload: {
            runId,
            seq,
            ts: "2026-07-15T00:00:00.000Z",
            stream: "stdout",
            chunk: JSON.stringify({
              type: "acpx.text_delta",
              text: draftText.slice(i, i + sliceSize),
              channel: "output",
            }),
          },
        });
        seq += 1;
      }
    }, 30);
    return () => window.clearTimeout(timer);
  }, [draftText, sliceSize]);

  return (
    <LiveEventSubscriptionContext.Provider value={subscription.current}>
      <CardHarness seed={seed} width={width} />
    </LiveEventSubscriptionContext.Provider>
  );
}

const STREAMING_DRAFT_PARTIAL = [
  "STATUS: reviewing 14 open issues…",
  "STATUS: writing the summary…",
  "<<<SUMMARY-DRAFT>>>",
  "### Needs you",
  "",
  "- Approve the pricing plan — it has been waiting since yesterday.",
  "- Answer QA's question about the login flow.",
  "",
  "### Since you were last here",
  "",
  "The team finished the search filters and the mobile layout is now",
].join("\n");

const STREAMING_DRAFT_COMPLETE = [
  STREAMING_DRAFT_PARTIAL,
  " passing a first visual review. Nothing else is stuck.\n",
  "<<<END-SUMMARY-DRAFT>>>\n",
].join("");

const DESKTOP = 640;
const MOBILE = 375;

const meta: Meta<typeof CardHarness> = {
  title: "Summaries/SummarySlotCard",
  component: CardHarness,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof CardHarness>;

const emptySeed: SeedInput = {
  agent: readySummarizer(),
  slotResponse: { slot: null, document: null, generatingIssue: null },
  revisionsResponse: { slot: null, revisions: [] },
};

const setupSeed: SeedInput = {
  agent: needsSetupSummarizer(),
  slotResponse: { slot: null, document: null, generatingIssue: null },
};

const generatingSeed: SeedInput = {
  agent: readySummarizer(),
  slotResponse: {
    slot: slot({ status: "generating", generatingIssueId: "issue-1" }),
    document: null,
    generatingIssue: issue({ status: "in_progress" }),
  },
};

const generatedSeed: SeedInput = {
  agent: readySummarizer(),
  slotResponse: {
    slot: slot({ documentId: "doc-1", lastModel: "claude-haiku" }),
    document: summaryDocument(),
    generatingIssue: null,
  },
  revisionsResponse: {
    slot: slot({ documentId: "doc-1" }),
    revisions: [revision({ id: "rev-2", revisionNumber: 2, body: LATEST_BODY })],
  },
};

const historySeed: SeedInput = {
  agent: readySummarizer(),
  slotResponse: {
    slot: slot({ documentId: "doc-1" }),
    document: summaryDocument({ latestRevisionId: "rev-4", latestRevisionNumber: 4 }),
    generatingIssue: null,
  },
  revisionsResponse: {
    slot: slot({ documentId: "doc-1" }),
    revisions: [
      revision({ id: "rev-1", revisionNumber: 1, body: OLD_BODY, createdAt: "2026-07-08T11:02:00.000Z" }),
      revision({ id: "rev-2", revisionNumber: 2, body: MID_BODY, createdAt: "2026-07-10T14:42:00.000Z" }),
      revision({ id: "rev-3", revisionNumber: 3, body: RECENT_BODY, createdAt: "2026-07-13T09:25:00.000Z" }),
      revision({ id: "rev-4", revisionNumber: 4, body: LATEST_BODY, createdAt: "2026-07-14T16:12:00.000Z" }),
    ],
  },
};

const failedSeed: SeedInput = {
  agent: readySummarizer(),
  slotResponse: {
    slot: slot({
      status: "failed",
      failureReason: "Summary generation task PAP-14000: Summarize project finished without writing a summary.",
      generatingIssueId: "issue-1",
    }),
    document: null,
    generatingIssue: issue({ status: "done" }),
  },
};

export const Disabled: Story = {
  args: { seed: { enableSummaries: false, agent: readySummarizer() }, width: DESKTOP },
};

export const SetupCta: Story = { args: { seed: setupSeed, width: DESKTOP } };
export const Empty: Story = { args: { seed: emptySeed, width: DESKTOP } };
export const Generating: Story = { args: { seed: generatingSeed, width: DESKTOP } };
export const GeneratingWithStatusLine: StoryObj<typeof LiveStatusHarness> = {
  render: (args) => <LiveStatusHarness {...args} />,
  args: {
    seed: generatingSeed,
    width: DESKTOP,
    message: "Reviewing 14 open issues, drafting the “Needs you” section…",
  },
};
// PAP-13986 — token-streamed draft rendering.
export const StreamingDraft: StoryObj<typeof StreamingDraftHarness> = {
  render: (args) => <StreamingDraftHarness {...args} />,
  args: { seed: generatingSeed, width: DESKTOP, draftText: STREAMING_DRAFT_PARTIAL },
};
export const StreamingDraftComplete: StoryObj<typeof StreamingDraftHarness> = {
  render: (args) => <StreamingDraftHarness {...args} />,
  args: { seed: generatingSeed, width: DESKTOP, draftText: STREAMING_DRAFT_COMPLETE },
};
// Finalize handoff: the authoritative revision has landed (Phase 1 invalidation)
// and replaced the streamed preview.
export const FinalizeHandoff: Story = { args: { seed: generatedSeed, width: DESKTOP } };

export const Generated: Story = { args: { seed: generatedSeed, width: DESKTOP } };
export const HistoryRevisions: Story = { args: { seed: historySeed, width: DESKTOP } };
export const FailedRetry: Story = { args: { seed: failedSeed, width: DESKTOP } };

export const EmptyMobile: Story = { args: { seed: emptySeed, width: MOBILE } };
export const GeneratedMobile: Story = { args: { seed: generatedSeed, width: MOBILE } };
export const HistoryRevisionsMobile: Story = { args: { seed: historySeed, width: MOBILE } };
export const SetupCtaMobile: Story = { args: { seed: setupSeed, width: MOBILE } };
