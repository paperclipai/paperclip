import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  RoutineListRow,
  type RoutineListAgentSummary,
  type RoutineListProjectSummary,
  type RoutineListRowItem,
} from "@/components/RoutineList";

const projectById = new Map<string, RoutineListProjectSummary>([
  ["p1", { name: "Board UI", color: "#6366f1" }],
  ["p2", { name: "Growth", color: "#10b981" }],
]);
const agentById = new Map<string, RoutineListAgentSummary>([
  ["a1", { name: "CodexCoder", icon: null }],
  ["a2", { name: "Digest Bot", icon: null }],
]);

type Group = { key: string; label: string | null; items: RoutineListRowItem[] };

const GROUPS: Group[] = [
  {
    key: "p1",
    label: "Board UI",
    items: [
      { id: "r1", title: "Weekly digest", status: "active", projectId: "p1", assigneeAgentId: "a2", lastRun: { triggeredAt: "2026-06-09T08:00:00Z", status: "succeeded" } },
      { id: "r2", title: "Triage stale issues", status: "active", projectId: "p1", assigneeAgentId: "a1", lastRun: { triggeredAt: "2026-06-08T08:00:00Z", status: "succeeded" } },
      { id: "r3", title: "Nightly changelog draft", status: "paused", projectId: "p1", assigneeAgentId: "a1", lastRun: null },
    ],
  },
  {
    key: "p2",
    label: "Growth",
    items: [
      { id: "r4", title: "Lead enrichment sweep", status: "active", projectId: "p2", assigneeAgentId: "a1", lastRun: { triggeredAt: "2026-06-09T06:00:00Z", status: "running" } },
      { id: "r5", title: "Outbound follow-ups", status: "active", projectId: "p2", assigneeAgentId: "a2", lastRun: { triggeredAt: "2026-06-07T06:00:00Z", status: "failed" } },
    ],
  },
];

function GroupedList() {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="flex flex-col gap-3">
        {GROUPS.map((group) => {
          const isOpen = !collapsed.includes(group.key);
          return (
            <Collapsible
              key={group.key}
              open={isOpen}
              onOpenChange={(open) =>
                setCollapsed((prev) => (open ? prev.filter((k) => k !== group.key) : [...prev, group.key]))
              }
            >
              {group.label ? (
                <div className={`flex items-center gap-2 rounded-lg border border-border px-3 py-2${isOpen ? " mb-1" : ""}`}>
                  <CollapsibleTrigger className="flex items-center gap-1.5">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                    <span className="text-sm font-semibold uppercase tracking-wide">{group.label}</span>
                  </CollapsibleTrigger>
                  <span className="text-xs text-muted-foreground">{group.items.length}</span>
                </div>
              ) : null}
              <CollapsibleContent>
                {group.items.map((routine) => (
                  <RoutineListRow
                    key={routine.id}
                    routine={routine}
                    projectById={projectById}
                    agentById={agentById}
                    runningRoutineId={null}
                    statusMutationRoutineId={null}
                    href={`#${routine.id}`}
                    runNowButton
                    divider={false}
                    onRunNow={() => {}}
                    onToggleEnabled={() => {}}
                    onToggleArchived={() => {}}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}

const meta: Meta<typeof GroupedList> = {
  title: "Product/Routines · List (grouped cards)",
  component: GroupedList,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof GroupedList>;

export const GroupedCards: Story = {};
