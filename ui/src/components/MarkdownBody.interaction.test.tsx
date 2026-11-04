// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { CoordinatorPresentation } from "./coordinator/CoordinatorPresentation";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: { children: React.ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function renderMarkdown(children: string, coordinator = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  flushSync(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <CoordinatorPresentation.Provider value={coordinator}>
          <MarkdownBody>{children}</MarkdownBody>
          </CoordinatorPresentation.Provider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });

  return container;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  flushSync(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("MarkdownBody code block interactions", () => {
  it("retains unavailable-task handling for compact document links", async () => {
    vi.mocked(issuesApi.get).mockRejectedValueOnce(new ApiError("Not found", 404, null));
    const node = renderMarkdown("[View recommendations](/issues/TES-6#document-recommendations)", true);
    const link = node.querySelector<HTMLAnchorElement>('[data-sidebar-document-link]')!;
    expect(link).toBeTruthy();
    await act(async () => { link.focus(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(node.querySelector('[data-testid="locked-issue-chip"]')).toBeTruthy();
    expect(node.querySelector("a")).toBeNull();
    expect(node.textContent).not.toContain("View recommendations");
  });
  it("toggles line wrapping for indented preformatted markdown blocks", () => {
    const node = renderMarkdown("Plan:\n\n    source fetch/sync -> signal inbox");
    const pre = node.querySelector("pre");
    const wrapButton = node.querySelector<HTMLButtonElement>(".paperclip-markdown-codeblock-wrap");

    expect(pre?.style.whiteSpace).toBe("");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");

    click(wrapButton);

    expect(pre?.style.whiteSpace).toBe("pre-wrap");
    expect(pre?.style.overflowWrap).toBe("anywhere");
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Unwrap lines");

    click(wrapButton);

    expect(pre?.style.whiteSpace).toBe("");
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");
  });
});
