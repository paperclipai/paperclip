// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueCustomFieldsSection } from "./IssueCustomFieldsSection";
import type { IssueCustomField } from "../api/issues";

const mockIssuesApi = vi.hoisted(() => ({
  listCustomFields: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeField(overrides: Partial<IssueCustomField> = {}): IssueCustomField {
  return {
    pluginId: "plugin-a",
    pluginKey: "example.plugin",
    pluginDisplayName: "Example Plugin",
    key: "score",
    type: "text",
    label: "Score",
    valueText: "42",
    valueNumber: null,
    ...overrides,
  };
}

function renderComponent(issueId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IssueCustomFieldsSection issueId={issueId} />
      </QueryClientProvider>,
    );
  });
  return { container, root, queryClient };
}

describe("IssueCustomFieldsSection", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders nothing while loading", async () => {
    mockIssuesApi.listCustomFields.mockReturnValue(new Promise(() => {})); // never resolves
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when no fields returned", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({ customFields: [] });
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    expect(container.textContent).toBe("");
  });

  it("renders plugin display name as section header (anti-spoofing: identity is visible)", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({
      customFields: [makeField({ pluginDisplayName: "Workstream Tracker" })],
    });
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Workstream Tracker");
  });

  it("renders field label and value", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({
      customFields: [makeField({ label: "Priority Score", valueText: "high" })],
    });
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Priority Score");
    expect(container.textContent).toContain("high");
  });

  it("renders URL fields as anchor links (safe URLs)", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({
      customFields: [
        makeField({
          type: "url",
          label: "Docs",
          key: "docs",
          valueText: "https://example.com/docs",
        }),
      ],
    });
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.href).toBe("https://example.com/docs");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it("does NOT render javascript: URL as a clickable link (XSS prevention)", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({
      customFields: [
        makeField({
          type: "url",
          label: "Evil",
          key: "evil",
          valueText: "javascript:alert(document.cookie)",
        }),
      ],
    });
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    // No anchor element should be rendered for a javascript: URL
    const anchor = container.querySelector("a");
    expect(anchor).toBeNull();
    // The raw text is shown (not an active link)
    expect(container.textContent).toContain("javascript:alert(document.cookie)");
  });

  it("does NOT render data: URL as a clickable link (XSS prevention)", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({
      customFields: [
        makeField({
          type: "url",
          label: "Data",
          key: "data",
          valueText: "data:text/html,<script>alert(1)</script>",
        }),
      ],
    });
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    const anchor = container.querySelector("a");
    expect(anchor).toBeNull();
  });

  it("renders number fields using valueNumber when available", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({
      customFields: [
        makeField({
          type: "number",
          label: "Count",
          key: "count",
          valueText: "3.14",
          valueNumber: 3.14,
        }),
      ],
    });
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("3.14");
  });

  it("groups fields from multiple plugins under separate headers", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({
      customFields: [
        makeField({ pluginId: "plugin-a", pluginDisplayName: "Plugin Alpha", key: "f1" }),
        makeField({ pluginId: "plugin-b", pluginDisplayName: "Plugin Beta", key: "f2" }),
      ],
    });
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Plugin Alpha");
    expect(container.textContent).toContain("Plugin Beta");
  });

  it("shows error message when API call fails", async () => {
    mockIssuesApi.listCustomFields.mockRejectedValue(new Error("Network error"));
    ({ container, root, queryClient } = renderComponent("issue-1"));
    await flushReact();
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Plugin custom fields unavailable");
  });

  it("calls API with correct issueId", async () => {
    mockIssuesApi.listCustomFields.mockResolvedValue({ customFields: [] });
    ({ container, root, queryClient } = renderComponent("issue-xyz-123"));
    await flushReact();
    await flushReact();
    expect(mockIssuesApi.listCustomFields).toHaveBeenCalledWith("issue-xyz-123");
  });
});
