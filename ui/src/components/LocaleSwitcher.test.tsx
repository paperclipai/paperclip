import { act, useEffect, useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinEnvironments } from "vitest/runtime";
import type { Root } from "react-dom/client";

let teardown: (() => Promise<void> | void) | undefined;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  if (typeof document === "undefined") {
    const environment = await builtinEnvironments.jsdom.setup(globalThis, {});
    teardown = async () => { await environment.teardown(globalThis); };
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

beforeEach(async () => {
  const { i18n } = await import("../i18n");
  await i18n.changeLanguage("en");
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await teardown?.();
});

describe("LocaleSwitcher", () => {
  it("supports the sidebar account row geometry without a surrounding provider", async () => {
    const { LocaleSwitcher } = await import("./LocaleSwitcher");
    await act(() => root.render(<LocaleSwitcher variant="compact-menu-action" className="locale-test" />));
    const label = container.querySelector("label")!;
    expect(label.classList.contains("h-(--profile-popover-row-height)")).toBe(true);
    expect(label.classList.contains("locale-test")).toBe(true);
    expect(container.querySelector("select")!.disabled).toBe(false);
  });
  it("switches live hook and Trans copy without remounting or losing a form draft", async () => {
    const { LocaleSwitcher } = await import("./LocaleSwitcher");
    const { i18n, useTranslation, Trans } = await import("../i18n");
    await i18n.changeLanguage("en");
    i18n.addResourceBundle("en", "switcher-test", { count: "Count {{count}}", rich: "Read <strong>carefully</strong>" });
    i18n.addResourceBundle("zh-CN", "switcher-test", { count: "计数 {{count}}", rich: "请<strong>仔细</strong>阅读" });
    let mounts = 0;
    let unmounts = 0;

    function Editor() {
      const { t } = useTranslation("switcher-test");
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounts += 1;
        return () => { unmounts += 1; };
      }, []);
      return (
        <form>
          <input aria-label="Draft" defaultValue="" />
          <button type="button" onClick={() => setCount((value) => value + 1)}>{t("count", { count })}</button>
          <p><Trans ns="switcher-test" i18nKey="rich" components={{ strong: <strong /> }} /></p>
          <LocaleSwitcher />
        </form>
      );
    }

    await act(() => root.render(<Editor />));
    const draft = container.querySelector("input")!;
    draft.value = "Unsaved draft";
    await act(() => container.querySelector("button")!.click());
    const select = container.querySelector("select")!;
    const url = window.location.href;
    const historyLength = window.history.length;
    select.value = "zh-CN";
    await act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(container.querySelector("button")!.textContent).toBe("计数 1");
    expect(container.querySelector("p")!.textContent).toBe("请仔细阅读");
    expect(container.querySelector("strong")!.textContent).toBe("仔细");
    expect(container.querySelector("input")).toBe(draft);
    expect(draft.value).toBe("Unsaved draft");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(select.value).toBe("zh-CN");
    expect(select.labels?.[0]?.querySelector("span")?.textContent).toBe("语言");
    expect(localStorage.getItem("paperclip.locale")).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.location.href).toBe(url);
    expect(window.history.length).toBe(historyLength);
    select.value = "en";
    await act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(container.querySelector("button")!.textContent).toBe("Count 1");
    expect(draft.value).toBe("Unsaved draft");
    expect(mounts).toBe(1);
  });
  it("updates mounted controls when another consumer changes the locale", async () => {
    const { LocaleSwitcher } = await import("./LocaleSwitcher");
    const { i18n } = await import("../i18n");
    await act(() => root.render(<><LocaleSwitcher /><LocaleSwitcher /></>));
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(Array.from(container.querySelectorAll("select"), (select) => select.value)).toEqual(["zh-CN", "zh-CN"]);
  });

  it("remains usable when browser storage rejects writes", async () => {
    const { LocaleSwitcher } = await import("./LocaleSwitcher");
    await act(() => root.render(<LocaleSwitcher />));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    const select = container.querySelector("select")!;
    select.value = "zh-CN";
    await act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(select.value).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("offers only English and Simplified Chinese with a visible accessible label", async () => {
    const { LocaleSwitcher } = await import("./LocaleSwitcher");
    await act(() => root.render(<LocaleSwitcher />));
    const select = container.querySelector("select")!;
    expect(select).not.toBeNull();
    expect(select.labels?.[0]?.querySelector("span")?.textContent).toBe("Language");
    expect(select.value).toBe("en");
    expect(Array.from(select.options, (option) => [option.value, option.textContent, option.lang])).toEqual([
      ["en", "English", "en"],
      ["zh-CN", "简体中文", "zh-CN"],
    ]);
  });
});
