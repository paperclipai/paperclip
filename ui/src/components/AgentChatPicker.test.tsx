// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
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

beforeEach(() => {
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
  vi.unstubAllGlobals();
});

describe("AgentChatPicker", () => {
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
