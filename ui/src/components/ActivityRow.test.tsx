// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { ActivityRow } from "./ActivityRow";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createEvent(action: string): ActivityEvent {
  return {
    id: `activity-${action}`,
    companyId: "company-1",
    actorType: "user",
    actorId: "board-user",
    agentId: null,
    runId: null,
    action,
    entityType: "project",
    entityId: "project-1",
    details: null,
    createdAt: new Date("2026-04-13T12:00:00.000Z"),
  };
}

describe("ActivityRow", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders project pause and resume verbs", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <>
          <ActivityRow
            event={createEvent("project.paused")}
            agentMap={new Map()}
            entityNameMap={new Map([["project:project-1", "Alpha"]])}
          />
          <ActivityRow
            event={createEvent("project.resumed")}
            agentMap={new Map()}
            entityNameMap={new Map([["project:project-1", "Alpha"]])}
          />
        </>,
      );
    });

    expect(container.textContent).toContain("paused Alpha");
    expect(container.textContent).toContain("resumed Alpha");

    act(() => {
      root.unmount();
    });
  });
});
