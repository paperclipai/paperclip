// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedStartupLocales } from "./vite-startup-localization";
import en from "../i18n/locales/en.json";

const template = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");

function mount(html = embedStartupLocales(template)) {
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
  const script = [...document.querySelectorAll("script")].find((node) => node.textContent?.includes("const translations ="));
  if (!script) throw new Error("Missing startup recovery script");
  new Function(script.textContent ?? "")();
}

function failImport() {
  document.querySelector('script[type="module"]')!.dispatchEvent(new Event("error"));
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US"]);
  vi.spyOn(window.navigator, "language", "get").mockReturnValue("en-US");
});
afterEach(() => {
  document.getElementById("root")?.appendChild(document.createElement("div"));
  failImport();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.body.innerHTML = "";
});

describe("inline startup localization", () => {
  it("uses persisted Russian on module failure without displaying the raw error", () => {
    window.localStorage.setItem("paperclip.locale", "ru-RU");
    mount();
    failImport();
    expect(document.getElementById("paperclip-startup")?.hidden).toBe(false);
    expect(document.getElementById("paperclip-startup-title")?.textContent).toBe("Не удалось запустить Paperclip");
    expect(document.getElementById("paperclip-startup-reload")?.textContent).toBe("Перезагрузить страницу");
    expect(document.documentElement.lang).toBe("ru");
  });
  it("prefers a supported stored locale to browser language", () => {
    window.localStorage.setItem("paperclip.locale", "en");
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["ru"]);
    mount();
    failImport();
    expect(document.getElementById("paperclip-startup-title")?.textContent).toBe(en.sep28Core.startupFailedTitle);
  });
  it("uses browser Russian if storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["fr-FR", "ru_RU"]);
    mount();
    vi.advanceTimersByTime(30_000);
    expect(document.getElementById("paperclip-startup-title")?.textContent).toBe("Paperclip загружается дольше обычного");
  });
  it("falls back to English for unsupported locales", () => {
    window.localStorage.setItem("paperclip.locale", "not-registered");
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["zz"]);
    mount();
    vi.advanceTimersByTime(30_000);
    expect(document.getElementById("paperclip-startup-title")?.textContent).toBe(en.sep28Core.startupSlowTitle);
  });
  it("does not show recovery after the application mounts", async () => {
    mount();
    document.getElementById("root")!.appendChild(document.createElement("main"));
    await Promise.resolve();
    expect(document.getElementById("paperclip-startup")).toBeNull();
    failImport();
    vi.advanceTimersByTime(30_000);
    expect(document.getElementById("paperclip-startup")).toBeNull();
  });
  it("keeps the original English recovery without the build transform", () => {
    mount(template);
    failImport();
    expect(document.getElementById("paperclip-startup-title")?.textContent).toBe(en.sep28Core.startupFailedTitle);
  });
  it("embeds registered catalogs safely, without script or replacement-string injection", () => {
    const attack = '</script><img src=x onerror=alert(1)> $& \u2028\u2029';
    const html = embedStartupLocales(template, { en, ru: { sep28Core: { ...en.sep28Core, startupFailedTitle: attack } } });
    expect(html).not.toContain('</script><img');
    window.localStorage.setItem("paperclip.locale", "ru");
    mount(html);
    failImport();
    expect(document.getElementById("paperclip-startup-title")?.textContent).toBe(attack);
    expect(document.querySelector("img")).toBeNull();
  });
  it("refuses missing registered translations", () => {
    expect(() => embedStartupLocales(template, { en, xx: {} })).toThrow("Missing startup translation");
    mount();
  });
});
