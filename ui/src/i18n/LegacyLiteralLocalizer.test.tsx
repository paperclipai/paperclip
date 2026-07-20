// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocale } from ".";
import { LegacyLiteralLocalizer, translateLegacyLiteral } from "./LegacyLiteralLocalizer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushMutations() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("LegacyLiteralLocalizer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await setLocale("zh-CN");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    await setLocale("en");
  });

  it("translates exact literals and preserves dynamic template values", () => {
    expect(translateLegacyLiteral("Advanced Permissions")).toBe("高级权限");
    expect(translateLegacyLiteral("Acting on behalf of Alice")).toBe("代表 Alice 行事");
  });

  it("localizes visible text and accessible attributes while skipping user-authored markdown", async () => {
    await act(async () => {
      root.render(
        <>
          <LegacyLiteralLocalizer />
          <section title="Access profiles">
            <span>Advanced Permissions</span>
            <p>Acting on behalf of Alice</p>
            <div className="paperclip-markdown">Delete</div>
          </section>
        </>,
      );
    });
    await flushMutations();

    expect(container.querySelector("section")?.getAttribute("title")).toBe("访问配置文件");
    expect(container.textContent).toContain("高级权限");
    expect(container.textContent).toContain("代表 Alice 行事");
    expect(container.querySelector(".paperclip-markdown")?.textContent).toBe("Delete");
  });

  it("localizes content inserted after the initial render", async () => {
    await act(async () => root.render(<LegacyLiteralLocalizer />));
    const button = document.createElement("button");
    button.textContent = "Delete";
    button.setAttribute("aria-label", "Delete");
    container.appendChild(button);
    await flushMutations();

    expect(button.textContent).toBe("删除");
    expect(button.getAttribute("aria-label")).toBe("删除");
  });

  it("restores original English text when the locale changes", async () => {
    await act(async () => {
      root.render(
        <>
          <LegacyLiteralLocalizer />
          <button title="Delete">Delete</button>
        </>,
      );
    });
    await flushMutations();
    expect(container.querySelector("button")?.textContent).toBe("删除");

    await act(async () => {
      await setLocale("en");
    });
    await flushMutations();

    expect(container.querySelector("button")?.textContent).toBe("Delete");
    expect(container.querySelector("button")?.getAttribute("title")).toBe("Delete");
  });
});
