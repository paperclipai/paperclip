// @vitest-environment jsdom

import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectWorkforceOverview, type WorkforceOverviewSnapshot } from "@paperclipai/shared/workforce-overview";
import { WorkforceOverviewBody } from "./WorkforceOverview";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

const NOW = "2026-09-29T09:40:00.000Z";

function vulcanOverview() {
  const snapshot: WorkforceOverviewSnapshot = {
    companyId: "company-1",
    now: NOW,
    truncated: false,
    initiativeQuery: null,
    agents: [
      {
        id: "vulcan",
        name: "Vulcan",
        role: "engineer",
        title: "Engineer",
        status: "paused",
        reportsTo: null,
        adapterType: "cursor",
        model: "grok-4.7",
        environmentId: null,
        host: "vulcan-host",
        pauseReason: "manual",
        pausedAt: NOW,
        errorReason: null,
        lastHeartbeatAt: NOW,
      },
    ],
    projects: [],
    issues: [
      {
        id: "issue-1",
        identifier: "TYR-10",
        title: "Keep shipping",
        status: "in_progress",
        projectId: null,
        parentId: null,
        assigneeAgentId: "vulcan",
        assigneeUserId: null,
        priority: "high",
        checkoutRunId: null,
        executionRunId: null,
        currentStageType: null,
        lastDecisionOutcome: null,
        executionParticipantUserId: null,
        unblockAction: null,
        unblockOwnerUserId: null,
        unblockOwnerBoard: false,
        completedAt: null,
        updatedAt: NOW,
        monitorNextCheckAt: null,
        labelNames: [],
      },
    ],
    blockerEdges: [],
    approvals: [],
    runs: [
      {
        id: "run-1",
        agentId: "vulcan",
        issueId: "issue-1",
        status: "running",
        error: null,
        errorCode: null,
        livenessReason: null,
        nextAction: null,
        scheduledRetryReason: null,
        startedAt: NOW,
        finishedAt: null,
        updatedAt: NOW,
        createdAt: NOW,
      },
    ],
    activity: [],
    workProducts: [],
    members: [],
    environments: [],
  };
  return projectWorkforceOverview(snapshot);
}

describe("WorkforceOverviewBody", () => {
  let container: HTMLDivElement;

  afterEach(() => {
    container?.remove();
  });

  it("shows a paused Vulcan as paused and keeps counts when the connection drops", () => {
    const overview = vulcanOverview();
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <WorkforceOverviewBody
          overview={overview}
          loading={false}
          connection="disconnected"
          lastSuccessAt={NOW}
          fetchError="The latest refresh failed. Counts below are the last successful snapshot."
          refreshing={false}
          initiative={null}
          onInitiativeChange={() => {}}
          onRefresh={() => {}}
        />,
      );
    });

    const vulcan = container.querySelector('[data-testid="workforce-agent-Vulcan"]');
    expect(vulcan?.textContent).toContain("Paused");
    expect(vulcan?.textContent).not.toContain("Executing");
    expect(container.querySelector('[data-testid="workforce-count-Executing agents"]')?.textContent).toContain("0");
    expect(container.querySelector('[data-testid="workforce-count-Paused"]')?.textContent).toContain("1");
    expect(container.textContent).toContain("last successful snapshot");
    expect(container.querySelector('[data-testid="workforce-connection"]')?.textContent).toBe("Disconnected");

    flushSync(() => {
      root.unmount();
    });
  });

  it("does not render zeros when there is no snapshot", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <WorkforceOverviewBody
          overview={null}
          loading={false}
          connection="disconnected"
          lastSuccessAt={null}
          fetchError={null}
          refreshing={false}
          initiative={null}
          onInitiativeChange={() => {}}
          onRefresh={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("not shown as zero");
    expect(container.textContent).not.toContain("Executing agents");

    flushSync(() => {
      root.unmount();
    });
  });

  it("binds the initiative select to the public identifier of the default initiative", () => {
    const snapshot: WorkforceOverviewSnapshot = {
      companyId: "company-1",
      now: NOW,
      truncated: false,
      initiativeQuery: null,
      agents: [],
      projects: [],
      blockerEdges: [],
      approvals: [],
      runs: [],
      activity: [],
      workProducts: [],
      members: [],
      environments: [],
      issues: [
        {
          id: "init",
          identifier: "TYR-721",
          title: "Live workforce",
          status: "in_progress",
          projectId: null,
          parentId: null,
          assigneeAgentId: null,
          assigneeUserId: null,
          priority: "high",
          checkoutRunId: null,
          executionRunId: null,
          currentStageType: null,
          lastDecisionOutcome: null,
          executionParticipantUserId: null,
          unblockAction: null,
          unblockOwnerUserId: null,
          unblockOwnerBoard: false,
          completedAt: null,
          updatedAt: NOW,
          monitorNextCheckAt: null,
          labelNames: [],
        },
        {
          id: "child",
          identifier: "TYR-722",
          title: "Build the page",
          status: "todo",
          projectId: null,
          parentId: "init",
          assigneeAgentId: null,
          assigneeUserId: null,
          priority: "medium",
          checkoutRunId: null,
          executionRunId: null,
          currentStageType: null,
          lastDecisionOutcome: null,
          executionParticipantUserId: null,
          unblockAction: null,
          unblockOwnerUserId: null,
          unblockOwnerBoard: false,
          completedAt: null,
          updatedAt: NOW,
          monitorNextCheckAt: null,
          labelNames: [],
        },
      ],
    };
    const overview = projectWorkforceOverview(snapshot);
    expect(overview.selectedInitiativeId).toBe("init");

    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <WorkforceOverviewBody
          overview={overview}
          loading={false}
          connection="live"
          lastSuccessAt={NOW}
          fetchError={null}
          refreshing={false}
          initiative={null}
          onInitiativeChange={() => {}}
          onRefresh={() => {}}
        />,
      );
    });

    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("TYR-721");

    flushSync(() => {
      root.render(
        <WorkforceOverviewBody
          overview={overview}
          loading={false}
          connection="live"
          lastSuccessAt={NOW}
          fetchError={null}
          refreshing={false}
          initiative="init"
          onInitiativeChange={() => {}}
          onRefresh={() => {}}
        />,
      );
    });

    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("TYR-721");

    flushSync(() => {
      root.unmount();
    });
  });
});

describe("workforce overview client", () => {
  it("only fetches the overview with GET", () => {
    const api = readFileSync(path.resolve(process.cwd(), "src/api/workforceOverview.ts"), "utf8");
    const page = readFileSync(path.resolve(process.cwd(), "src/pages/WorkforceOverview.tsx"), "utf8");
    expect(api).toMatch(/api\.get/);
    expect(api).not.toMatch(/api\.(post|patch|put|delete)/);
    expect(page).not.toMatch(/agentsApi|issuesApi\.(checkout|update)|heartbeatsApi\.(wakeup|invoke)/);
    expect(page).toMatch(/workforceOverviewApi\.get/);
    expect(page).not.toMatch(/keepPreviousData/);
  });
});
