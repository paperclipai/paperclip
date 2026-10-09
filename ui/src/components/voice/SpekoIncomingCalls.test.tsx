// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SpekoIncomingCalls} from "./SpekoIncomingCalls";
const mocks = vi.hoisted(() => ({incoming: vi.fn(), list: vi.fn()}));
vi.mock("@/api/voicePhone", () => ({voicePhoneApi: {incoming: mocks.incoming}}));
vi.mock("@/api/issues", () => ({issuesApi: {list: mocks.list}}));
describe("incoming call task selection", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  const tasks = [{id: "task", status: "todo", identifier: "PAP-42", title: "Ready task"}];
  beforeEach(() => {
    vi.resetAllMocks(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container); client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    mocks.incoming.mockResolvedValue([{id: "call", state: "awaiting_approval", approvalCode: "123456"}]);
  });
  afterEach(async () => {await act(async () => root.unmount()); client.clear(); container.remove();});
  async function render() {await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><SpekoIncomingCalls companyId="company" endpointId="endpoint" agentId="agent" /></QueryClientProvider></MemoryRouter>));}
  it("shows task request failures and lets callers retry the existing task inventory", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(tasks); await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Task list could not be loaded"));
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry tasks")!;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(container.querySelector('option[value="task"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("preserves previously loaded tasks when a background task request fails", async () => {
    mocks.list.mockResolvedValue(tasks); await render();
    await vi.waitFor(() => expect(container.querySelector('option[value="task"]')).not.toBeNull());
    mocks.list.mockRejectedValue(new Error("Offline"));
    await act(async () => {await client.refetchQueries({queryKey: ["speko-approval-tasks", "company", "agent"]});});
    await vi.waitFor(() => expect(container.textContent).toContain("Task list could not be loaded"));
    expect(container.querySelector('option[value="task"]')).not.toBeNull();
  });
});
