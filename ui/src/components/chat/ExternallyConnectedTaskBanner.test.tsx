// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternallyConnectedTaskBanner } from "./ExternallyConnectedTaskBanner";

const mockChatEndpointsApi = vi.hoisted(() => ({
  getIssueBinding: vi.fn(),
  publishBoardMessage: vi.fn(),
}));
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/chatEndpoints", () => ({
  chatEndpointsApi: mockChatEndpointsApi,
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children?: ReactNode;
    to: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function findButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ExternallyConnectedTaskBanner publication truth", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderBanner() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ExternallyConnectedTaskBanner
            companyId="company-1"
            issueId="issue-1"
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function composeAndSubmit(value = "Visible board update") {
    await act(() => findButton(container, "Send to channel").click());
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Board update textarea missing");
    await act(() => setTextareaValue(textarea, value));
    await act(() => {
      const sendButtons = [...container.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Send to channel",
      );
      sendButtons.at(-1)?.click();
    });
    await flushReact();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatEndpointsApi.getIssueBinding.mockResolvedValue({
      endpointId: "endpoint-1",
      provider: "slack",
      botLabel: "Maya",
      externalLabel: "#paperclip",
      externalUrl: "https://example.slack.com/archives/channel-1",
      conversationId: "conversation-1",
      publicationState: null,
      assignedAgentLocked: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("only reports success and clears the draft after confirmed publication", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
      id: "publication-1",
      state: "published",
      attempts: 1,
      publishedAt: "2026-09-06T12:00:00.000Z",
    });
    await renderBanner();
    await composeAndSubmit();

    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledWith(
      "endpoint-1",
      "conversation-1",
      "Visible board update",
      expect.any(String),
    );
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Sent to channel",
      body: "The board update was published to the connected conversation.",
      tone: "success",
    });
    expect(container.querySelector("textarea")).toBeNull();
  });

  it.each([
    ["pending", "Queued for channel"],
    ["streaming", "Publishing to channel"],
    ["retry", "Delivery retry scheduled"],
    ["delivery_unknown", "Delivery not confirmed"],
    ["failed", "Channel delivery failed"],
    ["cancelled", "Channel delivery cancelled"],
  ] as const)(
    "keeps the draft and shows Activity guidance for %s",
    async (state, title) => {
      mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
        id: `publication-${state}`,
        state,
        attempts: 1,
        redactedError:
          state === "failed" ? "Provider rejected the update" : null,
      });
      await renderBanner();
      await composeAndSubmit();

      const textarea = container.querySelector("textarea");
      expect(textarea?.value).toBe("Visible board update");
      expect(textarea?.disabled).toBe(true);
      expect(container.textContent).toContain(title);
      expect(
        container.querySelector('a[href="/apps/chat/endpoint-1/activity"]'),
      ).not.toBeNull();
      expect(pushToastMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title,
          action: {
            label: "View activity",
            href: "/apps/chat/endpoint-1/activity",
          },
        }),
      );
      expect(pushToastMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Sent to channel" }),
      );
    },
  );

  it("reuses the same request identity when the client retries an unconfirmed request", async () => {
    mockChatEndpointsApi.publishBoardMessage
      .mockRejectedValueOnce(new Error("Connection interrupted."))
      .mockResolvedValueOnce({
        id: "publication-1",
        state: "published",
        attempts: 1,
      });
    await renderBanner();
    await composeAndSubmit();

    const retainedDraft = container.querySelector("textarea");
    expect(retainedDraft?.value).toBe("Visible board update");
    expect(retainedDraft?.disabled).toBe(true);
    expect(container.textContent).toContain("Delivery result not confirmed");
    expect(findButton(container, "Retry safely")).not.toBeNull();
    const firstKey =
      mockChatEndpointsApi.publishBoardMessage.mock.calls[0]?.[3];

    await act(() => findButton(container, "Retry safely").click());
    await flushReact();

    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(2);
    expect(mockChatEndpointsApi.publishBoardMessage.mock.calls[1]?.[3]).toBe(
      firstKey,
    );
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("requires an explicit new send after a cancelled publication", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
      id: "publication-cancelled",
      state: "cancelled",
      attempts: 1,
    });
    await renderBanner();
    await composeAndSubmit();

    const retainedDraft = container.querySelector("textarea");
    expect(retainedDraft?.value).toBe("Visible board update");
    expect(retainedDraft?.disabled).toBe(true);

    await act(() => findButton(container, "Start a new send").click());

    expect(container.querySelector("textarea")?.value).toBe(
      "Visible board update",
    );
    expect(container.querySelector("textarea")?.disabled).toBe(false);
  });
});
