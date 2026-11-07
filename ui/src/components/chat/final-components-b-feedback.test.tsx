// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueAttachment } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternallyConnectedTaskBanner } from "./ExternallyConnectedTaskBanner";
import { boardSendDraftKey, readBoardSendDraft } from "./board-send-draft";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { i18n } from "@/i18n";
import { resolveUiMessage } from "@/lib/localized-ui-error";
const mockSession = vi.hoisted(() => ({ userId: "user-1" }));
vi.mock("@/api/auth", () => ({
  authApi: { getSession: vi.fn(async () => ({ user: { id: mockSession.userId } })) },
}));

const mockChatEndpointsApi = vi.hoisted(() => ({
  getIssueBinding: vi.fn(),
  publishBoardMessage: vi.fn(),
  getPublicationBatchStatus: vi.fn(),
}));
const pushToastMock = vi.hoisted(() => vi.fn());
const uploadAttachmentMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/issues", () => ({
  issuesApi: { uploadAttachment: uploadAttachmentMock },
}));
// Lets a test report that automatic resends stopped, without running eight
// backoff rounds; otherwise the real hook runs.
const autoResendOverride = vi.hoisted(() => ({ stalled: false }));
vi.mock("@/hooks/useDurableSubmit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useDurableSubmit")>();
  return {
    ...actual,
    useAutoResend: (options: Parameters<typeof actual.useAutoResend>[0]) => {
      const result = actual.useAutoResend(options);
      return autoResendOverride.stalled ? { ...result, stalled: true } : result;
    },
  };
});
vi.mock("@/hooks/useChatConnectorsEnabled", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/useChatConnectorsEnabled")>(),
  useChatConnectorsEnabled: () => ({ enabled: true, githubEnabled: true, loaded: true }),
}));

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

  async function renderBanner(
    attachments: IssueAttachment[] = [],
    issueCacheRefs?: string[],
    existingQueryClient?: QueryClient,
  ) {
    const queryClient =
      existingQueryClient ??
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
    if (!existingQueryClient) queryClient.setQueryData(queryKeys.auth.session, { user: { id: mockSession.userId } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ExternallyConnectedTaskBanner
            attachments={attachments}
            companyId="company-1"
            issueId="issue-1"
            issueCacheRefs={issueCacheRefs}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return queryClient;
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
    mockSession.userId = "user-1";
    sessionStorage.clear();
    mockChatEndpointsApi.getPublicationBatchStatus.mockImplementation(
      () => new Promise(() => {}),
    );
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
    vi.restoreAllMocks();
    autoResendOverride.stalled = false;
  });

  afterEach(async () => { await i18n.changeLanguage("en"); });

  it("switches held delivery feedback live without re-sending, clearing or changing its retained draft identity", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({id: "publication-1", state: "pending", attempts: 1});
    await renderBanner(); await composeAndSubmit("Original draft 原文");
    const saved = Array.from({length:sessionStorage.length},(_,index)=>sessionStorage.getItem(sessionStorage.key(index)!));
    const textarea = container.querySelector("textarea");
    expect(saved.length).toBe(1);
    await act(async () => { await i18n.changeLanguage("zh-CN"); }); await flushReact();
    expect(container.textContent).toContain("交付仍在等待中。你的草稿会保留，直到 Paperclip 确认发布。");
    expect(container.querySelector("textarea")).toBe(textarea); expect(textarea?.value).toBe("Original draft 原文");
    expect(Array.from({length:sessionStorage.length},(_,index)=>sessionStorage.getItem(sessionStorage.key(index)!))).toEqual(saved);
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
  });

  it("carries render-time descriptors with a retained success toast and keeps original message data", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({id:"publication-1",state:"published",attempts:1});
    await renderBanner();await composeAndSubmit();const toast=pushToastMock.mock.calls.at(-1)![0];
    expect(toast.body).toBe("The board update was published to the connected conversation.");
    expect(toast.presentation?.body).toBeDefined();
    await i18n.changeLanguage("zh-CN");expect(resolveUiMessage(toast.presentation.body)).toBe("管理端更新已发布到关联会话。");
    expect(toast.body).toBe("The board update was published to the connected conversation.");
  });
});
