// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpekoCallHistory } from "./SpekoCallHistory";
import { callHistoryFixture } from "../../../storybook/fixtures/spekoCallHistory";
const mocks = vi.hoisted(() => ({list: vi.fn(), incoming: vi.fn(), end: vi.fn()}));
vi.mock("@/api/voiceHistory", () => ({voiceHistoryApi: {list: mocks.list}}));
vi.mock("@/api/voicePhone", () => ({voicePhoneApi: {history: mocks.incoming}}));
vi.mock("@/api/voiceSessions", () => ({voiceSessionsApi: {end: mocks.end}}));

describe("saved Speko call history", () => {
  let container: HTMLDivElement, root: Root, query: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container); query = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    mocks.list.mockResolvedValue([callHistoryFixture]); mocks.incoming.mockResolvedValue([]);
  });
  afterEach(async () => {await act(async () => root.unmount()); query.clear(); container.remove();});
  async function render() {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={query}><SpekoCallHistory companyId="company" endpointId="endpoint" /></QueryClientProvider></MemoryRouter>));
  }
  it("keeps completed call transcripts when paused inbound admission cannot load", async () => {
    mocks.incoming.mockRejectedValue(new Error("Connection is paused")); await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Unapproved calls could not be loaded"));
    expect(container.querySelector("summary")?.textContent).toContain("Completed");
    expect(container.querySelector('[aria-label="Call transcript"]')).not.toBeNull();
  });
  it("keeps readable call history after a failed end-call request", async () => {
    mocks.list.mockResolvedValue([{...callHistoryFixture, session: {...callHistoryFixture.session, state: "active", endedAt: null}}]);
    mocks.end.mockRejectedValue(new Error("Provider unavailable")); await render();
    await vi.waitFor(() => expect(container.querySelector("summary")).not.toBeNull());
    const end = [...container.querySelectorAll("button")].find(button => button.textContent === "End call")!;
    await act(async () => end.click());
    await vi.waitFor(() => expect(container.textContent).toContain("The call could not be ended"));
    expect(container.querySelector("summary")?.textContent).toContain("In progress");
    expect(container.querySelector('[aria-label="Call transcript"]')).not.toBeNull();
  });
});
