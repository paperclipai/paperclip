import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ManagedRoutinesList } from "./ManagedRoutinesList";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string;
  }) => <a href={to} className={className} {...props}>{children}</a>,
}));

describe("ManagedRoutinesList", () => {
  it("does not show raw null status text or repair controls for healthy routines", () => {
    const markup = renderToStaticMarkup(
      <ManagedRoutinesList
        routines={[{
          key: "briefs-discover-cards",
          title: "Discover Briefing cards",
          status: "paused",
          routineId: "routine-1",
          resourceKey: "briefs-discover-cards",
          projectId: "project-1",
          assigneeAgentId: "agent-1",
          lastRunAt: "2026-05-22T16:23:41.000Z",
          lastRunStatus: null,
        }]}
        agents={[{ id: "agent-1", name: "Briefing Analyst" }]}
        projects={[{ id: "project-1", name: "Briefs", color: "#0891b2" }]}
        onRunNow={() => undefined}
        onToggleEnabled={() => undefined}
        onReconcile={() => undefined}
      />,
    );

    expect(markup).toContain("Discover Briefing cards");
    expect(markup).not.toContain("null");
    expect(markup).not.toContain("Routine defaults");
    expect(markup).not.toContain("Reconcile");
  });

  it("shows default-drift repair controls only when defaults changed", () => {
    const markup = renderToStaticMarkup(
      <ManagedRoutinesList
        routines={[{
          key: "briefs-discover-cards",
          title: "Discover Briefing cards",
          status: "paused",
          routineId: "routine-1",
          resourceKey: "briefs-discover-cards",
          defaultDrift: { changedFields: ["description"] },
        }]}
        onReset={() => undefined}
      />,
    );

    expect(markup).toContain("Routine defaults changed: description");
    expect(markup).toContain("Reset");
  });
});
