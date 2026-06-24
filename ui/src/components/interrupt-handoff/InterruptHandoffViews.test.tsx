// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssigneeChip,
  AssigneeRunningBanner,
  ComposerHandoffPreviewRow,
  ComposerMentionCoach,
  HandoffWakeRow,
  InterruptAssignConfirm,
  PauseAffectsSummaryView,
  RunStatusBadge,
  type HandoffChipResolvers,
} from "./InterruptHandoffViews";
import {
  computeComposerHandoffPreview,
  computePauseAffectsSummary,
  describeReassignInterrupt,
} from "../../lib/interrupt-handoff";

const resolvers: HandoffChipResolvers = {
  agentMap: new Map([
    ["agent-qa", { name: "QA", icon: null }],
    ["agent-claude", { name: "ClaudeCoder", icon: null }],
  ]),
  resolveUserLabel: (id) => (id === "user-board" ? "Riley Board" : null),
  currentUserId: "user-board",
};

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let activeRoot: Root | null = null;
let activeHost: HTMLDivElement | null = null;

function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  activeRoot = root;
  activeHost = host;
  return host;
}

afterEach(() => {
  if (activeRoot) {
    const root = activeRoot;
    act(() => root.unmount());
  }
  activeHost?.remove();
  activeRoot = null;
  activeHost = null;
});

describe("AssigneeChip", () => {
  it("renders an agent chip with a screen-reader 'Agent' prefix", () => {
    const host = mount(<AssigneeChip assignee={{ agentId: "agent-qa", userId: null }} resolvers={resolvers} />);
    const chip = host.querySelector<HTMLElement>("[data-testid='handoff-assignee-chip']")!;
    expect(chip.dataset.kind).toBe("agent");
    expect(chip.textContent).toContain("Agent");
    expect(chip.textContent).toContain("QA");
  });

  it("renders a user chip with '(you)' and a 'User' prefix — never an agent look", () => {
    const host = mount(<AssigneeChip assignee={{ agentId: null, userId: "user-board" }} resolvers={resolvers} />);
    const chip = host.querySelector<HTMLElement>("[data-testid='handoff-assignee-chip']")!;
    expect(chip.dataset.kind).toBe("user");
    expect(chip.textContent).toContain("User");
    expect(chip.textContent).toContain("Riley Board (you)");
  });

  it("renders unassigned as italic text, not a chip", () => {
    const host = mount(<AssigneeChip assignee={{ agentId: null, userId: null }} resolvers={resolvers} />);
    const chip = host.querySelector<HTMLElement>("[data-testid='handoff-assignee-chip']")!;
    expect(chip.dataset.kind).toBe("unassigned");
    expect(chip.textContent).toContain("Unassigned");
  });
});

describe("HandoffWakeRow", () => {
  it("A. agent destination = queued wake", () => {
    const host = mount(
      <HandoffWakeRow to={{ agentId: "agent-qa", userId: null }} resolvers={resolvers} interruptedRunAttached />,
    );
    const row = host.querySelector<HTMLElement>("[data-testid='handoff-wake-row']")!;
    expect(row.dataset.kind).toBe("agent_wake");
    expect(row.textContent).toContain("queued for QA");
    expect(row.textContent).toContain("interrupted run attached");
  });

  it("B. user destination = no wake", () => {
    const host = mount(<HandoffWakeRow to={{ agentId: null, userId: "user-board" }} resolvers={resolvers} />);
    const row = host.querySelector<HTMLElement>("[data-testid='handoff-wake-row']")!;
    expect(row.dataset.kind).toBe("user_handoff");
    expect(row.textContent).toContain("not created");
  });

  it("C. unassigned = no agent selected", () => {
    const host = mount(<HandoffWakeRow to={{ agentId: null, userId: null }} resolvers={resolvers} />);
    const row = host.querySelector<HTMLElement>("[data-testid='handoff-wake-row']")!;
    expect(row.dataset.kind).toBe("unassigned");
    expect(row.textContent).toContain("no agent selected");
  });
});

describe("RunStatusBadge", () => {
  it("shows amber 'interrupted' for an operator interrupt", () => {
    const host = mount(<RunStatusBadge status="cancelled" operatorInterrupted />);
    const badge = host.querySelector<HTMLElement>("[data-testid='run-status-badge']")!;
    expect(badge.textContent).toContain("interrupted");
    expect(badge.className).toContain("amber");
    expect(badge.dataset.interrupted).toBe("true");
  });

  it("shows muted 'cancelled' for a plain cancel", () => {
    const host = mount(<RunStatusBadge status="cancelled" />);
    const badge = host.querySelector<HTMLElement>("[data-testid='run-status-badge']")!;
    expect(badge.textContent).toContain("cancelled");
    expect(badge.className).toContain("muted");
  });
});

