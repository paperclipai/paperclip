// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SlackTestMessageButton } from "./SlackTestMessageButton";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

const mocks = vi.hoisted(() => ({ sendSlackTestMessage: vi.fn(), listPrincipals: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: mocks }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.clearAllMocks();
});

it("masks Slack account names and ids in session replay", async () => {
  mocks.sendSlackTestMessage.mockResolvedValue({ status: "connection_required", nextCursor: null,
    accounts: [{ id: "U0PELLWORTH", name: "Delphine Pellworth" }] });
  await act(async () => root.render(<QueryClientProvider client={client}><SlackTestMessageButton endpointId="endpoint" /></QueryClientProvider>));
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Send me a test message")!.click());
  expect(replayLeaks("Delphine Pellworth", document.body)).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("U0PELLWORTH", document.body)).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("Connect your Slack account", document.body)).toEqual({ rendered: true, recorded: false });
});
