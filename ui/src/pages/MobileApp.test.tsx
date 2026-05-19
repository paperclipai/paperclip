// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./MobileApp";

const postMobileChatMessageMock = vi.hoisted(() => vi.fn());

vi.mock("@/mobile/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mobile/api")>();
  return {
    ...actual,
    postMobileChatMessage: (text: string) => postMobileChatMessageMock(text),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Mobile ChatPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    postMobileChatMessageMock.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    queryClient.clear();
  });

  it("renders a clean Telegram-style chat surface for talking with Her", async () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        text: "좋아. 막힌 작업부터 확인할게.",
        status: "sent" as const,
        createdAt: "2026-05-16T00:01:00.000Z",
        replyToId: null,
        error: null,
      },
      {
        id: "user-1",
        role: "user" as const,
        text: "헤르, 지금 페퍼 상태 알려줘",
        status: "sent" as const,
        createdAt: "2026-05-16T00:02:00.000Z",
        replyToId: null,
        error: null,
      },
    ];

    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChatPanel messages={messages} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("헤르 채팅");
    expect(container.textContent).toContain("텔레그램처럼 가볍게 요청하고 답변을 확인합니다.");
    expect(container.querySelector('[aria-label="헤르와의 대화 내용"]')).not.toBeNull();
    expect(container.textContent).toContain("헤르");
    expect(container.textContent).toContain("나");
    expect(container.textContent).toContain("좋아. 막힌 작업부터 확인할게.");
    expect(container.textContent).toContain("헤르, 지금 페퍼 상태 알려줘");
    expect(container.querySelector('textarea[placeholder="헤르에게 메시지 보내기"]')).not.toBeNull();
  });
});