describe("ComposerHandoffPreviewRow", () => {
  it("renders the interrupt+handoff intent with an agent chip", () => {
    const preview = computeComposerHandoffPreview({
      reassignTarget: "agent:agent-qa",
      currentAssigneeValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: null,
    });
    const host = mount(<ComposerHandoffPreviewRow preview={preview} resolvers={resolvers} />);
    const row = host.querySelector<HTMLElement>("[data-testid='composer-handoff-preview']")!;
    expect(row.dataset.kind).toBe("interrupt_handoff_agent");
    expect(row.textContent).toContain("Interrupt current run, hand off to");
    expect(row.textContent).toContain("QA");
  });

  it("renders the amber plain-text warning with no chip", () => {
    const preview = computeComposerHandoffPreview({
      reassignTarget: "agent:agent-claude",
      currentAssigneeValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: { agentId: "agent-qa", matchedText: "QA" },
    });
    const host = mount(<ComposerHandoffPreviewRow preview={preview} resolvers={resolvers} />);
    const row = host.querySelector<HTMLElement>("[data-testid='composer-handoff-preview']")!;
    expect(row.dataset.kind).toBe("plain_text_only");
    expect(row.className).toContain("amber");
    expect(host.querySelector("[data-testid='handoff-assignee-chip']")).toBeNull();
  });

  it("renders nothing for the 'none' state", () => {
    const preview = computeComposerHandoffPreview({
      reassignTarget: "agent:agent-claude",
      currentAssigneeValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: null,
    });
    const host = mount(<ComposerHandoffPreviewRow preview={preview} resolvers={resolvers} />);
    expect(host.querySelector("[data-testid='composer-handoff-preview']")).toBeNull();
  });
});

describe("ComposerMentionCoach", () => {
  it("offers an Insert mention action and is dismissible", () => {
    const onInsert = vi.fn();
    const onDismiss = vi.fn();
    const host = mount(
      <ComposerMentionCoach
        candidate={{ agentId: "agent-qa", matchedText: "QA" }}
        agentDisplayName="QA"
        onInsert={onInsert}
        onDismiss={onDismiss}
      />,
    );
    const insertBtn = host.querySelector<HTMLButtonElement>("[aria-label^='Insert mention for QA']")!;
    act(() => insertBtn.click());
    expect(onInsert).toHaveBeenCalledOnce();
    const dismissBtn = host.querySelector<HTMLButtonElement>("[aria-label='Dismiss suggestion']")!;
    act(() => dismissBtn.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("AssigneeRunningBanner", () => {
  it("announces the interrupt as a status with the running agent name", () => {
    const host = mount(
      <AssigneeRunningBanner copy={describeReassignInterrupt({ runningAgentName: "ClaudeCoder" })} />,
    );
    const banner = host.querySelector<HTMLElement>("[data-testid='assignee-running-banner']")!;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("ClaudeCoder is running");
  });
});

describe("InterruptAssignConfirm", () => {
  it("renders the target chip and wires confirm/cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const host = mount(
      <InterruptAssignConfirm
        copy={describeReassignInterrupt({ runningAgentName: "ClaudeCoder" })}
        to={{ agentId: "agent-qa", userId: null }}
        resolvers={resolvers}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(host.querySelector("[data-testid='handoff-assignee-chip']")?.textContent).toContain("QA");
    const confirmBtn = host.querySelector<HTMLButtonElement>("[data-testid='interrupt-assign-confirm-action']")!;
    act(() => confirmBtn.click());
    expect(onConfirm).toHaveBeenCalledOnce();
    const cancelBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Cancel",
    )!;
    act(() => cancelBtn.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("PauseAffectsSummaryView", () => {
  it("renders only non-zero buckets with counts", () => {
    const summary = computePauseAffectsSummary([
      { assigneeAgentId: "a1", assigneeUserId: null, activeRun: { status: "running" } },
      { assigneeAgentId: null, assigneeUserId: "u1", activeRun: null },
    ]);
    const host = mount(<PauseAffectsSummaryView summary={summary} />);
    expect(host.querySelector("[data-bucket='live_runs']")?.textContent).toContain("1");
    expect(host.querySelector("[data-bucket='human_owned']")?.textContent).toContain("1");
    // Empty buckets are hidden.
    expect(host.querySelector("[data-bucket='static']")).toBeNull();
    expect(host.querySelector("[data-testid='pause-nothing-live']")).toBeNull();
  });

  it("shows the 'Nothing live to pause' status when no run is live", () => {
    const summary = computePauseAffectsSummary([
      { assigneeAgentId: null, assigneeUserId: "u1", activeRun: null },
    ]);
    const host = mount(<PauseAffectsSummaryView summary={summary} />);
    const note = host.querySelector<HTMLElement>("[data-testid='pause-nothing-live']")!;
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("Nothing live to pause");
  });
});
