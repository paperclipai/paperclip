// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueFavourite } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FavouriteButton } from "./FavouriteButton";

const mockIssueFavouritesApi = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/issueFavourites", () => ({
  issueFavouritesApi: mockIssueFavouritesApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForCondition(predicate: () => boolean, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await flushReact();
  }
  throw new Error("Condition not met within allotted flushes");
}

function makeFavourite(issueId: string): IssueFavourite {
  const issue = {
    id: issueId,
    companyId: "company-1",
    title: "Favourite me",
    identifier: "PAP-1",
    status: "todo",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as Issue;

  return {
    id: `fav-${issueId}`,
    companyId: "company-1",
    issueId,
    userId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    issue,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderButton(issueId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <FavouriteButton issueId={issueId} />
    </QueryClientProvider>
  );
  act(() => {
    root.render(tree);
  });
}

function starButton(): HTMLButtonElement {
  const button = container.querySelector("button");
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

describe("FavouriteButton", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockIssueFavouritesApi.list.mockReset();
    mockIssueFavouritesApi.add.mockReset();
    mockIssueFavouritesApi.remove.mockReset();
    mockPushToast.mockReset();
    mockIssueFavouritesApi.add.mockResolvedValue(makeFavourite("issue-1"));
    mockIssueFavouritesApi.remove.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("adds a favourite when the task is not yet favourited", async () => {
    mockIssueFavouritesApi.list.mockResolvedValue([]);
    renderButton("issue-1");
    await flushReact();

    const button = starButton();
    expect(button.getAttribute("aria-pressed")).toBe("false");

    await act(() => button.click());
    await flushReact();

    expect(mockIssueFavouritesApi.add).toHaveBeenCalledWith("company-1", "issue-1");
    expect(mockIssueFavouritesApi.remove).not.toHaveBeenCalled();
  });

  it("removes a favourite when the task is already favourited", async () => {
    mockIssueFavouritesApi.list.mockResolvedValue([makeFavourite("issue-1")]);
    renderButton("issue-1");
    await waitForCondition(() => starButton().getAttribute("aria-pressed") === "true");

    const button = starButton();
    expect(button.getAttribute("aria-pressed")).toBe("true");

    await act(() => button.click());
    await flushReact();

    expect(mockIssueFavouritesApi.remove).toHaveBeenCalledWith("company-1", "issue-1");
    expect(mockIssueFavouritesApi.add).not.toHaveBeenCalled();
  });

  it("prevents row navigation handlers when toggled inside a clickable row", async () => {
    mockIssueFavouritesApi.list.mockResolvedValue([]);
    const rowClick = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <div onClick={rowClick}>
            <FavouriteButton issueId="issue-1" />
          </div>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const button = starButton();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    await flushReact();

    expect(event.defaultPrevented).toBe(true);
    expect(rowClick).not.toHaveBeenCalled();
    expect(mockIssueFavouritesApi.add).toHaveBeenCalledWith("company-1", "issue-1");
  });
});
