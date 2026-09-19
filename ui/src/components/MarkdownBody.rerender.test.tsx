// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act as reactAct } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";

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
  vi.useRealTimers();
  if (root) {
    flushSync(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  if (typeof reactAct === "function") {
    return await (reactAct(callback) as T | Promise<T>);
  }

  let result: T | Promise<T> | undefined;
  flushSync(() => {
    result = callback();
  });
  const resolved = await result;
  await Promise.resolve();
  flushSync(() => {});
  return resolved as T;
}

const SAMPLE = "Some text\n\n```ts\nconst answer = 42;\n```\n\nAnd a [link](https://example.com).";

function tree(children: string, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MarkdownBody>{children}</MarkdownBody>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function IssueDetailPollingHarness({
  loadContent,
  loadRuns,
}: {
  loadContent: () => Promise<{
    description: string;
    comment: string;
    document: string;
    refresh: number;
  }>;
  loadRuns: () => Promise<{ refresh: number }>;
}) {
  const { data: content } = useQuery({
    queryKey: ["selection-stability", "content"],
    queryFn: loadContent,
  });
  useQuery({
    queryKey: ["selection-stability", "runs"],
    queryFn: loadRuns,
    refetchInterval: 5_000,
  });

  if (!content) return null;

  return (
    <main>
      <section data-testid="issue-description">
        <MarkdownBody>{content.description}</MarkdownBody>
      </section>
      <section data-testid="issue-comment">
        <MarkdownBody>{content.comment}</MarkdownBody>
      </section>
      <section data-testid="issue-document">
        <MarkdownBody>{content.document}</MarkdownBody>
      </section>
    </main>
  );
}

async function flushQueries() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("MarkdownBody re-render stability (PAP-10767)", () => {
  it("preserves rendered DOM nodes across a parent re-render with unchanged props", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => root?.render(tree(SAMPLE, queryClient)));

    const preBefore = container.querySelector("pre");
    const codeBefore = container.querySelector("pre code");
    const anchorBefore = container.querySelector("a");
    expect(preBefore).not.toBeNull();
    expect(codeBefore).not.toBeNull();
    expect(anchorBefore).not.toBeNull();

    // Re-render the identical tree. Before the memoization fix, MarkdownBody
    // rebuilt its react-markdown `components` map on every render, giving each
    // custom element (pre/code/a/...) a brand-new component *type* — which made
    // React unmount and remount the whole subtree, discarding scroll position
    // and text selection and producing the visible flashing in the file viewer.
    flushSync(() => root?.render(tree(SAMPLE, queryClient)));

    const preAfter = container.querySelector("pre");
    const codeAfter = container.querySelector("pre code");
    const anchorAfter = container.querySelector("a");

    // Same DOM node instances ⇒ React updated in place rather than remounting.
    expect(preAfter).toBe(preBefore);
    expect(codeAfter).toBe(codeBefore);
    expect(anchorAfter).toBe(anchorBefore);
  });

  it("preserves text selection across a parent re-render with unchanged props", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => root?.render(tree(SAMPLE, queryClient)));

    const paragraph = container.querySelector("p");
    const textNode = paragraph?.firstChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);

    const range = document.createRange();
    range.setStart(textNode!, 0);
    range.setEnd(textNode!, "Some text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe("Some text");

    flushSync(() => root?.render(tree(SAMPLE, queryClient)));

    expect(window.getSelection()?.toString()).toBe("Some text");
  });

  it("preserves issue text nodes through polling cycles and query invalidation", async () => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let contentRefresh = 0;
    let runsRefresh = 0;
    const loadContent = vi.fn(async () => ({
      description: "Stable issue description",
      comment: "Stable issue comment",
      document: "Stable issue document",
      refresh: contentRefresh++,
    }));
    const loadRuns = vi.fn(async () => ({ refresh: runsRefresh++ }));
    queryClient.setQueryData(["selection-stability", "content"], {
      description: "Stable issue description",
      comment: "Stable issue comment",
      document: "Stable issue document",
      refresh: -1,
    });
    queryClient.setQueryData(["selection-stability", "runs"], { refresh: -1 });

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <IssueDetailPollingHarness loadContent={loadContent} loadRuns={loadRuns} />
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    const descriptionNode = container.querySelector('[data-testid="issue-description"] p')?.firstChild;
    const commentNode = container.querySelector('[data-testid="issue-comment"] p')?.firstChild;
    const documentNode = container.querySelector('[data-testid="issue-document"] p')?.firstChild;
    expect(descriptionNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(commentNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(documentNode?.nodeType).toBe(Node.TEXT_NODE);

    const range = document.createRange();
    range.setStart(documentNode!, 0);
    range.setEnd(documentNode!, "Stable issue document".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(loadRuns).toHaveBeenCalledTimes(7);
    expect(selection?.toString()).toBe("Stable issue document");

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["selection-stability", "content"] });
    });
    await flushQueries();

    expect(container.querySelector('[data-testid="issue-description"] p')?.firstChild).toBe(descriptionNode);
    expect(container.querySelector('[data-testid="issue-comment"] p')?.firstChild).toBe(commentNode);
    expect(container.querySelector('[data-testid="issue-document"] p')?.firstChild).toBe(documentNode);
    expect(selection?.toString()).toBe("Stable issue document");
    expect(loadContent).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
