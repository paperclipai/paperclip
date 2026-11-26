// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, ToolCatalogEntry, ToolConnectionCapabilities } from "@paperclipai/shared";
import { PermissionsPanel } from "./PermissionsPanel";
import { installStateFrom } from "@/lib/tool-installs";

const { dialog, icon } = vi.hoisted(() => ({ dialog: vi.fn(), icon: vi.fn() }));
vi.mock("./ActionTestDialog", () => ({
  ActionTestDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    dialog(props);
    return props.open ? <button onClick={() => props.onOpenChange(false)}>Close test</button> : null;
  },
}));
vi.mock("@/components/ProviderToolIcon", () => ({ ProviderToolIcon: () => { icon(); return null; } }));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

function entries() {
  return Array.from({ length: 500 }, (_, index) => ({
    id: `action-${index}`, toolName: `action_${index}`, title: `Action ${String(index).padStart(3, "0")}`,
    description: `Action number ${index}`, status: "active", isReadOnly: index < 250,
    riskLevel: index < 250 ? "read" : "write", icons: [{ src: "https://example.test/icon.svg" }],
  }) as ToolCatalogEntry);
}

async function setup(focus = "", review = false) {
  const catalog = entries();
  const props = {
    connectionId: "conn-1", appName: "App", agents: [] as Agent[],
    access: { mode: "all" as "all" | "specific", agentIds: new Set<string>() },
    install: installStateFrom([]), capabilities: { canConfigure: true } as ToolConnectionCapabilities,
    readOnly: catalog.slice(0, 250), canChange: catalog.slice(250), quarantined: review ? catalog : [],
    enabledIds: new Set(catalog.map(entry => entry.id)), askFirstIds: new Set<string>(),
    pending: false, refreshPending: false, onSaveAccess: vi.fn(), onSetActionPermission: vi.fn(),
    onReviewQuarantined: vi.fn(), onRefreshActions: vi.fn(),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = () => root.render(<MemoryRouter initialEntries={[`/?focus=${focus}`]}><PermissionsPanel {...props} /></MemoryRouter>);
  await act(render);
  return { props, render };
}

function setSearch(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Find an action"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("permission form work with a large catalog", () => {
  it("mounts a test dialog only when its Test button is used", async () => {
    await setup();
    expect(dialog).not.toHaveBeenCalled();
    const test = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Test")!;
    await act(() => test.click());
    expect(dialog).toHaveBeenCalledTimes(1);
    await act(() => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Close test")!.click());
    expect(container.textContent).not.toContain("Close test");
  });

  it("bounds rendered rows while bulk permissions still include hidden actions", async () => {
    const { props } = await setup();
    expect(container.querySelectorAll("[data-action-id]").length).toBeLessThanOrEqual(100);
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Set every action in Write (250)"]')!;
    await act(() => { select.value = "ask"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(props.onSetActionPermission).toHaveBeenCalledWith(props.canChange.map(entry => entry.id), "ask");
    const more = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Show more read actions")!;
    await act(() => more.click());
    expect(container.querySelectorAll("[data-action-id]")).toHaveLength(150);
    await act(() => setSearch("Action 499"));
    expect(container.querySelectorAll("[data-action-id]")).toHaveLength(1);
    expect(container.querySelector('[data-action-id="action-499"]')).toBeTruthy();
  });

  it("does not rerender action controls for an agent access change", async () => {
    const { props, render } = await setup();
    icon.mockClear();
    props.access = { mode: "specific", agentIds: new Set() };
    await act(render);
    expect(icon).not.toHaveBeenCalled();
  });

  it("bounds new-action review controls and saves choices for the full list", async () => {
    const { props } = await setup("", true);
    expect(container.querySelectorAll('[role="switch"]').length).toBeLessThanOrEqual(50);
    const button = (label: string) => Array.from(container.querySelectorAll("button")).find(button => button.textContent === label)!;
    await act(() => button("Turn all on").click());
    expect(container.textContent).toContain("500 of 500 will be on");
    await act(() => button("Show more new actions").click());
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(100);
    await act(() => button("Save choices").click());
    expect(props.onReviewQuarantined).toHaveBeenCalledWith(entries().map(entry => entry.id));
  });

  it("shows an action linked beyond the first page", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    await setup("action-499");
    expect(container.querySelector('[data-action-id="action-499"]')).toBeTruthy();
    expect(container.querySelectorAll("[data-action-id]").length).toBeLessThanOrEqual(101);
  });
});
