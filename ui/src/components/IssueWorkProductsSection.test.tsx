// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueWorkProductsSection } from "./IssueWorkProductsSection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(ui: ReactNode) {
  act(() => {
    root.render(ui);
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function product(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "product-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "Implement work products",
    url: "https://github.com/paperclipai/paperclip/pull/1",
    status: "ready_for_review",
    reviewState: "needs_board_review",
    isPrimary: true,
    healthStatus: "unknown",
    summary: "Connects issue outcomes to a PR.",
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-05-27T10:00:00.000Z"),
    updatedAt: new Date("2026-05-27T10:05:00.000Z"),
    ...overrides,
  };
}

describe("IssueWorkProductsSection", () => {
  it("renders work product outputs with review and primary state", () => {
    render(
      <IssueWorkProductsSection
        products={[product()]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(container.textContent).toContain("Work products");
    expect(container.textContent).toContain("Implement work products");
    expect(container.textContent).toContain("Pull request");
    expect(container.textContent).toContain("github");
    expect(container.textContent).toContain("ready for review");
    expect(container.textContent).toContain("Primary");
    expect(container.textContent).toContain("Review");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://github.com/paperclipai/paperclip/pull/1");
  });

  it("promotes, approves, and confirms deletion through row actions", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const onDelete = vi.fn(async () => undefined);
    render(
      <IssueWorkProductsSection
        products={[product({ id: "product-2", isPrimary: false })]}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Mark primary"]')?.click();
    });
    expect(onUpdate).toHaveBeenCalledWith("product-2", { isPrimary: true });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Approve work product"]')?.click();
    });
    expect(onUpdate).toHaveBeenCalledWith("product-2", { reviewState: "approved", status: "approved" });

    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete work product"]');
    await act(async () => {
      deleteButton?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Confirm delete"]')?.click();
    });
    expect(onDelete).toHaveBeenCalledWith("product-2");
  });

  it("creates a first work product as primary and infers provider from URL", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(
      <IssueWorkProductsSection
        products={[]}
        onCreate={onCreate}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });
    const titleInput = container.querySelector<HTMLInputElement>('input[aria-label="Work product title"]');
    const urlInput = container.querySelector<HTMLInputElement>('input[aria-label="Work product URL"]');
    await act(async () => {
      setInputValue(titleInput!, "Preview deployment");
      setInputValue(urlInput!, "https://paperclip-git-main.vercel.app");
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Add work product")
        ?.click();
    });

    expect(onCreate).toHaveBeenCalledWith({
      type: "preview_url",
      provider: "vercel",
      title: "Preview deployment",
      url: "https://paperclip-git-main.vercel.app",
      status: "active",
      reviewState: "none",
      isPrimary: true,
    });
  });
});
