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
vi.mock("@/hooks/useChatConnectorsEnabled", () => ({
  useChatConnectorsEnabled: () => ({ enabled: true, loaded: true }),
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
      [],
    );
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Sent to channel",
      body: "The board update was published to the connected conversation.",
      tone: "success",
    });
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("publishes only explicitly checked unbound task files", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
      id: "publication-file",
      state: "published",
      attempts: 1,
    });
    const attachment = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      provider: "local_disk",
      objectKey: "issues/issue-1/result.txt",
      contentType: "text/plain",
      byteSize: 12,
      sha256: "a".repeat(64),
      originalFilename: "result.txt",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      contentPath:
        "/api/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content",
    } satisfies IssueAttachment;
    await renderBanner([
      attachment,
      {
        ...attachment,
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        issueCommentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        originalFilename: "already-bound.txt",
      },
    ]);

    await act(() => findButton(container, "Send to channel").click());
    expect(container.textContent).toContain("result.txt");
    expect(container.textContent).not.toContain("already-bound.txt");
    const checkbox = container.querySelector('button[role="checkbox"]');
    if (!checkbox) throw new Error("Attachment checkbox missing");
    await act(() => (checkbox as HTMLButtonElement).click());
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Board update textarea missing");
    await act(() => setTextareaValue(textarea, "Send the requested file."));
    await act(() => {
      const sendButtons = [...container.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Send to channel",
      );
      sendButtons.at(-1)?.click();
    });
    await flushReact();

    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledWith(
      "endpoint-1",
      "conversation-1",
      "Send the requested file.",
      expect.any(String),
      [attachment.id],
    );
  });

  it("uploads a new file on an empty task without sending, then preserves its exact selection for publication", async () => {
    let finishUpload!: (value: unknown) => void;
    uploadAttachmentMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    );
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
      id: "uploaded-file-publication",
      state: "streaming",
      attempts: 1,
    });
    await renderBanner();
    await act(() => findButton(container, "Send to channel").click());
    await act(() =>
      setTextareaValue(
        container.querySelector("textarea")!,
        "The requested image.",
      ),
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(["synthetic image bytes"], "cat.png", {
      type: "image/png",
    });
    Object.defineProperty(input!, "files", {
      value: [file],
      configurable: true,
    });
    await act(() => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    expect(uploadAttachmentMock).toHaveBeenCalledWith(
      "company-1",
      "issue-1",
      file,
    );
    expect(findButton(container, "Uploading…").disabled).toBe(true);
    const send = [...container.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === "Send to channel")
      .at(-1)!;
    expect(send.disabled).toBe(true);
    expect(mockChatEndpointsApi.publishBoardMessage).not.toHaveBeenCalled();
    finishUpload({
      id: "uploaded-image",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      originalFilename: "cat.png",
    });
    await flushReact();
    expect(container.textContent).toContain(
      "Files stay on this task until you send them to the channel.",
    );
    expect(
      container
        .querySelector('button[role="checkbox"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(mockChatEndpointsApi.publishBoardMessage).not.toHaveBeenCalled();
    await act(() => send.click());
    await flushReact();
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledWith(
      "endpoint-1",
      "conversation-1",
      "The requested image.",
      expect.any(String),
      ["uploaded-image"],
    );
    expect(findButton(container, "Attach file").disabled).toBe(true);
    expect(
      readBoardSendDraft(
        boardSendDraftKey(
          "company-1",
          "issue-1",
          "endpoint-1",
          "conversation-1",
        ),
      )?.attachmentNames,
    ).toEqual([{ id: "uploaded-image", name: "cat.png" }]);
  });

  it("keeps the message editable after an unconfirmed upload and never sends it automatically", async () => {
    uploadAttachmentMock.mockRejectedValueOnce(
      new Error("Upload connection interrupted"),
    );
    await renderBanner();
    await act(() => findButton(container, "Send to channel").click());
    await act(() =>
      setTextareaValue(
        container.querySelector("textarea")!,
        "Keep this draft.",
      ),
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    Object.defineProperty(input!, "files", {
      value: [new File(["file"], "report.txt")],
      configurable: true,
    });
    await act(() => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    expect(container.textContent).toContain("Upload connection interrupted");
    expect(container.textContent).toContain("Check task files before retrying");
    expect(container.querySelector("textarea")?.value).toBe("Keep this draft.");
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(findButton(container, "Attach file").disabled).toBe(false);
    expect(mockChatEndpointsApi.publishBoardMessage).not.toHaveBeenCalled();
  });

  it("does not select a late upload in a different conversation", async () => {
    let finishUpload!: (value: unknown) => void;
    uploadAttachmentMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    );
    const queryClient = await renderBanner();
    await act(() => findButton(container, "Send to channel").click());
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    Object.defineProperty(input!, "files", {
      value: [new File(["file"], "old.txt")],
      configurable: true,
    });
    await act(() => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    queryClient.setQueryData(["issue-chat-binding", "company-1", "issue-1"], {
      endpointId: "endpoint-2",
      conversationId: "conversation-2",
      provider: "slack",
      externalLabel: "#second",
      assignedAgentLocked: true,
    });
    await flushReact();
    await act(() => findButton(container, "Send to channel").click());
    finishUpload({
      id: "old-upload",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      originalFilename: "old.txt",
    });
    await flushReact();
    expect(container.textContent).not.toContain("old.txt");
    expect(container.querySelectorAll('button[role="checkbox"]')).toHaveLength(
      0,
    );
    expect(findButton(container, "Attach file").disabled).toBe(false);
    expect(mockChatEndpointsApi.publishBoardMessage).not.toHaveBeenCalled();
  });

  it.each(["published", "cancelled"] as const)(
    "keeps exact selected file names and checks through binding/reload, then excludes them from a new %s draft",
    async (finalState) => {
      const attachment = {
        id: "file-selected",
        companyId: "company-1",
        issueId: "issue-1",
        issueCommentId: null,
        assetId: "asset-selected",
        provider: "local_disk",
        objectKey: "selected.txt",
        contentType: "text/plain",
        byteSize: 12,
        sha256: "a".repeat(64),
        originalFilename: "selected.txt",
        createdByAgentId: null,
        createdByUserId: "board",
        createdAt: new Date(),
        updatedAt: new Date(),
        contentPath: "/api/attachments/file-selected/content",
      } satisfies IssueAttachment;
      const internalOnly = {
        ...attachment,
        id: "file-internal",
        originalFilename: "internal-only.txt",
      };
      mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
        id: "original-anchor",
        state: "streaming",
        attempts: 1,
      });
      mockChatEndpointsApi.getPublicationBatchStatus.mockResolvedValue({
        publication: { id: "file-part", state: "pending", attempts: 0 },
        total: 2,
        published: 1,
      });
      const queryClient = await renderBanner([attachment, internalOnly]);
      await act(() => findButton(container, "Send to channel").click());
      await act(() =>
        (
          container.querySelector(
            'button[role="checkbox"]',
          ) as HTMLButtonElement
        ).click(),
      );
      await act(() =>
        setTextareaValue(container.querySelector("textarea")!, "Exact files"),
      );
      await act(() =>
        [...container.querySelectorAll("button")]
          .filter((button) => button.textContent?.trim() === "Send to channel")
          .at(-1)
          ?.click(),
      );
      await flushReact();
      const bound = { ...attachment, issueCommentId: "board-comment" };
      await renderBanner([bound, internalOnly], undefined, queryClient);
      const assertRetainedFiles = () => {
        expect(container.textContent).toContain("Files in this send");
        expect(container.textContent).toContain("selected.txt");
        expect(container.textContent).not.toContain("internal-only.txt");
        const checks = container.querySelectorAll('button[role="checkbox"]');
        expect(checks.length).toBe(1);
        expect(checks[0]?.getAttribute("aria-checked")).toBe("true");
        expect((checks[0] as HTMLButtonElement).disabled).toBe(true);
      };
      assertRetainedFiles();
      // Reload with attachment metadata still loading must retain saved names.
      flushSync(() => root.unmount());
      root = createRoot(container);
      const restoredClient = await renderBanner([]);
      assertRetainedFiles();
      await renderBanner([bound, internalOnly], undefined, restoredClient);
      assertRetainedFiles();
      mockChatEndpointsApi.getPublicationBatchStatus.mockResolvedValue({
        publication: { id: "file-part", state: finalState, attempts: 1 },
        total: 2,
        published: finalState === "published" ? 2 : 1,
        awaitingConsent: 0,
        declined: 0,
        expired: 0,
        cancelled: finalState === "cancelled" ? 1 : 0,
        settled: 2,
        canDismiss: true,
      });
      await restoredClient.invalidateQueries({
        queryKey: ["chat-publication-batch"],
      });
      await flushReact();
      await act(() =>
        findButton(
          container,
          finalState === "published"
            ? "Send to channel"
            : "Dismiss delivery receipt",
        ).click(),
      );
      expect(container.textContent).not.toContain("selected.txt");
      expect(container.textContent).toContain("internal-only.txt");
      const newCheck = container.querySelector(
        'button[role="checkbox"]',
      ) as HTMLButtonElement;
      expect(newCheck.getAttribute("aria-checked")).toBe("false");
      expect(newCheck.disabled).toBe(false);
      expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
      expect(
        mockChatEndpointsApi.publishBoardMessage.mock.calls[0]?.[4],
      ).toEqual([attachment.id]);
    },
  );

  it("refreshes a retained send and clears it only after every batch part is published", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
      id: "text-part",
      state: "streaming",
      attempts: 1,
    });
    mockChatEndpointsApi.getPublicationBatchStatus.mockResolvedValue({
      publication: { id: "file-part", state: "pending", attempts: 0 },
      total: 2,
      published: 1,
    });
    const queryClient = await renderBanner();
    await composeAndSubmit();
    await flushReact();
    expect(mockChatEndpointsApi.getPublicationBatchStatus).toHaveBeenCalledWith(
      "endpoint-1",
      "conversation-1",
      "text-part",
    );
    expect(container.querySelector("textarea")?.value).toBe(
      "Visible board update",
    );
    expect(container.textContent).toContain("Queued for channel");
    mockChatEndpointsApi.getPublicationBatchStatus.mockResolvedValue({
      publication: { id: "file-part", state: "published", attempts: 1 },
      total: 2,
      published: 2,
    });
    await queryClient.invalidateQueries({
      queryKey: ["chat-publication-batch"],
    });
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
    expect(
      mockChatEndpointsApi.getPublicationBatchStatus.mock.calls.every(
        (call) => call[2] === "text-part",
      ),
    ).toBe(true);
  });

  it("keeps a draft across status read errors and invalidates canonical task aliases", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
      id: "text-part",
      state: "streaming",
      attempts: 1,
    });
    mockChatEndpointsApi.getPublicationBatchStatus.mockRejectedValue(
      new Error("Status temporarily unavailable"),
    );
    const queryClient = await renderBanner([], ["issue-1", "CHA-2"]);
    const invalidated = vi.spyOn(queryClient, "invalidateQueries");
    await composeAndSubmit();
    await flushReact();
    expect(container.textContent).toContain(
      "Delivery status could not be refreshed",
    );
    expect(container.querySelector("textarea")?.value).toBe(
      "Visible board update",
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(invalidated).toHaveBeenCalledWith({
      queryKey: ["issues", "comments", "CHA-2"],
    });
    mockChatEndpointsApi.getPublicationBatchStatus.mockResolvedValue({
      publication: { id: "file-part", state: "published", attempts: 1 },
      total: 2,
      published: 1,
    });
    await queryClient.invalidateQueries({
      queryKey: ["chat-publication-batch"],
    });
    await flushReact();
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["github", "microsoft-teams"] as const)(
    "explains %s file delivery boundaries before publication",
    async (provider) => {
      mockChatEndpointsApi.getIssueBinding.mockResolvedValue({
        endpointId: "endpoint-github",
        provider,
        botLabel: "Maya",
        externalLabel: "paperclipai/paperclip#42",
        externalUrl: "https://github.com/paperclipai/paperclip/issues/42",
        conversationId: "conversation-github",
        publicationState: null,
        assignedAgentLocked: true,
      });
      const attachment = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        issueId: "issue-1",
        issueCommentId: null,
        assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        provider: "local_disk",
        objectKey: "issues/issue-1/result.txt",
        contentType: "text/plain",
        byteSize: 12,
        sha256: "a".repeat(64),
        originalFilename: "result.txt",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        contentPath:
          "/api/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content",
      } satisfies IssueAttachment;

      await renderBanner([attachment]);
      await act(() => findButton(container, "Send to channel").click());

      if (provider === "github") {
        expect(container.textContent).toContain(
          "GitHub Apps cannot upload file bytes in comments.",
        );
        expect(container.textContent).toContain(
          "GitHub receives an authenticated task link when this Board has a public URL, or a private-task notice otherwise.",
        );
      } else {
        expect(container.textContent).toContain(
          "In personal Teams chats, recipients accept each file before upload.",
        );
        expect(container.textContent).toContain(
          "Channels and group chats receive supported images directly; other files stay on the task, with a task link or private-task notice.",
        );
        expect(container.textContent).not.toContain(
          "Teams asks the recipient to accept each file before upload.",
        );
      }
      expect(container.textContent).not.toContain(
        "Only checked files will be published to the external conversation.",
      );
    },
  );

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

  it("keeps a request-scoped durable rejection through reload and allows an explicit corrected send", async () => {
    const file = {
      id: "bound-file",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      originalFilename: "report.txt",
    } as IssueAttachment;
    mockChatEndpointsApi.publishBoardMessage.mockImplementationOnce(
      (endpointId, conversationId, _body, idempotencyKey) =>
        Promise.reject(
          new ApiError(
            "A selected file already belongs to another comment",
            409,
            {
              details: {
                code: "chat_board_send_attachments_already_bound",
                endpointId,
                conversationId,
                idempotencyKey,
                attachmentIds: [file.id],
              },
            },
          ),
        ),
    );
    const queryClient = await renderBanner([file]);
    await act(() => findButton(container, "Send to channel").click());
    await act(() =>
      (
        container.querySelector('button[role="checkbox"]') as HTMLButtonElement
      ).click(),
    );
    await act(() =>
      setTextareaValue(
        container.querySelector("textarea")!,
        "Share the result",
      ),
    );
    await act(() =>
      [...container.querySelectorAll("button")]
        .filter((button) => button.textContent?.trim() === "Send to channel")
        .at(-1)
        ?.click(),
    );
    await flushReact();
    const originalKey =
      mockChatEndpointsApi.publishBoardMessage.mock.calls[0][3];
    expect(container.textContent).toContain("Update was not sent");
    expect(container.textContent).not.toContain(
      "Delivery result not confirmed",
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(findButton(container, "Edit rejected send")).toBeTruthy();
    flushSync(() => root.unmount());
    root = createRoot(container);
    await renderBanner([file], undefined, queryClient);
    expect(container.textContent).toContain("Update was not sent");
    expect(container.querySelector("textarea")?.value).toBe("Share the result");
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
    await act(() => findButton(container, "Edit rejected send").click());
    await flushReact();
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(container.querySelector("textarea")?.value).toBe("Share the result");
    expect(container.querySelectorAll('button[role="checkbox"]')).toHaveLength(
      0,
    );
    expect(container.textContent).toContain(
      "Attach a new copy or share the task link",
    );
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValueOnce({
      id: "new-send",
      state: "published",
      attempts: 1,
    });
    await act(() =>
      [...container.querySelectorAll("button")]
        .filter((button) => button.textContent?.trim() === "Send to channel")
        .at(-1)
        ?.click(),
    );
    await flushReact();
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(2);
    expect(mockChatEndpointsApi.publishBoardMessage.mock.calls[1][3]).not.toBe(
      originalKey,
    );
    expect(mockChatEndpointsApi.publishBoardMessage.mock.calls[1][4]).toEqual(
      [],
    );
  });

  it.each([
    "uncoded",
    "foreign-endpoint",
    "foreign-conversation",
    "foreign-key",
    "foreign-file",
    "empty-files",
    "server-error",
  ])(
    "does not unlock an uncertain send on a %s rejection-shaped error",
    async (kind) => {
      mockChatEndpointsApi.publishBoardMessage.mockImplementationOnce(
        (endpointId, conversationId, _body, idempotencyKey) =>
          Promise.reject(
            new ApiError("Conflict", kind === "server-error" ? 500 : 409, {
              details: {
                code:
                  kind === "uncoded"
                    ? "conflict"
                    : "chat_board_send_attachments_already_bound",
                endpointId: kind === "foreign-endpoint" ? "other" : endpointId,
                conversationId:
                  kind === "foreign-conversation" ? "other" : conversationId,
                idempotencyKey:
                  kind === "foreign-key" ? "other" : idempotencyKey,
                attachmentIds:
                  kind === "empty-files"
                    ? []
                    : [
                        kind === "foreign-file"
                          ? "unselected-file"
                          : "selected-file",
                      ],
              },
            }),
          ),
      );
      await renderBanner([
        {
          id: "selected-file",
          issueCommentId: null,
          originalFilename: "selected.txt",
        } as IssueAttachment,
      ]);
      await act(() => findButton(container, "Send to channel").click());
      await act(() =>
        (
          container.querySelector(
            'button[role="checkbox"]',
          ) as HTMLButtonElement
        ).click(),
      );
      await act(() =>
        setTextareaValue(
          container.querySelector("textarea")!,
          "Keep exact request",
        ),
      );
      await act(() =>
        [...container.querySelectorAll("button")]
          .filter((button) => button.textContent?.trim() === "Send to channel")
          .at(-1)
          ?.click(),
      );
      await flushReact();
      expect(container.textContent).toContain("Delivery result not confirmed");
      expect(container.textContent).not.toContain("Edit rejected send");
      expect(container.querySelector("textarea")?.disabled).toBe(true);
      expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("removes a selected file when authoritative task metadata binds it elsewhere, before a send", async () => {
    const file = {
      id: "now-bound",
      issueCommentId: null,
      originalFilename: "already-used.txt",
    } as IssueAttachment;
    const queryClient = await renderBanner([file]);
    await act(() => findButton(container, "Send to channel").click());
    await act(() =>
      (
        container.querySelector('button[role="checkbox"]') as HTMLButtonElement
      ).click(),
    );
    await act(() =>
      setTextareaValue(
        container.querySelector("textarea")!,
        "Keep this message",
      ),
    );
    await renderBanner(
      [{ ...file, issueCommentId: "saved-board-comment" }],
      undefined,
      queryClient,
    );
    expect(container.textContent).toContain(
      "Attach a new copy or share the task link",
    );
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValueOnce({
      id: "text-only",
      state: "published",
      attempts: 1,
    });
    await act(() =>
      [...container.querySelectorAll("button")]
        .filter((button) => button.textContent?.trim() === "Send to channel")
        .at(-1)
        ?.click(),
    );
    await flushReact();
    expect(mockChatEndpointsApi.publishBoardMessage.mock.calls[0][4]).toEqual(
      [],
    );
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

    expect(container.textContent).not.toContain("Start a new send");
    expect(container.textContent).not.toContain("Dismiss delivery receipt");
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
  });

  it("retains a Teams consent wait across reload without another send", async () => {
    const part = {
      id: "consent-file",
      state: "awaiting_consent",
      attempts: 1,
      fileTransfer: {
        provider: "microsoft-teams",
        phase: "awaiting_consent",
        filename: "report.txt",
        version: 2,
      },
    };
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue(part);
    mockChatEndpointsApi.getPublicationBatchStatus.mockResolvedValue({
      publication: part,
      total: 2,
      published: 1,
      parts: [{ id: "text", state: "published", attempts: 1 }, part],
      awaitingConsent: 1,
      declined: 0,
      expired: 0,
      cancelled: 0,
      settled: 1,
      canDismiss: false,
    });
    await renderBanner();
    await composeAndSubmit();
    expect(container.textContent).toContain("Waiting for file consent");
    expect(container.textContent).toContain("report.txt");
    expect(container.textContent).not.toContain("Dismiss delivery receipt");
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    await act(() => root.unmount());
    root = createRoot(container);
    await renderBanner();
    expect(container.textContent).toContain("Waiting for file consent");
    expect(
      mockChatEndpointsApi.getPublicationBatchStatus,
    ).toHaveBeenLastCalledWith("endpoint-1", "conversation-1", "consent-file");
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "dismisses a mixed terminal receipt only on explicit whole-batch permission (storage failure %s)",
    async (storageFailure) => {
      const part = {
        id: "declined-file",
        state: "cancelled",
        attempts: 1,
        fileTransfer: {
          provider: "microsoft-teams",
          phase: "declined",
          filename: "declined.txt",
          version: 3,
        },
      };
      mockChatEndpointsApi.publishBoardMessage.mockResolvedValue(part);
      mockChatEndpointsApi.getPublicationBatchStatus.mockResolvedValue({
        publication: part,
        total: 3,
        published: 1,
        awaitingConsent: 0,
        declined: 1,
        expired: 1,
        cancelled: 0,
        settled: 3,
        canDismiss: true,
        parts: [
          { id: "text", state: "published", attempts: 1 },
          part,
          {
            ...part,
            id: "expired-file",
            fileTransfer: {
              ...part.fileTransfer,
              phase: "expired",
              filename: "expired.txt",
            },
          },
        ],
      });
      await renderBanner();
      await composeAndSubmit();
      expect(container.textContent).toContain(
        "1 published · 1 declined · 1 expired",
      );
      expect(container.textContent).toContain("expired.txt");
      const removeItemSpy = storageFailure
        ? vi
            .spyOn(Object.getPrototypeOf(sessionStorage), "removeItem")
            .mockImplementation(() => {
              throw new Error("storage denied");
            })
        : null;
      await act(() =>
        findButton(container, "Dismiss delivery receipt").click(),
      );
      expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
      if (storageFailure) {
        expect(container.querySelector("textarea")?.disabled).toBe(true);
        expect(container.textContent).toContain("could not be cleared");
        removeItemSpy!.mockRestore();
        await act(() =>
          findButton(container, "Dismiss delivery receipt").click(),
        );
        expect(container.querySelector("textarea")?.disabled).toBe(false);
        expect(container.querySelector("textarea")?.value).toBe("");
        expect(container.textContent).not.toContain("could not be cleared");
        expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(
          1,
        );
      } else {
        expect(container.querySelector("textarea")?.value).toBe("");
        expect(container.querySelector("textarea")?.disabled).toBe(false);
        expect(
          readBoardSendDraft(
            boardSendDraftKey(
              "company-1",
              "issue-1",
              "endpoint-1",
              "conversation-1",
            ),
          ),
        ).toBeNull();
        expect(
          pushToastMock.mock.calls.some(
            ([toast]) => toast.title === "Sent to channel",
          ),
        ).toBe(false);
      }
    },
  );

  it("does not release a cancelled head while another file still waits", async () => {
    const part = { id: "cancelled-head", state: "cancelled", attempts: 1 };
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue(part);
    mockChatEndpointsApi.getPublicationBatchStatus.mockResolvedValue({
      publication: part,
      total: 2,
      published: 0,
      awaitingConsent: 1,
      declined: 0,
      expired: 0,
      cancelled: 1,
      settled: 1,
      canDismiss: false,
    });
    await renderBanner();
    await composeAndSubmit();
    expect(container.textContent).toContain(
      "Waiting for remaining file consent",
    );
    expect(container.textContent).not.toContain("Channel delivery cancelled");
    expect(container.textContent).not.toContain("Dismiss delivery receipt");
    expect(container.textContent).not.toContain("Start a new send");
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
  });

  it("restores a pending batch after reload without another POST", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValue({
      id: "original-anchor",
      state: "streaming",
      attempts: 1,
    });
    await renderBanner();
    await composeAndSubmit("Reload-safe board send");
    flushSync(() => root.unmount());
    root = createRoot(container);
    await renderBanner();
    expect(container.querySelector("textarea")?.value).toBe(
      "Reload-safe board send",
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(
      mockChatEndpointsApi.getPublicationBatchStatus,
    ).toHaveBeenLastCalledWith(
      "endpoint-1",
      "conversation-1",
      "original-anchor",
    );
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
  });

  it("restores an unconfirmed payload after reload and only explicitly retries the same identity", async () => {
    mockChatEndpointsApi.publishBoardMessage.mockRejectedValueOnce(
      new Error("Response lost"),
    );
    await renderBanner();
    await composeAndSubmit("Exact request survives reload");
    const firstCall = mockChatEndpointsApi.publishBoardMessage.mock.calls[0];
    flushSync(() => root.unmount());
    root = createRoot(container);
    await renderBanner();
    expect(container.querySelector("textarea")?.value).toBe(
      "Exact request survives reload",
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(mockChatEndpointsApi.publishBoardMessage).toHaveBeenCalledTimes(1);
    expect(
      mockChatEndpointsApi.getPublicationBatchStatus,
    ).not.toHaveBeenCalled();
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValueOnce({
      id: "confirmed",
      state: "published",
      attempts: 1,
    });
    await act(() => findButton(container, "Retry safely").click());
    await flushReact();
    expect(mockChatEndpointsApi.publishBoardMessage.mock.calls[1]).toEqual(
      firstCall,
    );
    expect(container.querySelector("textarea")).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("does not send when browser storage cannot preserve the request identity", async () => {
    await renderBanner();
    vi.spyOn(
      Object.getPrototypeOf(sessionStorage),
      "setItem",
    ).mockImplementation(() => {
      throw new Error("Storage full");
    });
    await composeAndSubmit();
    expect(mockChatEndpointsApi.publishBoardMessage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No update was sent");
  });

  it("isolates an in-flight send and its late response when the binding scope changes", async () => {
    let finishOldSend!: (value: unknown) => void;
    mockChatEndpointsApi.publishBoardMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldSend = resolve;
        }),
    );
    const queryClient = await renderBanner();
    await composeAndSubmit("Original conversation only");
    expect(container.textContent).not.toContain(
      "Delivery result not confirmed",
    );
    const originalCall = mockChatEndpointsApi.publishBoardMessage.mock.calls[0];
    queryClient.setQueryData(["issue-chat-binding", "company-1", "issue-1"], {
      endpointId: "endpoint-2",
      conversationId: "conversation-2",
      provider: "slack",
      externalLabel: "#second",
      assignedAgentLocked: true,
    });
    await flushReact();
    await act(() => findButton(container, "Send to channel").click());
    expect(container.querySelector("textarea")?.value).toBe("");
    const sendButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Send to channel",
    );
    expect(sendButtons.at(-1)?.disabled).toBe(true);
    finishOldSend({ id: "old-anchor", state: "streaming", attempts: 1 });
    await flushReact();
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(
      mockChatEndpointsApi.getPublicationBatchStatus,
    ).not.toHaveBeenCalledWith("endpoint-2", "conversation-2", "old-anchor");
    expect(
      readBoardSendDraft(
        boardSendDraftKey(
          "company-1",
          "issue-1",
          "endpoint-1",
          "conversation-1",
        ),
      ),
    ).toMatchObject({
      body: "Original conversation only",
      idempotencyKey: originalCall[3],
      publication: { id: "old-anchor" },
    });
    expect(
      readBoardSendDraft(
        boardSendDraftKey(
          "company-1",
          "issue-1",
          "endpoint-2",
          "conversation-2",
        ),
      ),
    ).toBeNull();
    mockChatEndpointsApi.publishBoardMessage.mockResolvedValueOnce({
      id: "new-anchor",
      state: "published",
      attempts: 1,
    });
    await act(() =>
      setTextareaValue(
        container.querySelector("textarea")!,
        "New conversation only",
      ),
    );
    await act(() => sendButtons.at(-1)?.click());
    await flushReact();
    expect(
      mockChatEndpointsApi.publishBoardMessage.mock.calls[1]?.slice(0, 3),
    ).toEqual(["endpoint-2", "conversation-2", "New conversation only"]);
    expect(
      mockChatEndpointsApi.publishBoardMessage.mock.calls[1]?.[3],
    ).not.toBe(originalCall[3]);
  });
});
