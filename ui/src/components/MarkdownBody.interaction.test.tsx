// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { act as reactAct } from "react";
import { setLocale } from "@/i18n";

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

afterEach(async () => {
  if (root) {
    await reactAct(async () => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  setLocale("en");
});

function renderMarkdown(children: string) {
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
          <MarkdownBody>{children}</MarkdownBody>
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
  it("retranslates code and table controls without changing markdown content or wrap state", async () => {
    let node!: HTMLDivElement;
    await reactAct(async () => { node = renderMarkdown("Raw user prose.\n\n```sh\npnpm dev --host 127.0.0.1\n```\n\n| Raw header | Other |\n| --- | --- |\n| Value | Text |"); });
    const wrapButton = node.querySelector<HTMLButtonElement>(".paperclip-markdown-codeblock-wrap")!;
    await reactAct(async () => wrapButton.click());
    const source = node.querySelector("pre")?.textContent;
    await reactAct(async () => setLocale("ru"));
    expect(node.querySelector("pre")?.textContent).toBe(source);
    expect(node.textContent).toContain("Raw user prose.");
    expect(node.textContent).toContain("Raw header");
    expect(wrapButton.getAttribute("aria-label")).toBe("Отключить перенос строк");
    expect(wrapButton.getAttribute("aria-pressed")).toBe("true");
    expect(node.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("Таблица с прокруткой");
    expect(node.querySelector(".paperclip-markdown-codeblock-copy")?.getAttribute("aria-label")).toBe("Скопировать код");
    await reactAct(async () => setLocale("en"));
    expect(node.querySelector("pre")?.textContent).toBe(source);
    expect(node.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("Scrollable table");
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
