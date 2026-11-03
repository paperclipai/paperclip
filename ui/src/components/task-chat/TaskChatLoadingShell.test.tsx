// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { TaskChatLoadingShell } from "./TaskChatLoadingShell";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await i18n.changeLanguage("en"); });
  host.remove();
  vi.unstubAllGlobals();
});

it.each([
  { mobile: false, streamlined: false, coordinator: false },
  { mobile: true, streamlined: true, coordinator: false },
  { mobile: false, streamlined: true, coordinator: true },
])("retranslates the mounted loading announcement while keeping the placeholder inert: %j", async props => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await act(async () => { root.render(<TaskChatLoadingShell {...props} />); });
  const frame = host.querySelector('[data-testid="task-chat-loading-frame"]')!;
  const title = host.querySelector('[data-slot="task-loading-title"]');
  const composer = host.querySelector('[data-testid="task-chat-loading-composer"]')!;
  for (const [locale, label] of [["en", "Loading conversation"], ["ru", "Загружаем беседу…"], ["en", "Loading conversation"]] as const) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(host.querySelector('[role="status"]')).toBe(frame);
    expect(frame.getAttribute("aria-label")).toBe(label);
    expect(host.querySelector('[data-slot="task-loading-title"]')).toBe(title);
    expect(host.querySelector('[data-testid="task-chat-loading-composer"]')).toBe(composer);
    expect(composer.hasAttribute("inert")).toBe(true);
    expect(composer.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("button, input, textarea")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  }
});
