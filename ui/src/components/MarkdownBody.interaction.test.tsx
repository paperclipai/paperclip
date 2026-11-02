// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { act as reactAct } from "react";
import { setLocale } from "@/i18n";

const markdownRender = vi.hoisted(() => vi.fn());
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (props: React.ComponentProps<typeof actual.default>) => {
      markdownRender(props);
      return <actual.default {...props} />;
    },
  };
});

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
  markdownRender.mockClear();
});

function renderMarkdown(children: string, props: Partial<React.ComponentProps<typeof MarkdownBody>> = {}) {
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
          <MarkdownBody {...props}>{children}</MarkdownBody>
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
  it.each(["render", "reference"] as const)("retranslates %s-mode controls without re-rendering markdown or losing DOM and wrap state", async (mediaMode) => {
    let node!: HTMLDivElement;
    await reactAct(async () => { node = renderMarkdown("Raw user prose.\n\n```sh\npnpm dev --host 127.0.0.1\n```\n\n| Raw header | Other |\n| --- | --- |\n| Value | Text |\n\n![User-owned alt](https://example.test/raw-image.png \"User-owned title\")\n\n![](https://example.test/untitled.png)", { mediaMode }); });
    const wrapButton = node.querySelector<HTMLButtonElement>(".paperclip-markdown-codeblock-wrap")!;
    await reactAct(async () => wrapButton.click());
    const pre = node.querySelector("pre")!;
    const code = node.querySelector("pre code")!;
    const table = node.querySelector('[role="region"]')!;
    const copyButton = node.querySelector(".paperclip-markdown-codeblock-copy")!;
    const imageReferences = [...node.querySelectorAll("[data-markdown-image-reference]")];
    const source = pre.textContent;
    const initialMarkdownRenders = markdownRender.mock.calls.length;
    pre.scrollTop = 27;
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    for (const locale of ["ru", "en", "ru", "en"] as const) {
      await reactAct(async () => setLocale(locale));
      expect(node.querySelector("pre")).toBe(pre);
      expect(node.querySelector("pre code")).toBe(code);
      expect(node.querySelector('[role="region"]')).toBe(table);
      expect(node.querySelector(".paperclip-markdown-codeblock-wrap")).toBe(wrapButton);
      expect(node.querySelector(".paperclip-markdown-codeblock-copy")).toBe(copyButton);
      expect(pre.textContent).toBe(source);
      expect(pre.style.whiteSpace).toBe("pre-wrap");
      expect(pre.scrollTop).toBe(27);
      expect(selection.toString()).toBe(source);
      expect(node.textContent).toContain("Raw user prose.");
      expect(node.textContent).toContain("Raw header");
      const wrapLabel = locale === "ru" ? "Отключить перенос строк" : "Unwrap lines";
      expect(wrapButton.getAttribute("aria-label")).toBe(wrapLabel);
      expect(wrapButton.getAttribute("title")).toBe(wrapLabel);
      expect(wrapButton.getAttribute("aria-pressed")).toBe("true");
      expect(table.getAttribute("aria-label")).toBe(locale === "ru" ? "Таблица с прокруткой" : "Scrollable table");
      expect(copyButton.getAttribute("aria-label")).toBe(locale === "ru" ? "Скопировать код" : "Copy code");
      if (mediaMode === "reference") {
        const currentReferences = node.querySelectorAll("[data-markdown-image-reference]");
        expect(currentReferences[0]).toBe(imageReferences[0]);
        expect(currentReferences[1]).toBe(imageReferences[1]);
        expect(currentReferences[0]?.textContent).toBe(`${locale === "ru" ? "Изображение" : "Image"}: User-owned alt (https://example.test/raw-image.png)`);
        expect(currentReferences[0]?.getAttribute("title")).toBe("User-owned title");
        expect(currentReferences[1]?.textContent).toBe(locale === "ru"
          ? "Изображение: Изображение без названия (https://example.test/untitled.png)"
          : "Image: Untitled image (https://example.test/untitled.png)");
        expect(node.querySelector("img")).toBeNull();
      } else {
        expect(node.querySelector("img")?.getAttribute("alt")).toBe("User-owned alt");
        expect(node.querySelector("img")?.getAttribute("src")).toBe("https://example.test/raw-image.png");
      }
      // Only chrome subscribes to locale changes, not the markdown renderer or
      // its components/remarkPlugins objects. Keep parsing and component types stable.
      expect(markdownRender).toHaveBeenCalledTimes(initialMarkdownRenders);
    }
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
