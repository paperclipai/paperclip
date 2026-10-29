import { useLayoutEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ActivityEvent } from "@paperclipai/shared";
import { ActivityList } from "@/components/ActivityList";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FlyoutAppearanceProvider } from "@/components/ui/flyout";
import { queryKeys } from "@/lib/queryKeys";
import { storybookActivityEvents, storybookAgentMap, storybookProjects } from "../../fixtures/paperclipData";
import { recoveryChild } from "./task-list-data";

type Density = "comfortable" | "compact";
type Width = "standard" | "narrow" | "smallest";
export type ActivityListPreviewProps = {
  density?: Density;
  containerWidth?: Width;
  withReferences?: boolean;
  onDensityChange?: (density: Density) => void;
  onWidthChange?: (width: Width) => void;
};

const project = storybookProjects[0]!;
const base: ActivityEvent = { ...storybookActivityEvents[0]!, actorType: "user", actorId: "board", createdAt: new Date("2026-10-15T00:00:00Z") };
const events: ActivityEvent[] = [
  { ...base, id: "activity-task", action: "issue.updated", entityType: "issue", entityId: recoveryChild.id },
  { ...base, id: "activity-agent", action: "agent.paused", entityType: "agent", entityId: "agent-codex" },
  { ...base, id: "activity-project", actorType: "agent", actorId: "agent-codex", action: "project.updated", entityType: "project", entityId: project.id },
  { ...base, id: "activity-approval", action: "approval.revision_requested", entityType: "approval", entityId: "approval-budget", details: { type: "budget_override_required" } },
  { ...base, id: "activity-run", action: "heartbeat.invoked", entityType: "heartbeat_run", entityId: "run-storybook", details: { agentId: "agent-codex" } },
  { ...base, id: "activity-system", actorType: "system", actorId: "system", action: "company.updated", entityType: "company", entityId: "company-storybook", details: null },
];

const names = new Map([
  [`issue:${recoveryChild.id}`, recoveryChild.identifier!],
  ["agent:agent-codex", "CodexCoder"],
  [`project:${project.id}`, project.name],
  ["approval:approval-budget", "Monthly budget adjustment"],
  ["company:company-storybook", "Paperclip Storybook"],
]);
const titles = new Map([[`issue:${recoveryChild.id}`, recoveryChild.title]]);
const profiles = new Map([["board", { label: "Riley Board", image: null }]]);

export function ActivityListPreview({ density = "comfortable", containerWidth = "standard", withReferences = false, onDensityChange, onWidthChange }: ActivityListPreviewProps) {
  const client = useQueryClient();
  useLayoutEffect(() => {
    for (const ref of [recoveryChild.id, recoveryChild.identifier!]) client.setQueryData(queryKeys.issues.detail(ref), recoveryChild);
  }, [client]);
  const items = withReferences ? [{ ...events[0]!, details: { addedReferencedIssues: [{ id: recoveryChild.id, identifier: recoveryChild.identifier, title: recoveryChild.title }], removedReferencedIssues: [{ id: "old-task", identifier: "PAP-400", title: "Superseded connector plan" }] } }, ...events.slice(1)] : events;
  const widthClass = { standard: "w-full", narrow: "w-96", smallest: "w-64" }[containerWidth];
  return <FlyoutAppearanceProvider>
    <main className="task-row-design-preview min-h-screen px-6 py-10 text-foreground sm:px-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="space-y-3">
          <p className="text-xs text-muted-foreground">Paperclip · Design system · Proposed</p>
          <h1 className="text-3xl font-semibold">Activity list</h1>
          <p className="text-sm text-muted-foreground">Task, agent, project, approval, run and system activity. Rows share task-list density, type, fade and cell-local marquee. Task entries retain their hover card; other entries keep their own destination.</p>
        </header>
        <div className="flex flex-wrap gap-6">
          <div role="group" aria-label="Row density" className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Row density</span>
            {(["comfortable", "compact"] as const).map(value => <Button key={value} size="sm" variant={density === value ? "secondary" : "outline"} aria-pressed={density === value} onClick={() => onDensityChange?.(value)}>{value === "comfortable" ? "Comfortable (44px)" : "Compact (32px)"}</Button>)}
          </div>
          <div role="group" aria-label="Container width" className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Container width</span>
            {(["standard", "narrow", "smallest"] as const).map(value => <Button key={value} size="sm" variant={containerWidth === value ? "secondary" : "outline"} aria-pressed={containerWidth === value} onClick={() => onWidthChange?.(value)}>{value === "standard" ? "Standard" : value === "narrow" ? "Narrow" : "Smallest"}</Button>)}
          </div>
        </div>
        <Card className={`block max-w-full overflow-hidden py-0 ${widthClass}`}>
          <ActivityList events={items} density={density} agentMap={storybookAgentMap} userProfileMap={profiles} entityNameMap={names} entityTitleMap={titles} />
        </Card>
        {withReferences ? <p className="text-xs text-muted-foreground">Reference changes remain below the fixed-height row. Their links keep their existing navigation and accessible labels.</p> : null}
      </div>
    </main>
  </FlyoutAppearanceProvider>;
}
