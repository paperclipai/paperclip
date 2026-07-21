// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { CommentThread } from "./CommentThread";

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: () => null,
}));

vi.mock("./ApprovalCard", () => ({
  ApprovalCard: ({ approval }: { approval: Approval }) => <div>{approval.type}</div>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("../api/issues", () => ({
  issuesApi: { get: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CommentThread external object decoration (integration)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("decorates a resolved URL and leaves an unknown URL unchanged when rendered through the real MarkdownBody", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MemoryRouter>
              <CommentThread
                comments={[{
                  id: "comment-mixed",
                  companyId: "company-1",
                  issueId: "issue-1",
                  authorAgentId: null,
                  authorUserId: "user-1",
                  authorType: "user",
                  presentation: null,
                  metadata: null,
                  body: [
                    "Tracked: https://github.com/example/repo/pull/77",
                    "Untracked: https://elsewhere.example.com/page",
                  ].join("\n\n"),
                  createdAt: new Date("2026-04-24T12:00:00.000Z"),
                  updatedAt: new Date("2026-04-24T12:00:00.000Z"),
                }]}
                externalReferences={{
                  "https://github.com/example/repo/pull/77": {
                    providerKey: "github",
                    objectType: "pull_request",
                    statusCategory: "open",
                    liveness: "fresh",
                    statusLabel: "Open",
                    displayTitle: "PR #77",
                  },
                }}
                onAdd={async () => {}}
              />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });

    const resolvedLink = container.querySelector(
      'a[href="https://github.com/example/repo/pull/77"]',
    );
    expect(resolvedLink, "resolved URL should be wrapped by the external-link decorator").not.toBeNull();
    expect(resolvedLink?.getAttribute("data-external-link")).toBe("resolved");
    expect(resolvedLink?.getAttribute("data-external-status")).toBe("open");
    expect(resolvedLink?.classList.contains("paperclip-markdown-external-ref")).toBe(true);

    const unknownLink = container.querySelector(
      'a[href="https://elsewhere.example.com/page"]',
    );
    expect(unknownLink, "unknown URL should still render as a plain link").not.toBeNull();
    expect(unknownLink?.getAttribute("data-external-link")).toBeNull();
    expect(unknownLink?.classList.contains("paperclip-markdown-external-ref")).toBe(false);

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
