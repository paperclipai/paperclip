// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuiltInBundlePanel } from "./BuiltInBundlePanel";
import type {
  BuiltInAgentState,
  BuiltInManagedResourceState,
  BuiltInManagedResourceStockStatus,
} from "@/api/builtInAgents";

// The panel links to agent tabs via `@/lib/router` (company-prefixed Link).
// Stub it to a plain anchor so the panel test doesn't need CompanyContext.
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

function resource(
  resourceKind: BuiltInManagedResourceState["resourceKind"],
  stockStatus: BuiltInManagedResourceStockStatus,
  overrides: Partial<BuiltInManagedResourceState> = {},
): BuiltInManagedResourceState {
  return {
    resourceKind,
    resourceKey: resourceKind === "skill" ? "reflection-coach" : resourceKind === "routine" ? "recent-agent-reflection" : "AGENTS.md",
    resourceId: "res-1",
    stockVersion: "2026-07-08",
    stockHash: "aaaa",
    currentHash: stockStatus === "missing" ? null : stockStatus === "stock_current" ? "aaaa" : "bbbb",
    stockStatus,
    updateAvailable: stockStatus === "stock_update_available" || stockStatus === "operator_modified",
    resetAvailable: stockStatus !== "stock_current",
    ...overrides,
  };
}

function makeState(
  status: BuiltInAgentState["status"],
  resources: BuiltInManagedResourceState[],
): BuiltInAgentState {
  return {
    definition: {
      key: "reflection-coach",
      displayName: "Reflection Coach",
      featureKeys: ["reflection"],
      shortPurpose: "Coaches recent agents.",
      defaultInstructions: "…",
      defaultRole: "general",
      allowedAdapterTypes: ["codex_local"],
      defaultBudgetMonthlyCents: 0,
      bundle: {
        stockVersion: "2026-07-08",
        instructions: { entryFile: "AGENTS.md", files: ["AGENTS.md"] },
        skill: {
          skillKey: "reflection-coach",
          displayName: "reflection-coach",
          slug: "reflection-coach",
          canonicalKey: "paperclipai/bundled/paperclip-operations/reflection-coach",
          files: ["reflection-coach/SKILL.md"],
        },
        routine: {
          routineKey: "recent-agent-reflection",
          title: "Recent agent reflection",
          status: "paused",
          triggerCount: 1,
          scheduleLabel: "Weekly · Mon 09:00 UTC",
        },
      },
    },
    status,
    agentId: "agent-1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: { id: "agent-1", pausedAt: status === "paused" ? new Date().toISOString() : null } as any,
    pauseReason: null,
    resources,
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

const READY_RESOURCES = [
  resource("skill", "stock_current"),
  resource("instructions", "stock_current"),
  resource("routine", "stock_current"),
];

describe("BuiltInBundlePanel (PAP-13099)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function render(state: BuiltInAgentState, handlers: Partial<{
    onConfigure: () => void;
    onResetResource: (kind: BuiltInManagedResourceState["resourceKind"]) => void;
    onRunRoutine: (routineKey: string) => void;
    onEnableSchedule: (routineKey: string) => void;
    onDisableSchedule: (routineKey: string) => void;
  }> = {}) {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <BuiltInBundlePanel
          state={state}
          agentRef="reflectioncoach"
          onConfigure={handlers.onConfigure ?? (() => {})}
          onResetResource={handlers.onResetResource ?? (() => {})}
          onRunRoutine={handlers.onRunRoutine ?? (() => {})}
          onEnableSchedule={handlers.onEnableSchedule ?? (() => {})}
          onDisableSchedule={handlers.onDisableSchedule ?? (() => {})}
        />,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    // Radix portals dialog content onto body; clear leftovers between tests.
    document.body.querySelectorAll("[data-slot='alert-dialog-portal']").forEach((node) => node.remove());
  });

  it("renders four resource rows with ready + schedule-off chips when healthy", () => {
    render(makeState("ready", READY_RESOURCES));
    const text = container.textContent ?? "";
    expect(text).toContain("Bundle status");
    expect(text).toContain("Adapter");
    expect(text).toContain("Skill");
    expect(text).toContain("Instructions");
    expect(text).toContain("Routine");
    // Zero-token guarantee copy is always present on the routine row.
    expect(text).toContain("costs zero tokens by default");
    expect(text).toContain("Schedule off");
    expect(text).toContain("Ready");
    expect(text).toContain("Run once");
    expect(text).toContain("Enable weekly");
  });

  it("shows the active weekly schedule and disable action when enabled", () => {
    render(makeState("ready", [
      resource("skill", "stock_current"),
      resource("instructions", "stock_current"),
      resource("routine", "stock_current", { scheduleEnabled: true }),
    ]));
    const text = container.textContent ?? "";
    expect(text).toContain("Weekly · Mon 09:00 UTC");
    expect(text).toContain("can create background work");
    expect(text).toContain("Disable schedule");
    expect(text).not.toContain("Enable weekly");
  });

  it("links to a pending proposal interaction when the routine resource reports one", () => {
    render(makeState("ready", [
      resource("skill", "stock_current"),
      resource("instructions", "stock_current"),
      resource("routine", "stock_current", {
        pendingUpdateInteractionId: "interaction-1",
        pendingUpdateIssueId: "issue-1",
        pendingUpdateIssueIdentifier: "PAP-42",
      }),
    ]));
    const link = Array.from(container.querySelectorAll("a")).find((anchor) => anchor.textContent === "Review proposal");
    expect(container.textContent).toContain("Proposal pending");
    expect(link?.getAttribute("href")).toBe("/issues/PAP-42#interaction-interaction-1");
  });

  it("shows Needs setup for the adapter when the agent is not configured yet", () => {
    render(makeState("needs_setup", READY_RESOURCES));
    const text = container.textContent ?? "";
    expect(text).toContain("Needs setup");
    expect(text).toContain("Pick an adapter this coach can run on");
  });

  it("surfaces an update-available chip and Update action for unedited stock drift", () => {
    render(makeState("ready", [
      resource("skill", "stock_current"),
      resource("instructions", "stock_update_available"),
      resource("routine", "stock_current"),
    ]));
    const text = container.textContent ?? "";
    expect(text).toContain("Update available");
    expect(text).toContain("Paperclip shipped a newer default");
    // The per-resource Update trigger button is present.
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toContain("Update");
  });

  it("surfaces a Drifted chip and Reset action for operator-modified resources", () => {
    render(makeState("ready", [
      resource("skill", "operator_modified"),
      resource("instructions", "stock_current"),
      resource("routine", "stock_current"),
    ]));
    const text = container.textContent ?? "";
    expect(text).toContain("Drifted");
    expect(text).toContain("Your changes are kept");
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toContain("Reset");
  });

  it("shows a Missing chip when a resource is not materialized", () => {
    render(makeState("ready", [
      resource("skill", "missing"),
      resource("instructions", "stock_current"),
      resource("routine", "stock_current"),
    ]));
    expect(container.textContent).toContain("Missing");
  });

  it("fires onConfigure when the adapter Configure button is clicked", () => {
    const onConfigure = vi.fn();
    render(makeState("needs_setup", READY_RESOURCES), { onConfigure });
    const configureBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Configure",
    );
    expect(configureBtn).toBeTruthy();
    flushSync(() => configureBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for a built-in without a bundle", () => {
    const flat = makeState("ready", READY_RESOURCES);
    delete flat.definition.bundle;
    render(flat);
    expect(container.textContent).toBe("");
  });
});
