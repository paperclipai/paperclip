// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";

const api = vi.hoisted(() => ({ confirmRunStopped: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: { confirmRunStopped: api.confirmRunStopped } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = "Paperclip can't confirm that the previous run stopped. If no agent is still working on this task, a board operator can confirm that it stopped, and your Retry starts right away. Your message is saved.";
const presentation: TaskInterruptionPresentation = { intentId: "intent", responsibility: "user", state: "waiting_for_user",
  nextRetryAt: null, canRetry: false, userAction: "confirm_run_stopped", sourceRunIds: ["run-1"], observedRunId: "run-1",
  retryWait: { reason: "process_identity_missing", message } };

describe("confirming that an unidentified previous run stopped", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
      companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }] });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });

  async function mount(value: TaskInterruptionPresentation = presentation, issueId = "issue-1") {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice presentation={value} canRetry onRetry={() => undefined} issueId={issueId} companyId="company-1" />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(candidate => candidate.textContent === label);
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }

  it("explains the wait and confirms the stop instead of offering a Retry that cannot start (storage chaos ST1)", async () => {
    api.confirmRunStopped.mockResolvedValue({ runId: "run-1", alreadyStopped: false, presentation: null });
    await mount();
    expect(container.textContent).toContain("a board operator can confirm");
    expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent === "Retry")).toBe(false);
    await click("Confirm it stopped");
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "No codex process for this task is running on the server host.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Confirm and resume");
    expect(api.confirmRunStopped).toHaveBeenCalledExactlyOnceWith("issue-1", { runId: "run-1",
      stopEvidence: "No codex process for this task is running on the server host." });
    expect(container.textContent).toContain("Starting your Retry");
  });

  it("starts a fresh confirmation when the page moves to another task's run", async () => {
    await mount();
    await click("Confirm it stopped");
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Evidence written for the first task's run only.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await mount({ ...presentation, sourceRunIds: ["run-2"], observedRunId: "run-2" }, "issue-2");
    expect(container.querySelector("textarea")).toBeNull();
    await click("Confirm it stopped");
    expect(container.querySelector("textarea")!.value).toBe("");
  });

  it("does not offer the confirmation to someone who cannot confirm a stop", async () => {
    client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
      companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }] });
    await mount();
    expect(container.textContent).toContain("a board operator can confirm");
    expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent === "Confirm it stopped")).toBe(false);
  });
});
