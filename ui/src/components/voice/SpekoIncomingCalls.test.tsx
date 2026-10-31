// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SpekoIncomingCalls} from "./SpekoIncomingCalls";
const mocks = vi.hoisted(() => ({incoming: vi.fn(), list: vi.fn(), decide: vi.fn()}));
vi.mock("@/api/voicePhone", () => ({voicePhoneApi: {incoming: mocks.incoming, decide: mocks.decide}}));
vi.mock("@/api/issues", () => ({issuesApi: {list: mocks.list}}));
describe("incoming call task selection", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  const tasks = [{id: "task", status: "todo", identifier: "PAP-42", title: "Ready task"}];
  beforeEach(() => {
    vi.resetAllMocks(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container); client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    mocks.incoming.mockResolvedValue([{id: "call", state: "awaiting_approval", approvalCode: "123456"}]);
  });
  afterEach(async () => {await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers();});
  async function render() {await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><SpekoIncomingCalls companyId="company" endpointId="endpoint" agentId="agent" /></QueryClientProvider></MemoryRouter>));}
  it("shows task request failures and lets callers retry the existing task inventory", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(tasks); await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Task list could not be loaded"));
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry tasks")!;
    retry.focus();
    await act(async () => retry.click());
    await vi.waitFor(() => expect(container.querySelector('option[value="task"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("select"));
  });
  it("preserves previously loaded tasks when a background task request fails", async () => {
    mocks.list.mockResolvedValue(tasks); await render();
    await vi.waitFor(() => expect(container.querySelector('option[value="task"]')).not.toBeNull());
    mocks.list.mockRejectedValue(new Error("Offline"));
    await act(async () => {await client.refetchQueries({queryKey: ["speko-approval-tasks", "company", "agent"]});});
    await vi.waitFor(() => expect(container.textContent).toContain("Task list could not be loaded"));
    expect(container.querySelector('option[value="task"]')).not.toBeNull();
  });
  it("expires a saved approval confirmation when the pending-call list omits it", async () => {
    mocks.list.mockResolvedValue(tasks);
    mocks.decide.mockResolvedValue({id: "call", state: "approved", approvalCode: "123456"});
    await render();
    await vi.waitFor(() => expect(container.querySelector('input')).not.toBeNull());
    mocks.incoming.mockResolvedValue([]);
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
      input.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    await vi.waitFor(() => expect(container.textContent).toContain('Call approved'));
    expect(container.textContent).not.toContain('You can now give instructions');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5100)); });
    expect(container.textContent).not.toContain('Call approved');
  }, 10000);

});
