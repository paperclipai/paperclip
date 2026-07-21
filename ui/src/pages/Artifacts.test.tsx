// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifacts } from "./Artifacts";
import type { CompanyArtifact, CompanyArtifactGroup } from "../api/artifacts";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const artifactsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("../api/artifacts", () => ({
  artifactsApi: artifactsApiMock,
}));

// Render the menu inline (no radix portal / pointer-capture) so option clicks
// are deterministic in jsdom.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("../components/artifacts/ArtifactCard", () => ({
  ArtifactCard: ({ artifact }: { artifact: CompanyArtifact }) => (
    <article data-testid="artifact-card">{artifact.title}</article>
  ),
  ArtifactPreview: ({ artifact }: { artifact: CompanyArtifact }) => (
    <div data-testid="artifact-preview">{artifact.title}</div>
  ),
}));

type ObserverCallback = IntersectionObserverCallback;

let latestObserverCallback: ObserverCallback | null = null;

class MockIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];

  constructor(callback: ObserverCallback) {
    latestObserverCallback = callback;
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

function sampleArtifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "artifact-1",
    source: "document",
    mediaKind: "document",
    title: "Launch Brief",
    previewText: "launch brief preview",
    contentType: "text/markdown",
    contentPath: null,
    openPath: null,
    downloadPath: null,
    issue: { id: "issue-1", identifier: "PAP-42", title: "Ship launch" },
    project: null,
    createdByAgent: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
    href: "/PAP/issues/PAP-42#document-brief",
    ...overrides,
  };
}

