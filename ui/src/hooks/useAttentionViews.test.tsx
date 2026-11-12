// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { useAttentionCloseActions, useClaimAttentionItem, type AttentionWithdrawAllResult } from "./useAttentionViews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  close: vi.fn(),
  claim: vi.fn(),
  transfer: vi.fn(),
  pushToast: vi.fn(),
}));
vi.mock("@/api/attention", () => ({ attentionApi: { close: fixture.close, claim: fixture.claim, transfer: fixture.transfer } }));
vi.mock("@/api/inboxDismissals", () => ({ inboxDismissalsApi: { restore: vi.fn() } }));
vi.mock("@/context/ToastContext", () => ({ useOptionalToastActions: () => ({ pushToast: fixture.pushToast }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ userId: "scott" }) }));

const item = (id: string) => ({ id, sourceKind: "issue_thread_interaction", subject: { id, title: id }, dismissalKey: `attention:${id}` }) as unknown as AttentionItem;
const alreadyClosed = Object.assign(new Error("Already answered"), {
  status: 409,
  body: { error: "Already answered", details: { code: "attention_already_closed", resolvedByUserId: "dotta", resolvedByAgentId: null } },
});

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let actions: ReturnType<typeof useAttentionCloseActions> | null = null;
let claim: ReturnType<typeof useClaimAttentionItem> | null = null;
const onClosed = vi.fn();
function Harness() {
  actions = useAttentionCloseActions("company", { userLabelMap: new Map([["dotta", "Dotta"]]), onClosed });
  claim = useClaimAttentionItem("company");
  return null;
}
beforeEach(async () => {
  fixture.close.mockReset();
  fixture.claim.mockReset();
  fixture.transfer.mockReset();
  fixture.pushToast.mockReset();
  onClosed.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useAttentionCloseActions (PAP-749 task 2c)", () => {
  it("withdraws each confirmed stale card and reports cards someone else closed first", async () => {
    fixture.close
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(alreadyClosed)
      .mockRejectedValueOnce(new Error("boom"));
    let result: AttentionWithdrawAllResult | null = null;
    await act(async () => { result = await actions!.withdrawAll([item("a"), item("b"), item("c")], " Out of date "); });
    expect(fixture.close.mock.calls).toEqual([
      ["company", "issue_thread_interaction", "a", { mode: "withdraw", reason: "Out of date" }],
      ["company", "issue_thread_interaction", "b", { mode: "withdraw", reason: "Out of date" }],
      ["company", "issue_thread_interaction", "c", { mode: "withdraw", reason: "Out of date" }],
    ]);
    expect(result!.withdrawn.map((entry) => entry.id)).toEqual(["a"]);
    expect(result!.alreadyClosed.map((entry) => entry.id)).toEqual(["b"]);
    expect(result!.failed.map((entry) => entry.id)).toEqual(["c"]);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(fixture.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Withdrew 1 stale request",
      body: "1 already answered by someone else. 1 could not be withdrawn.",
      tone: "error",
    }));
  });

  it('says "Already answered by @x" when a single close loses the race', async () => {
    fixture.close.mockRejectedValueOnce(alreadyClosed);
    await act(async () => { actions!.close({ item: item("a"), mode: "withdraw", reason: "" }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not withdraw this request",
      body: "Already answered by @Dotta",
    }));
    expect(onClosed).not.toHaveBeenCalled();
  });
});

describe("claim and transfer refresh every view of the card (PAP-771)", () => {
  // Task detail caches interactions under its identifier; the card resolver uses the UUID.
  const interactionCard = {
    ...item("interaction-1"),
    subject: { id: "interaction-1", title: "Approve the plan?", metadata: { issueId: "issue-1" } },
    relatedIssue: { id: "issue-1", identifier: "NEE-39" },
  } as unknown as AttentionItem;
  const views = [queryKeys.issues.interactions("issue-1"), queryKeys.issues.interactions("NEE-39"), ["issues", "pending-questions"]];
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  it("claim", async () => {
    fixture.claim.mockResolvedValueOnce({});
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => { claim!.mutate(interactionCard); });
    await settle();
    for (const queryKey of views) expect(invalidate).toHaveBeenCalledWith({ queryKey });
  });

  it("transfer", async () => {
    fixture.transfer.mockResolvedValueOnce({});
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => { actions!.transfer({ item: interactionCard, userId: "dotta" }); });
    await settle();
    expect(fixture.transfer).toHaveBeenCalledWith("company", "issue_thread_interaction", "interaction-1", { userId: "dotta", reason: undefined });
    for (const queryKey of views) expect(invalidate).toHaveBeenCalledWith({ queryKey });
  });
});
