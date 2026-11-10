// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionBlocker, IssueRecoveryAction } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { ApiError } from "../api/client";
import { i18n } from "../i18n";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";

const api = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn(), access: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: { recoveryActions: api.list, resolveRecoveryAction: api.resolve } }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: api.access } }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The retained legacy incident has no active action and neither continuation nor Retry.
const blocker: ExecutionBlocker = {
  recoveryActionId: "action-1", runId: "run-1", agentId: "agent-1",
  cause: "legacy_execution_requires_reconciliation", runStatus: "cancelled",
  runError: "Execution stopped without a recorded cancellation request: Disposition repair suppressed: existing_execution",
  nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
  canContinue: false, canRetry: false, savedMessageCount: 0,
};
const action = {
  id: "action-1", companyId: "company-1", sourceIssueId: "issue-1", kind: "active_run_watchdog",
  status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: "agent-1",
  cause: blocker.cause, evidence: { runId: "run-1", automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
} as unknown as IssueRecoveryAction;
const access = {
  userId: "board-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false,
  memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
};
const evidence = "The provider log and external records confirm that no actions were performed.";
function receipt(patch: Record<string, unknown> = {}) {
  return { issue: { id: "issue-1", companyId: "company-1", status: "todo" }, recoveryAction: {
    ...action, outcome: "handed_back", evidence: { runId: "run-1", continuationDelivery: "pending",
      executionReconciliation: { runId: "run-1", providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: evidence, actorId: "board-1", recordedAt: "2026-11-08T12:00:00Z" }, ...patch },
  } };
}

describe("stopped-run review through the task interruption surface", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  const retry = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    api.list.mockResolvedValue({ active: null, actions: [action] });
    api.access.mockResolvedValue(access);
    api.resolve.mockResolvedValue(receipt());
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "board-1" } });
    client.setQueryData(queryKeys.access.currentBoardAccess, access);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); client.clear();
    await i18n.changeLanguage("en");
  });
  async function settle() {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  async function mount(value: ExecutionBlocker | null = blocker) {
    const props = { issueId: "issue-1", companyId: "company-1", executionBlocker: value };
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice {...props} presentation={null} canRetry onRetry={retry} />
    </QueryClientProvider>));
    await settle();
  }
  function button(label: string) { return [...container.querySelectorAll("button")].find(b => b.textContent === label); }
  async function click(label: string) {
    const target = button(label); expect(target, `missing ${label}`).toBeDefined();
    await act(async () => target!.click()); await settle();
  }
  async function fill(value: string) {
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function prepare() {
    await mount(); await click("Review stopped run");
    await act(async () => container.querySelector<HTMLInputElement>('input[value="not_performed"]')!.click());
    await fill(evidence);
  }

  it("offers review of the exact settled no-replay run even with active:null", async () => {
    await mount();
    await click("Review stopped run");
    expect(container.textContent).toContain("run-1");
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(button("Retry")).toBeUndefined();
    expect(api.resolve).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("requires an explicit known outcome and substantive evidence before saving", async () => {
    await mount(); await click("Review stopped run");
    expect(button("Save and continue")!.disabled).toBe(true);
    expect(container.querySelector('input[value="unknown"]')).toBeNull();
    await fill(evidence);
    expect(button("Save and continue")!.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="mixed"]')!.click());
    expect(button("Save and continue")!.disabled).toBe(false);
    await fill("                 short                 ");
    expect(button("Save and continue")!.disabled).toBe(true);
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it("submits the structured supported action and preserves the confirmed receipt after refresh", async () => {
    await prepare(); await click("Save and continue");
    expect(api.resolve).toHaveBeenCalledExactlyOnceWith("issue-1", {
      actionId: "action-1", outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId: "run-1", providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: evidence },
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Outcome review saved");
    expect(container.textContent).not.toMatch(/work has started|recovered successfully/i);
    await mount(null);
    expect(container.textContent).toContain("Outcome review saved");
    expect(retry).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong run", "wrong outcome", "wrong evidence", "still blocked", "no delivery"])(
    "does not report success for a 200 response with %s reconciliation evidence", async kind => {
      const result = receipt();
      if (kind === "missing") Object.assign(result.recoveryAction, action);
      if (kind === "wrong run") result.recoveryAction.evidence.executionReconciliation.runId = "run-2";
      if (kind === "wrong outcome") result.recoveryAction.evidence.executionReconciliation.actionOutcome = "mixed";
      if (kind === "wrong evidence") result.recoveryAction.evidence.executionReconciliation.outcomeEvidence = "Another operator's evidence";
      if (kind === "still blocked") Object.assign(result.recoveryAction.evidence, { automaticRecovery: { replay: "blocked" } });
      if (kind === "no delivery") result.recoveryAction.evidence.continuationDelivery = "invalidated";
      api.resolve.mockResolvedValue(result);
      await prepare(); await click("Save and continue");
      expect(container.textContent).not.toContain("Outcome review saved");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
    },
  );

  it.each(["company", "task", "action", "owner"])("rejects a response bound to another %s", async kind => {
    const result = receipt();
    if (kind === "company") result.recoveryAction.companyId = "company-2";
    if (kind === "task") result.issue.id = "issue-2";
    if (kind === "action") result.recoveryAction.id = "action-2";
    if (kind === "owner") result.recoveryAction.returnOwnerAgentId = "agent-2";
    api.resolve.mockResolvedValue(result);
    await prepare(); await click("Save and continue");
    expect(container.textContent).not.toContain("Outcome review saved");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("does not hide a replacement action for the same run behind an earlier receipt", async () => {
    await prepare(); await click("Save and continue");
    await mount({ ...blocker, recoveryActionId: "action-2" });
    expect(container.textContent).not.toContain("Outcome review saved");
    expect(button("Review stopped run")).toBeDefined();
  });

  it.each(["company", "task", "run", "owner", "cause", "replacement", "settled"])(
    "does not submit when a fresh read has a different %s", async kind => {
      await prepare();
      const fresh = { ...action, evidence: { ...action.evidence } };
      if (kind === "company") fresh.companyId = "company-2";
      if (kind === "task") fresh.sourceIssueId = "issue-2";
      if (kind === "run") fresh.evidence.runId = "run-2";
      if (kind === "owner") fresh.returnOwnerAgentId = "agent-2";
      if (kind === "cause") fresh.cause = "uncertain_external_action";
      if (kind === "settled") fresh.evidence = { runId: "run-1" };
      api.list.mockResolvedValue({ active: kind === "replacement" ? { ...fresh, id: "action-2" } : null, actions: [fresh] });
      await click("Save and continue");
      expect(api.resolve).not.toHaveBeenCalled();
      expect(container.textContent).toContain("no longer available for review");
      expect(container.textContent).not.toContain("Outcome review saved");
    },
  );

  it.each(["viewer", "suspended", "foreign company", "other account", "agent"])("hides the board mutation for %s access", async kind => {
    const value = { ...access, memberships: [...access.memberships] };
    if (kind === "viewer") value.memberships = [{ ...access.memberships[0], membershipRole: "viewer" }];
    if (kind === "suspended") value.memberships = [{ ...access.memberships[0], status: "suspended" }];
    if (kind === "foreign company") value.memberships = [{ ...access.memberships[0], companyId: "company-2" }];
    if (kind === "other account") value.userId = "board-2";
    if (kind === "agent") {
      client.removeQueries({ queryKey: queryKeys.access.currentBoardAccess });
      api.access.mockRejectedValue(new ApiError("Board access required", 403, null));
    } else client.setQueryData(queryKeys.access.currentBoardAccess, value);
    await mount();
    expect(button("Review stopped run")).toBeUndefined();
    expect(api.list).not.toHaveBeenCalled();
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it("rechecks board authority before submission", async () => {
    await prepare();
    api.access.mockResolvedValue({ ...access, memberships: [{ ...access.memberships[0], membershipRole: "viewer" }] });
    await click("Save and continue");
    expect(api.resolve).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("board access changed");
  });

  it.each([403, 409, 503])("announces HTTP %s rejection without discarding the evidence or auto-resubmitting", async status => {
    api.resolve.mockRejectedValue(new ApiError("The previous provider is still running.", status, null));
    await prepare(); await click("Save and continue");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("previous provider is still running");
    expect(container.querySelector("textarea")?.value).toBe(evidence);
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Outcome review saved");
  });

  it("blocks duplicate submits while pending", async () => {
    let finish!: (value: unknown) => void;
    api.resolve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await prepare();
    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(button("Checking and saving…")!.disabled).toBe(true);
    expect(container.querySelector("textarea")!.disabled).toBe(true);
    await act(async () => finish(receipt())); await settle();
    expect(container.textContent).toContain("Outcome review saved");
  });

  it.each(["account", "run", "unmounted"])("does not send the old draft after %s changes during the fresh read", async kind => {
    let finish!: (value: unknown) => void;
    await prepare();
    api.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await click("Save and continue");
    if (kind === "account") await act(async () => client.setQueryData(queryKeys.auth.session, { user: { id: "board-2" } }));
    if (kind === "run") await mount({ ...blocker, runId: "run-2" });
    if (kind === "unmounted") await act(async () => root.render(null));
    await act(async () => finish({ active: null, actions: [action] })); await settle();
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it("handles an unavailable retained list without offering a blind submission", async () => {
    api.list.mockResolvedValue({ active: null, actions: [] });
    await mount(); await click("Review stopped run");
    expect(button("Save and continue")).toBeUndefined();
    expect(button("Refresh recovery")).toBeDefined();
    expect(container.textContent).toContain("no longer available for review");
  });

  it("restores keyboard focus and retains the draft when cancelled", async () => {
    await prepare(); await click("Cancel");
    expect(document.activeElement).toBe(button("Review stopped run"));
    await click("Review stopped run");
    expect(container.querySelector("textarea")?.value).toBe(evidence);
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it("uses the English fallback in supported locales without missing-key copy", async () => {
    await i18n.changeLanguage("ar");
    await mount(); await click("Review stopped run");
    expect(container.textContent).toContain("Outcome evidence");
    expect(container.textContent).not.toContain("stoppedRun.");
  });
});
