// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { buildIssueWorkProductComment, IssueWorkProductsSection } from "./IssueWorkProductsSection";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalFetch = globalThis.fetch;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

function createWorkProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "document",
    provider: "paperclip",
    externalId: null,
    title: "Execution summary",
    url: null,
    status: "ready_for_review",
    reviewState: "needs_board_review",
    isPrimary: true,
    healthStatus: "healthy",
    summary: "Review the latest markdown output from the assignee.",
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-05-01T02:00:00.000Z"),
    updatedAt: new Date("2026-05-01T02:10:00.000Z"),
    ...overrides,
  };
}

function renderSection(props: {
  workProducts: readonly IssueWorkProduct[];
  onAddComment?: (body: string) => Promise<void>;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <ThemeProvider>
        <IssueWorkProductsSection {...props} />
      </ThemeProvider>,
    );
  });

  return container;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("IssueWorkProductsSection", () => {
  it("builds a contextual issue comment for work product review", () => {
    const comment = buildIssueWorkProductComment(
      { title: "Plan draft", url: "https://example.com/plan.md" },
      "Looks good overall.",
    );

    expect(comment).toBe(
      "**Work product review — Plan draft**\nSource: https://example.com/plan.md\n\nLooks good overall.",
    );
  });

  it("opens an inline review dialog and posts feedback back to the issue", async () => {
    const onAddComment = vi.fn(async () => undefined);
    const host = renderSection({
      workProducts: [createWorkProduct({ metadata: { markdown: "# Review me" }, url: "https://example.com/review.md" })],
      onAddComment,
    });

    const reviewButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Review"),
    );
    expect(reviewButton).toBeTruthy();

    await act(async () => {
      reviewButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Review me");
    expect(document.body.textContent).toContain("Comment back to the issue");

    const textarea = document.body.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "Please tighten the acceptance criteria.");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const postButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Post comment"),
    );
    expect(postButton).toBeTruthy();

    await act(async () => {
      postButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAddComment).toHaveBeenCalledWith(
      "**Work product review — Execution summary**\nSource: https://example.com/review.md\n\nPlease tighten the acceptance criteria.",
    );
  }, 10000);

  it("fetches markdown previews from markdown URLs when inline content is missing", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "# Remote preview",
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const host = renderSection({
      workProducts: [createWorkProduct({ url: "https://example.com/output.md", metadata: null })],
    });

    const reviewButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("View"),
    );
    expect(reviewButton).toBeTruthy();

    await act(async () => {
      reviewButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/output.md");
    expect(document.body.textContent).toContain("Remote preview");
  });

  it("treats .markdown URLs as inline-previewable markdown", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "# Long form markdown",
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const host = renderSection({
      workProducts: [createWorkProduct({ url: "https://example.com/output.markdown", metadata: null })],
    });

    const viewButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("View"),
    );
    expect(viewButton).toBeTruthy();

    await act(async () => {
      viewButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/output.markdown");
    expect(document.body.textContent).toContain("Long form markdown");
  });
});
