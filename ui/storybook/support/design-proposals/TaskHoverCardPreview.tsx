import { useLayoutEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ActivityRow } from "@/components/ActivityRow";
import { IssueQuicklookCard } from "@/components/IssueLinkQuicklook";
import { TaskSummaryList } from "@/components/TaskSummaryList";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FlyoutAppearanceProvider } from "@/components/ui/flyout";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { createIssue, storybookActivityEvents, storybookAgentMap, storybookProjects } from "../../fixtures/paperclipData";

const task = createIssue({
  id: "design-task-hover-card", identifier: "PAP-173", status: "done",
  title: "Artifact Review: Finish the remaining approved wireframe gaps",
  description: "Followup on PAP-717 (wireframes approved Oct 13, card f47824d1). Same worktree/branch as PAP-717; build on commits 11410df47 through 61c81e105. Review the remaining wireframe gaps with the team.",
  project: { ...storybookProjects[0]!, name: "Design system" },
  updatedAt: new Date("2026-10-14T17:00:00Z"),
});

export function TaskHoverCardPreview({ enabled = true, showDescription = true, onEnabledChange }: {
  enabled?: boolean;
  showDescription?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
}) {
  const client = useQueryClient();
  const issue = { ...task, description: showDescription ? task.description : null };
  useLayoutEffect(() => {
    const snapshot = { ...task, description: showDescription ? task.description : null };
    for (const ref of [task.id, task.identifier!]) client.setQueryData(queryKeys.issues.detail(ref), snapshot);
  }, [client, showDescription]);
  return <FlyoutAppearanceProvider>
    <main className="task-row-design-preview min-h-screen px-6 py-10 text-foreground sm:px-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="space-y-3">
          <p className="text-xs text-muted-foreground">Paperclip · Design system · Proposed</p>
          <h1 className="text-3xl font-semibold">Task hover card</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">A contextual task preview for links and activity. Summary rows use their own local text reveal and keep this preview off.</p>
        </header>
        <section className="space-y-4" aria-label="Card appearance">
          <h2 className="text-sm font-normal">Appearance</h2>
          <div data-testid="task-hover-card-reference" data-quicklook data-flyout-appearance="refreshed">
            <IssueQuicklookCard issue={issue} linkTo="/PAP/issues/PAP-173" />
          </div>
        </section>
        <section className="space-y-4" aria-label="Optional hover preview">
          <div className="flex flex-wrap items-center gap-4">
            <h2 className="text-sm font-normal">Text link</h2>
            <Button size="sm" variant="outline" aria-pressed={enabled} onClick={() => onEnabledChange?.(!enabled)}>Hover preview: {enabled ? "On" : "Off"}</Button>
          </div>
          <p className="text-sm">Related work: <Link to="/issues/PAP-173" issuePrefetch={issue} disableIssueQuicklook={!enabled} className="underline" aria-label="Preview linked task PAP-173">PAP-173</Link></p>
        </section>
        <section className="space-y-4" aria-label="Activity preview example">
          <h2 className="text-sm font-normal">Recent activity · Preview on</h2>
          <Card className="block overflow-hidden py-0">
            <ActivityRow appearance="refreshed" event={{ ...storybookActivityEvents[0]!, entityId: task.id }} agentMap={storybookAgentMap} entityNameMap={new Map([[`issue:${task.id}`, task.identifier!]])} entityTitleMap={new Map([[`issue:${task.id}`, task.title]])} />
          </Card>
        </section>
        <section className="space-y-4" aria-label="Summary without hover preview">
          <h2 className="text-sm font-normal">Recent tasks · Preview off</h2>
          <Card className="block overflow-hidden py-0"><TaskSummaryList issues={[issue]} /></Card>
        </section>
      </div>
    </main>
  </FlyoutAppearanceProvider>;
}
