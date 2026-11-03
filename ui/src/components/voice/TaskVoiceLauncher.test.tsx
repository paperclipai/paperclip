// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallContext } from "./VoiceCallContext";
import { queryKeys } from "@/lib/queryKeys";
import { TaskVoiceLauncher } from "./TaskVoiceLauncher";
import { spekoEndpoint } from "../../../storybook/support/speko/spekoNative";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { list: mocks.list } }));
vi.mock("@/hooks/useChatConnectorsEnabled", () => ({ useChatConnectorsEnabled: () => ({ enabled: true }) }));
vi.mock("./NativeVoiceConversation", () => ({ NativeVoiceConversation: () => <p>Active voice controls</p> }));

describe("task voice connection failures", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function render(bound = false, active?: boolean) {
    await act(async () => root.render(<QueryClientProvider client={client}><VoiceCallContext.Provider value={active === undefined ? null : { active, open: vi.fn() }}><TaskVoiceLauncher companyId="company" issueId="issue" agentId={spekoEndpoint.assignedAgentId} boundEndpointId={bound ? spekoEndpoint.id : undefined} /></VoiceCallContext.Provider></QueryClientProvider>));
  }
  it.each([false, true])("shows a retryable request failure for bound=%s instead of a missing connection", async bound => {
    mocks.list.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue([spekoEndpoint]); await render(bound);
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Voice connections could not be loaded"));
    expect(container.textContent).not.toContain("Voice is unavailable");
    container.querySelector('button')!.focus();
    await act(async () => container.querySelector('button')!.click());
    await vi.waitFor(() => expect(container.textContent).toContain(`Talk to ${spekoEndpoint.assignedAgentName}`));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('button'));
  });
  it("restores persona selection and keyboard focus after the hosted panel closes", async () => {
    mocks.list.mockResolvedValue([spekoEndpoint, {...spekoEndpoint, id: "second", botLabel: "Second persona"}]);
    await render(false, false);
    await vi.waitFor(() => expect(container.querySelector('select')).not.toBeNull());
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('select')).toBeNull();
    await render(false, true);
    await render(false, false);
    await vi.waitFor(() => expect(container.querySelector('select')).not.toBeNull());
    expect(document.activeElement).toBe(container.querySelector('button'));
    await act(async () => {
      const select = container.querySelector('select')!; select.value = "second";
      select.dispatchEvent(new Event("change", {bubbles: true}));
    });
    expect(container.querySelector('select')?.value).toBe("second");
  });
  it("updates the mounted launcher after shared connection pause and resume invalidation", async () => {
    mocks.list.mockResolvedValue([spekoEndpoint]); await render(true);
    await vi.waitFor(() => expect(container.textContent).toContain(`Talk to ${spekoEndpoint.assignedAgentName}`));
    mocks.list.mockResolvedValue([{...spekoEndpoint, status: "paused"}]);
    await act(async () => { await client.invalidateQueries({queryKey: queryKeys.chatEndpoints.list("company")}); });
    await vi.waitFor(() => expect(container.textContent).toContain("Voice is unavailable"));
    expect(container.textContent).not.toContain(`Talk to ${spekoEndpoint.assignedAgentName}`);
    mocks.list.mockResolvedValue([spekoEndpoint]);
    await act(async () => { await client.invalidateQueries({queryKey: queryKeys.chatEndpoints.list("company")}); });
    await vi.waitFor(() => expect(container.textContent).toContain(`Talk to ${spekoEndpoint.assignedAgentName}`));
  });
  it("keeps active controls mounted when a background connection refresh fails", async () => {
    mocks.list.mockResolvedValue([spekoEndpoint]); await render();
    await vi.waitFor(() => expect(container.querySelector('button')).not.toBeNull());
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain("Active voice controls");
    mocks.list.mockRejectedValue(new Error("Offline"));
    await act(async () => { await client.refetchQueries({queryKey: queryKeys.chatEndpoints.list("company")}); });
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("Active voice controls");
  });
});
