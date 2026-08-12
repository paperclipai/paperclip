// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppendMessage, ExternalStoreAdapter, ThreadMessage } from "@assistant-ui/react";
import { usePaperclipIssueRuntime } from "./usePaperclipIssueRuntime";

const { useExternalStoreRuntimeMock } = vi.hoisted(() => ({
  useExternalStoreRuntimeMock: vi.fn(() => ({ kind: "runtime" })),
}));

vi.mock("@assistant-ui/react", () => ({
  useExternalStoreRuntime: useExternalStoreRuntimeMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function HookHarness({
  messages,
  isRunning,
  onSend,
  onCancel,
}: {
  messages: readonly ThreadMessage[];
  isRunning: boolean;
  onSend: (options: { body: string; reopen?: boolean; reassignment?: { assigneeAgentId: string | null; assigneeUserId: string | null } }) => Promise<void>;
  onCancel?: (() => Promise<void>) | undefined;
}) {
  usePaperclipIssueRuntime({
    messages,
    isRunning,
    onSend,
    onCancel,
  });
  return null;
}

function createAppendMessage(body: string): AppendMessage {
  return {
    createdAt: new Date("2026-04-11T14:00:02.000Z"),
    parentId: null,
    role: "user",
    sourceId: null,
    content: [{ type: "text", text: body }],
    metadata: { custom: {} },
    attachments: [],
    runConfig: undefined,
  };
}

function createUserMessage(id: string, text: string): ThreadMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    metadata: { custom: {} },
    attachments: [],
    createdAt: new Date("2026-04-11T14:00:00.000Z"),
  } as unknown as ThreadMessage;
}

function createAssistantMessage(id: string, text: string): ThreadMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    metadata: { custom: {} },
    status: { type: "complete", reason: "stop" },
    createdAt: new Date("2026-04-11T14:00:01.000Z"),
  } as unknown as ThreadMessage;
}

describe("usePaperclipIssueRuntime", () => {
  afterEach(() => {
    useExternalStoreRuntimeMock.mockReset();
  });

  it("keeps the external-store adapter stable across unrelated rerenders", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const messages: ThreadMessage[] = [createUserMessage("message-1", "hello")];
    const firstOnSend = vi.fn(async () => {});
    const secondOnSend = vi.fn(async () => {});

    act(() => {
      root.render(
        <HookHarness
          messages={messages}
          isRunning={false}
          onSend={firstOnSend}
        />,
      );
    });

    const runtimeCalls = useExternalStoreRuntimeMock.mock.calls as unknown as Array<
      [ExternalStoreAdapter<ThreadMessage>]
    >;
    expect(runtimeCalls.length).toBeGreaterThanOrEqual(1);
    const firstAdapter = runtimeCalls[0]![0];
    expect(firstAdapter).toBeTruthy();

    act(() => {
      root.render(
        <HookHarness
          messages={messages}
          isRunning={false}
          onSend={secondOnSend}
        />,
      );
    });

    expect(runtimeCalls.length).toBeGreaterThanOrEqual(2);
    const secondAdapter = runtimeCalls[1]![0];
    expect(secondAdapter).toBe(firstAdapter);

    await act(async () => {
      await secondAdapter.onNew?.(createAppendMessage("latest callback"));
    });

    expect(firstOnSend).not.toHaveBeenCalled();
    expect(secondOnSend).toHaveBeenCalledWith({
      body: "latest callback",
      reopen: undefined,
      reassignment: undefined,
    });

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("rebuilds the adapter when thread data changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSend = vi.fn(async () => {});
    const firstMessages: ThreadMessage[] = [createUserMessage("message-1", "hello")];
    const secondMessages: ThreadMessage[] = [...firstMessages, createAssistantMessage("message-2", "world")];

    act(() => {
      root.render(
        <HookHarness
          messages={firstMessages}
          isRunning={false}
          onSend={onSend}
        />,
      );
    });

    const runtimeCalls = useExternalStoreRuntimeMock.mock.calls as unknown as Array<
      [ExternalStoreAdapter<ThreadMessage>]
    >;
    expect(runtimeCalls.length).toBeGreaterThanOrEqual(1);
    const firstAdapter = runtimeCalls[0]![0];

    act(() => {
      root.render(
        <HookHarness
          messages={secondMessages}
          isRunning={false}
          onSend={onSend}
        />,
      );
    });

    expect(runtimeCalls.length).toBeGreaterThanOrEqual(2);
    const secondAdapter = runtimeCalls[1]![0];
    expect(secondAdapter).not.toBe(firstAdapter);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
