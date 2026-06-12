import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PipelinesIndexTable, type PipelineViewMode } from "@/pages/Pipelines";
import type { PipelineListItem } from "@/api/pipelines";

const COMPANY_ID = "company-storybook";

function pipeline(partial: Partial<PipelineListItem> & { id: string; name: string }): PipelineListItem {
  return {
    companyId: COMPANY_ID,
    key: partial.id,
    description: null,
    projectId: null,
    enforceTransitions: false,
    archivedAt: null,
    stageCount: 4,
    openCaseCount: 0,
    attentionCount: 0,
    inMotionCount: 0,
    lastActivityAt: "2026-06-10T12:00:00.000Z",
    connections: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    ...partial,
  };
}

const PIPELINES: PipelineListItem[] = [
  pipeline({
    id: "content",
    name: "Content production",
    description: "Draft, review, and publish launch content.",
    openCaseCount: 12,
    attentionCount: 3,
    inMotionCount: 5,
    lastActivityAt: "2026-06-11T09:30:00.000Z",
  }),
  pipeline({
    id: "support",
    name: "Customer support triage",
    openCaseCount: 27,
    attentionCount: 8,
    inMotionCount: 2,
    lastActivityAt: "2026-06-11T11:55:00.000Z",
  }),
  pipeline({
    id: "hiring",
    name: "Hiring funnel",
    openCaseCount: 4,
    attentionCount: 0,
    inMotionCount: 9,
    lastActivityAt: "2026-06-09T08:00:00.000Z",
  }),
  pipeline({
    id: "billing",
    name: "Billing disputes",
    openCaseCount: 1,
    attentionCount: 1,
    inMotionCount: 0,
    lastActivityAt: "2026-05-30T08:00:00.000Z",
  }),
];

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      <div className="ml-auto max-w-6xl">{children}</div>
    </div>
  );
}

function Wrapper() {
  const [viewMode, setViewMode] = useState<PipelineViewMode>("flat");
  const [search, setSearch] = useState("");
  return (
    <PipelinesIndexTable
      pipelines={PIPELINES}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      connectionsAvailable={false}
      search={search}
      onSearchChange={setSearch}
    />
  );
}

const meta: Meta<typeof PipelinesIndexTable> = {
  title: "Pipelines/Index table",
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof PipelinesIndexTable>;

export const Default: Story = {
  name: "Toggle + sort controls",
  render: () => (
    <Frame>
      <Wrapper />
    </Frame>
  ),
};
