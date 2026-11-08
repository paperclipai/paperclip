// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { UserDelegateControl } from "./UserDelegateControl";

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const taskTargetChecks = vi.hoisted(() => ({ count: 0, limit: Infinity }));

vi.mock("@/lib/company-members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/company-members")>();
  return {
    ...actual,
    isAgentTaskTarget: (...args: Parameters<typeof actual.isAgentTaskTarget>) => {
      taskTargetChecks.count += 1;
      if (taskTargetChecks.count > taskTargetChecks.limit) throw new Error("Agent filter ran more often than its bound");
      return actual.isAgentTaskTarget(...args);
    },
  };
});
const mockUserDelegateApi = vi.hoisted(() => ({ getMine: vi.fn(), setMine: vi.fn(), clearMine: vi.fn() }));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/user-delegate", () => ({ userDelegateApi: mockUserDelegateApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

const actions = [{ key: "agent.wake", method: "POST", path: "/api/agents/:id/wakeup", description: "Wake another agent" }];
const delegate = {
  id: "delegation-1", companyId: "company-1", userId: "user-1", delegateAgentId: "agent-1",
  createdByUserId: "user-1", createdAt: new Date(), updatedAt: new Date(),
};

function render(container: HTMLDivElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <UserDelegateControl companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  return root;
}

function select(container: HTMLElement) {
  return container.querySelector("#user-delegate-agent") as HTMLSelectElement;
}

function saveButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Save")) as HTMLButtonElement;
}

async function choose(container: HTMLElement, value: string) {
  const element = select(container);
  await act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setValue.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("UserDelegateControl", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "Chief of staff", role: "general", status: "active", icon: null },
      { id: "agent-2", name: "Retired", role: "engineer", status: "terminated", icon: null },
    ]);
  });

  afterEach(() => {
    taskTargetChecks.count = 0;
    taskTargetChecks.limit = Infinity;
    container.remove();
    vi.clearAllMocks();
  });

  it("names a delegate from the active agents", async () => {
    mockUserDelegateApi.getMine.mockResolvedValue({ delegate: null, actions });
    mockUserDelegateApi.setMine.mockResolvedValue({ delegate, actions });
    const root = render(container);

    await waitForAssertion(() => expect(select(container).value).toBe(""));
    await waitForAssertion(() => expect(container.textContent).toContain("Chief of staff"));
    expect(container.textContent).not.toContain("Retired");
    expect(container.textContent).toContain("Wake another agent");
    expect(saveButton(container).disabled).toBe(true);

    await choose(container, "agent-1");
    await act(() => saveButton(container).click());
    await waitForAssertion(() => expect(mockUserDelegateApi.setMine).toHaveBeenCalledWith("company-1", { agentId: "agent-1" }));
    await waitForAssertion(() => expect(container.textContent).toContain("Saved"));
    act(() => root.unmount());
  });

  it("turns the delegate off", async () => {
    mockUserDelegateApi.getMine.mockResolvedValue({ delegate, actions });
    mockUserDelegateApi.clearMine.mockResolvedValue({ delegate: null, actions });
    const root = render(container);

    await waitForAssertion(() => expect(select(container).value).toBe("agent-1"));
    await choose(container, "");
    await act(() => saveButton(container).click());
    await waitForAssertion(() => expect(mockUserDelegateApi.clearMine).toHaveBeenCalledWith("company-1"));
    expect(mockUserDelegateApi.setMine).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
  it("keeps an unavailable saved delegate visible so it can be turned off", async () => {
    mockAgentsApi.list.mockRejectedValue(new Error("agents down"));
    mockUserDelegateApi.getMine.mockResolvedValue({ delegate: { ...delegate, delegateAgentId: "agent-2" }, actions });
    mockUserDelegateApi.clearMine.mockResolvedValue({ delegate: null, actions });
    const root = render(container);

    await waitForAssertion(() => expect(select(container).value).toBe("agent-2"));
    expect(container.textContent).toContain("(unavailable)");
    await waitForAssertion(() => expect(container.querySelector("[role=alert]")).not.toBeNull());
    expect(saveButton(container).disabled).toBe(true);

    await choose(container, "");
    expect(saveButton(container).disabled).toBe(false);
    await act(() => saveButton(container).click());
    await waitForAssertion(() => expect(mockUserDelegateApi.clearMine).toHaveBeenCalledWith("company-1"));
    act(() => root.unmount());
  });
  it("filters a company-sized agent list once per load and keeps a filtered-out saved delegate", async () => {
    const agentCount = 2000;
    mockAgentsApi.list.mockResolvedValue(Array.from({ length: agentCount }, (_, index) => ({
      id: `agent-${index}`, name: `Agent ${index}`, role: "general",
      status: index % 2 === 0 ? "active" : "terminated", icon: null,
    })));
    mockUserDelegateApi.getMine.mockResolvedValue({ delegate: { ...delegate, delegateAgentId: "agent-1" }, actions });
    // Filtering is memoized on the query data: a few loads at most, never per render or per option.
    taskTargetChecks.limit = agentCount * 3;
    const root = render(container);

    await waitForAssertion(() => expect(select(container).value).toBe("agent-1"));
    await waitForAssertion(() => expect(select(container).options).toHaveLength(1 + agentCount / 2 + 1));
    expect(container.textContent).toContain("Agent 1 (unavailable)");
    expect(taskTargetChecks.count).toBeLessThanOrEqual(agentCount * 3);
    act(() => root.unmount());
  });
});
