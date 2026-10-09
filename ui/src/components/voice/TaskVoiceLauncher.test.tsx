// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskVoiceLauncher } from "./TaskVoiceLauncher";
import { spekoEndpoint } from "../../../storybook/fixtures/spekoNative";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { list: mocks.list } }));
vi.mock("@/hooks/useChatConnectorsEnabled", () => ({ useChatConnectorsEnabled: () => ({ enabled: true }) }));
vi.mock("./NativeVoiceConversation", () => ({ NativeVoiceConversation: () => <p>Active voice controls</p> }));

describe("task voice connection failures", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function render(bound = false) {
    await act(async () => root.render(<QueryClientProvider client={client}><TaskVoiceLauncher companyId="company" issueId="issue" agentId={spekoEndpoint.assignedAgentId} boundEndpointId={bound ? spekoEndpoint.id : undefined} /></QueryClientProvider>));
  }
  it.each([false, true])("shows a retryable request failure for bound=%s instead of a missing connection", async bound => {
    mocks.list.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue([spekoEndpoint]); await render(bound);
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Voice connections could not be loaded"));
    expect(container.textContent).not.toContain("Voice is unavailable");
    await act(async () => container.querySelector('button')!.click());
    await vi.waitFor(() => expect(container.textContent).toContain(`Talk to ${spekoEndpoint.assignedAgentName}`));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("keeps active controls mounted when a background connection refresh fails", async () => {
    mocks.list.mockResolvedValue([spekoEndpoint]); await render();
    await vi.waitFor(() => expect(container.querySelector('button')).not.toBeNull());
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain("Active voice controls");
    mocks.list.mockRejectedValue(new Error("Offline"));
    await act(async () => { await client.refetchQueries({queryKey: ["task-voice-endpoints", "company"]}); });
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("Active voice controls");
  });
});
