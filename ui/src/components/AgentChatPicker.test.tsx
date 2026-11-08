// @vitest-environment jsdom
import { act } from "react";
import { i18n } from "@/i18n";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { appearanceForPalette } from "@paperclipai/shared";
import { AgentChatPicker, type AgentChatPickerProps } from "./AgentChatPicker";

const agents = [
  { id: "first", name: "Alex", title: "Engineering Lead", role: "engineer", icon: "code", status: "idle" },
  { id: "second", name: "Alex", title: "Product Designer", role: "designer", icon: "palette", status: "paused" },
] as Agent[];

let root: Root;
let container: HTMLDivElement;
let props: AgentChatPickerProps;
async function render(overrides: Partial<AgentChatPickerProps> = {}) {
  props = { ...props, ...overrides };
  await act(async () => { root.render(<AgentChatPicker {...props} />); });
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>("[role=combobox]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = { agents, open: true, onOpenChange: vi.fn(), onSelect: vi.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

describe("AgentChatPicker", () => {
  it("updates singular and plural unread labels in an open picker when the locale changes", async () => {
    await render({ existingChatAgentIds: ["first", "second"], unreadMessageCounts: new Map([["first", 1], ["second", 12]]) });
    expect(options()[0].querySelector('[aria-label="1 unread message from Alex"]')?.textContent).toBe("1");
    expect(options()[1].querySelector('[aria-label="12 unread messages from Alex"]')?.textContent).toBe("12");
    const input = document.querySelector<HTMLInputElement>("[role=combobox]")!;
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(document.querySelector("[role=combobox]")).toBe(input);
    expect(options()[0].querySelector('[aria-label="来自 Alex 的 1 条未读消息"]')?.textContent).toBe("1");
    expect(options()[1].querySelector('[aria-label="来自 Alex 的 12 条未读消息"]')?.textContent).toBe("12");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(options()[0].querySelector('[aria-label="1 unread message from Alex"]')?.textContent).toBe("1");
    expect(options()[1].querySelector('[aria-label="12 unread messages from Alex"]')?.textContent).toBe("12");
  });

  it("shows unread per agent through search and clears it when read state updates", async () => {
    await render({ existingChatAgentIds: ["first", "second"], unreadMessageCounts: new Map([["first", 0], ["second", 12]]) });
    expect(options()[0].querySelector('[aria-label*="unread message"]')).toBeNull();
    expect(options()[1].querySelector('[aria-label="12 unread messages from Alex"]')?.textContent).toBe("12");
    await search("designer");
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("12");
    await render({ unreadMessageCounts: new Map([["second", 0]]) });
    expect(options()[0].textContent).not.toContain("12");
    expect(options()[0].textContent).toContain("Open chat");
  });

  it("uses indexed counts and memoized chat membership for a large team", async () => {
    const roster = Array.from({ length: 500 }, (_, index) => ({ ...agents[index % 2], id: `agent-${index}`, name: `Agent ${index}` }));
    let visits = 0;
    const ids = roster.map(agent => agent.id);
    const boundedIds = new Proxy(ids, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key) && ++visits > ids.length * 2) throw new Error("Repeated chat membership scan");
      return Reflect.get(target, key, receiver);
    } });
    const counts = new Map(ids.map(id => [id, 7]));
    const getCount = vi.spyOn(counts, "get");
    await render({ agents: roster, existingChatAgentIds: boundedIds, unreadMessageCounts: counts });
    expect(options()).toHaveLength(500);
    expect(document.querySelectorAll('[aria-label^="7 unread messages from"]')).toHaveLength(500);
    expect(visits).toBe(500);
    expect(getCount).toHaveBeenCalledTimes(500);
    await search("Agent 499");
    expect(options().length).toBeLessThan(500);
    expect(options().some(option => option.textContent?.includes("Agent 499"))).toBe(true);
    expect(visits).toBe(500);
    expect(getCount).toHaveBeenCalledTimes(1000);
  });

  it("shows saved custom avatars and default avatars in agent choices", async () => {
    await render({ agents: [
      { ...agents[0], appearance: { ...appearanceForPalette("deep-tide"), customAvatarAssetId: "22222222-2222-4222-8222-222222222222" } },
      agents[1],
    ] });
    const customImage = options()[0].querySelector("img");
    expect(customImage?.getAttribute("src")).toBe("/api/assets/22222222-2222-4222-8222-222222222222/content");
    expect(customImage?.getAttribute("width")).toBe("32");
    expect(options()[1].querySelector("img")?.getAttribute("src")).toMatch(/^\/api\/agent-avatars\/cap-v1\//);
  });

  it("lets a custom renderer replace the default avatar", async () => {
    await render({ renderAgentIcon: agent => <span>{agent.title} marker</span> });
    expect(options()[0].textContent).toContain("Engineering Lead marker");
    expect(options()[1].textContent).toContain("Product Designer marker");
    expect(options().flatMap(option => [...option.querySelectorAll("img")])).toHaveLength(0);
  });

  it("does not close a reopened picker when an earlier selection finishes", async () => {
    let finish!: () => void;
    await render({ onSelect: () => new Promise<void>(resolve => { finish = resolve; }) });
    await act(async () => options()[0].click());
    await render({ open: false });
    await render({ open: true });
    await search("designer");
    await act(async () => finish());
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("[role=combobox]")!.value).toBe("designer");
    expect(options()).toHaveLength(1);
  });

  it("searches by role and selects the correct same-name agent with Enter", async () => {
    await render();
    expect(options()).toHaveLength(2);
    await search("designer");
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("Paused");
    await act(async () => {
      document.querySelector("[role=combobox]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(props.onSelect).toHaveBeenCalledWith(agents[1], expect.any(AbortSignal));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("distinguishes existing conversations and selects the same agent when reopened", async () => {
    await render({ existingChatAgentIds: ["first"] });
    expect(options()[0].textContent).toContain("Open chat");
    expect(options()[1].textContent).toContain("New chat");
    await search("designer");
    await act(async () => options()[0].click());
    expect(props.onSelect).toHaveBeenLastCalledWith(agents[1], expect.any(AbortSignal));
    await render({ open: false });
    await render({ open: true, existingChatAgentIds: ["first", "second"] });
    await search("designer");
    expect(options()[0].textContent).toContain("Open chat");
    expect(options()[0].textContent).not.toContain("New chat");
    await act(async () => options()[0].click());
    expect(props.onSelect).toHaveBeenLastCalledWith(agents[1], expect.any(AbortSignal));
  });

  it("recovers from no results and resets search when reopened", async () => {
    await render();
    await search("accountant");
    expect(options()).toHaveLength(0);
    expect(document.body.textContent).toContain("No agents match");
    const clear = [...document.querySelectorAll("button")].find((b) => b.textContent === "Clear search")!;
    await act(async () => clear.click());
    expect(options()).toHaveLength(2);
    await search("designer");
    await render({ open: false });
    await render({ open: true });
    expect(document.querySelector<HTMLInputElement>("[role=combobox]")!.value).toBe("");
    expect(options()).toHaveLength(2);
  });

  it("shows loading, a retryable error, and an empty roster without stale choices", async () => {
    await render({ loading: true });
    expect(document.querySelector("[role=status]")?.textContent).toContain("Loading agents");
    expect(options()).toHaveLength(0);
    const retry = vi.fn();
    await render({ loading: false, error: new Error("Unavailable"), onRetry: retry });
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn’t load agents");
    expect(options()).toHaveLength(0);
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await render({ error: null, agents: [] });
    expect(document.body.textContent).toContain("Create an agent from the Agents page");
  });
});
