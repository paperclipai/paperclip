// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, IssueRecoveryAction } from "@paperclipai/shared";
import { IssueRecoveryActionCard, deriveRecoveryCardState } from "./IssueRecoveryActionCard";
import { i18n } from "@/i18n";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

const visibility = vi.hoisted(() => ({ visible: true, loaded: true }));
vi.mock("@/hooks/useWorkspaceIsolationControls", () => ({ useWorkspaceIsolationControls: () => visibility }));
beforeEach(() => { visibility.visible = true; visibility.loaded = true; });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  const maybePromise = result as unknown as PromiseLike<unknown>;
  if (result && typeof maybePromise.then === "function") {
    throw new TypeError("This test act shim only supports synchronous callbacks.");
  }
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const ownerAgent: Agent = {
  id: "11111111-1111-1111-1111-111111111111",
  companyId: "company-1",
  name: "ClaudeCoder",
  role: "engineer",
  status: "idle",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  permissions: {},
  urlKey: "claudecoder",
} as unknown as Agent;

const returnAgent: Agent = {
  ...ownerAgent,
  id: "22222222-2222-2222-2222-222222222222",
  name: "CodexCoder",
  urlKey: "codexcoder",
} as Agent;

function buildAction(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    companyId: "company-1",
    sourceIssueId: "00000000-0000-0000-0000-0000000000ff",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: ownerAgent.id,
    ownerUserId: null,
    previousOwnerAgentId: returnAgent.id,
    returnOwnerAgentId: returnAgent.id,
    cause: "missing_disposition",
    fingerprint: "fp",
    evidence: {
      summary: "Run finished but no disposition was chosen.",
      sourceRunId: "7accd7a4-c9ca-4db2-9233-3228a037cc09",
    },
    nextAction: "Choose and record a valid issue disposition.",
    wakePolicy: { type: "wake_owner" },
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: null,
    lastAttemptAt: "2026-05-09T19:30:00.000Z",
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-05-09T19:30:00.000Z",
    updatedAt: "2026-05-09T19:30:00.000Z",
    ...overrides,
  };
}


it.each([0, 1, 2])("close-boundary localizes RunChip and preserves maxAttempts %s", async max => {
  const { act: reactAct } = await import("react");
  await i18n.changeLanguage("en");
  const action = buildAction({ attemptCount: 2, maxAttempts: max }); const before = JSON.stringify(action); const retry = vi.fn();
  const node = render(<IssueRecoveryActionCard action={action} onResolve={retry} />);
  expect(node.textContent).toContain(`attempt 2 of ${max}`);
  const chip = [...node.querySelectorAll("code")].find(n => n.textContent?.startsWith("run "))!;
  expect(chip).toBeTruthy(); const en = chip.textContent!; const anchor = chip.closest("a"); const href = anchor?.getAttribute("href");
  await reactAct(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(chip.textContent).toBe(en.replace(/^run /, "运行 ")); expect(anchor?.getAttribute("href")).toBe(href);
  expect(node.textContent).toContain(String(max)); expect(retry).not.toHaveBeenCalled(); expect(JSON.stringify(action)).toBe(before);
  await reactAct(async () => { await i18n.changeLanguage("en"); }); expect(chip.textContent).toBe(en);
});
