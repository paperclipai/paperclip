// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate } from "@/lib/router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DecisionOutcome } from "@/api/decisions";
import type { DecisionHistoryItem } from "@paperclipai/shared";
import { CoordinatorDecisionReceipt } from "./coordinator/CoordinatorDecisionReceipt";
import { TaskDecisionRecord } from "./TaskDecisionRecord";

const mocks = vi.hoisted(() => ({ get: vi.fn(), resolver: vi.fn() }));
vi.mock("@/api/decisions", () => ({ decisionsApi: { get: mocks.get } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { issuePrefix: "ORG" } }) }));
vi.mock("./DecisionResolver", () => ({ DecisionResolver: (props: { recordedDecision?: DecisionOutcome }) => {
  mocks.resolver(props);
  return <p>{props.recordedDecision?.executions[0]?.result?.summary as string}</p>;
} }));
const decision = {
  id: "decision-1", companyId: "company", originIssueId: "task-1", status: "decided",
  title: "Choose launch channels", body: "Start with the blog", chosenOptionId: "blog",
  options: [{ id: "blog", label: "Own blog first", effects: [] }],
  inputs: [{ id: "reason", label: "Reason" }], inputValues: { reason: "The draft is ready" },
  executions: [{ id: "effect-1", result: { summary: "Blog draft queued" } }],
} as unknown as DecisionOutcome;
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); mocks.get.mockResolvedValue(decision);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
async function mount(hash: string, viewerId = "person") {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/ORG/issues/ORG-1${hash}`]}>
    <TaskDecisionRecord companyId="company" issueId="task-1" viewerId={viewerId} />
  </MemoryRouter></QueryClientProvider>));
}
it("opens a compact receipt in its task's named full record with recorded inputs and results", async () => {
  function Journey() {
    const navigate = useNavigate();
    return <><CoordinatorDecisionReceipt item={{ href: "/ORG/issues/ORG-1#decision-decision-1", label: "Own blog first" } as DecisionHistoryItem} onOpen={navigate} />
      <TaskDecisionRecord companyId="company" issueId="task-1" viewerId="person" /></>;
  }
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/ORG/decisions"]}><Journey /></MemoryRouter></QueryClientProvider>));
  expect(mocks.get).not.toHaveBeenCalled();
  await act(async () => host.querySelector("button")!.click());
  await vi.waitFor(() => expect(host.querySelector("#decision-decision-1")?.textContent).toContain("Blog draft queued"));
  expect(host.textContent).toContain("Own blog first");
  expect(host.textContent).toContain("The draft is ready");
  expect(mocks.get).toHaveBeenCalledWith("decision-1");
  expect(mocks.resolver).toHaveBeenLastCalledWith(expect.objectContaining({ recordedDecision: decision }));
});
it.each([{ companyId: "other" }, { originIssueId: "another-task" }])("does not display a decision for a mismatched context %j", async (override) => {
  mocks.get.mockResolvedValue({ ...decision, ...override });
  await mount("#decision-decision-1");
  await vi.waitFor(() => expect(host.textContent).toContain("not available in this task"));
  expect(mocks.resolver).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("The draft is ready");
});
it("does not expose cached record text after a viewer change loses access", async () => {
  await mount("#decision-decision-1");
  await vi.waitFor(() => expect(host.textContent).toContain("The draft is ready"));
  mocks.get.mockRejectedValue(new Error("Forbidden"));
  await mount("#decision-decision-1", "another-person");
  await vi.waitFor(() => expect(host.textContent).toContain("Could not load this decision"));
  expect(host.textContent).not.toContain("The draft is ready");
});
it("refreshes the mounted record after company decision events invalidate its results", async () => {
  mocks.get.mockResolvedValue({ ...decision, executions: [] });
  await mount("#decision-decision-1");
  await vi.waitFor(() => expect(host.textContent).toContain("The draft is ready"));
  expect(host.textContent).not.toContain("Blog draft queued");
  mocks.get.mockResolvedValue(decision);
  await act(async () => { await client.invalidateQueries({ queryKey: ["decisions", "company"] }); });
  await vi.waitFor(() => expect(host.textContent).toContain("Blog draft queued"));
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(mocks.resolver).toHaveBeenLastCalledWith(expect.objectContaining({ recordedDecision: decision }));
});