function sampleGroup(overrides: Partial<CompanyArtifactGroup> = {}): CompanyArtifactGroup {
  return {
    id: "task:issue-1",
    groupBy: "task",
    issue: { id: "issue-1", identifier: "PAP-42", title: "Ship launch" },
    title: "Ship launch",
    count: 3,
    mediaKinds: ["document"],
    previewArtifacts: [sampleArtifact()],
    updatedAt: "2026-06-01T00:00:00.000Z",
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-1",
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderArtifacts(container: HTMLDivElement, initialEntries: string[] = ["/artifacts"]) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <Artifacts />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("Artifacts page", () => {
  let container: HTMLDivElement;
  let originalIntersectionObserver: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    artifactsApiMock.list.mockReset();
    latestObserverCallback = null;
    originalIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    window.IntersectionObserver = originalIntersectionObserver as typeof IntersectionObserver;
    container.remove();
  });

  it("requests task-grouped artifact stacks by default", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], groups: [sampleGroup()], nextCursor: null });

    const { root } = renderArtifacts(container);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "task",
        groupIssueId: undefined,
        limit: 30,
        cursor: undefined,
      });
      const groupControl = container.querySelector('[data-testid="artifact-group-control"]') as HTMLButtonElement;
      const allFilter = [...container.querySelectorAll('[role="tab"]')]
        .find((element) => element.textContent === "All") as HTMLButtonElement;
      expect(groupControl).not.toBeNull();
      expect(groupControl.textContent).toBe("");
      expect(groupControl.getAttribute("data-variant")).toBe("outline");
      expect(groupControl.getAttribute("data-size")).toBe("icon");
      expect(groupControl.getAttribute("data-group-by")).toBe("task");
      expect(Boolean(groupControl.compareDocumentPosition(allFilter) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("debounces artifact search into the artifacts API", async () => {
    artifactsApiMock.list
      .mockResolvedValueOnce({ artifacts: [], groups: [sampleGroup()], nextCursor: null })
      .mockResolvedValueOnce({ artifacts: [], groups: [], nextCursor: null });

    const { root } = renderArtifacts(container);

    const input = container.querySelector('input[aria-label="Search artifacts"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "launch");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", {
        kind: "all",
        q: "launch",
        groupBy: "task",
        groupIssueId: undefined,
        limit: 30,
        cursor: undefined,
      });
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("keeps the artifacts grid max-width constrained and left aligned", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [sampleArtifact()], nextCursor: null });

    const { root } = renderArtifacts(container, ["/artifacts?groupBy=none"]);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="artifact-card"]')).not.toBeNull();
    });

    const pageShell = container.firstElementChild as HTMLElement | null;
    expect(pageShell?.className).toContain("max-w-6xl");
    expect(pageShell?.className).not.toContain("mx-auto");

    flushSync(() => {
      root.unmount();
    });
  });

  it("fetches the next artifact page when the sentinel intersects", async () => {
    artifactsApiMock.list
      .mockResolvedValueOnce({
        artifacts: [sampleArtifact({ id: "artifact-1", title: "First Artifact" })],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        artifacts: [sampleArtifact({ id: "artifact-2", title: "Second Artifact" })],
        nextCursor: null,
      });

    const { root } = renderArtifacts(container, ["/artifacts?groupBy=none"]);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("First Artifact");
      expect(latestObserverCallback).not.toBeNull();
    });

    latestObserverCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "none",
        groupIssueId: undefined,
        limit: 30,
        cursor: "cursor-2",
      });
      expect(container.textContent).toContain("Second Artifact");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("switches grouping via the group control and refetches stacks", async () => {
    artifactsApiMock.list.mockImplementation((_companyId: string, params?: { groupBy?: string }) => {
      if (params?.groupBy === "none") {
        return Promise.resolve({ artifacts: [sampleArtifact()], nextCursor: null });
      }
      return Promise.resolve({ artifacts: [], groups: [sampleGroup()], nextCursor: null });
    });

    const { root } = renderArtifacts(container);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="artifact-group-card"]')).not.toBeNull();
    });

    const noneOption = container.querySelector(
      '[data-testid="artifact-group-option-none"]',
    ) as HTMLButtonElement;
    expect(noneOption).not.toBeNull();

    flushSync(() => {
      noneOption.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "none",
        groupIssueId: undefined,
        limit: 30,
        cursor: undefined,
      });
      expect(container.querySelector('[data-testid="artifact-card"]')).not.toBeNull();
      const groupControl = container.querySelector('[data-testid="artifact-group-control"]') as HTMLElement;
      expect(groupControl.getAttribute("data-group-by")).toBe("none");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders stack cards from a grouped URL with count metadata", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [],
      groups: [sampleGroup({ count: 4 })],
      nextCursor: null,
    });

    const { root } = renderArtifacts(container, ["/artifacts?groupBy=task"]);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "task",
        groupIssueId: undefined,
        limit: 30,
        cursor: undefined,
      });
      const card = container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
      expect(card).not.toBeNull();
      expect(card.getAttribute("data-count")).toBe("4");
      expect(card.getAttribute("data-stacked")).toBe("true");
      expect(card.getAttribute("href")).toBe("/artifacts?groupIssueId=issue-1");
      expect(card.textContent).toContain("4 artifacts");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("opens a stack from the URL and shows the back affordance and artifacts", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [sampleArtifact({ title: "Stacked Artifact" })],
      selectedGroup: sampleGroup(),
      nextCursor: null,
    });

    const { root } = renderArtifacts(container, [
      "/artifacts?groupBy=task&groupIssueId=issue-1",
    ]);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "task",
        groupIssueId: "issue-1",
        limit: 30,
        cursor: undefined,
      });
      expect(container.querySelector('[data-testid="artifact-stack-back"]')).not.toBeNull();
      expect(
        (container.querySelector('[data-testid="artifact-stack-back"]') as HTMLAnchorElement).getAttribute("href"),
      ).toBe("/artifacts");
      expect(container.textContent).toContain("Stacked Artifact");
      expect(container.querySelector('[data-testid="artifact-card"]')).not.toBeNull();
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("preserves the media filter when grouping", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [],
      groups: [sampleGroup()],
      nextCursor: null,
    });

    const { root } = renderArtifacts(container, ["/artifacts?kind=image&groupBy=task"]);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "image",
        q: undefined,
        groupBy: "task",
        groupIssueId: undefined,
        limit: 30,
        cursor: undefined,
      });
    });

    flushSync(() => {
      root.unmount();
    });
  });
});
