// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appearanceForPalette } from "@paperclipai/shared";
import { AgentAvatar } from "./AgentAvatar";
import { AgentCharacter } from "./AgentCharacter";
import { useAgentAppearanceDraft } from "../hooks/useAgentAppearanceDraft";

const renderer = vi.hoisted(() => ({ destroy: vi.fn(), setDefinition: vi.fn(), setAnimation: vi.fn() }));
const createCharacter = vi.hoisted(() => vi.fn(() => renderer));
vi.mock("@paperclipai/shared/cliplab/runtime", () => ({ createCharacter }));
vi.mock("@paperclipai/shared/cliplab/definition", () => ({ characterDefinition: vi.fn(value => value), animationId: vi.fn(value => value) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let observers: Array<(entries: any[]) => void>;
let reduced = false;
const appearance = appearanceForPalette("bubblegum-sky");
beforeEach(() => {
  vi.clearAllMocks(); observers = []; reduced = false;
  sessionStorage.clear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: any[]) => void) { observers.push(callback); }
    observe() {} disconnect() {}
  });
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function show() { await act(async () => { for (const observer of observers) observer([{ isIntersecting: true }]); }); }
describe("agent persona presentation", () => {
  it("renders 500 static images without initializing a live renderer", async () => {
    await act(async () => root.render(<>{Array.from({ length: 500 }, (_, i) => <AgentAvatar key={i} appearance={appearance} size={24} />)}</>));
    expect(host.querySelectorAll("img")).toHaveLength(500);
    expect(host.querySelector("canvas")).toBeNull();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(host.querySelector("img")?.getAttribute("srcset")).toContain("size=24&scale=2");
    expect(host.querySelector("img")?.getAttribute("width")).toBe("24");
  });
  it("keeps reserved image dimensions and falls back to initials after an image error", async () => {
    await act(async () => root.render(<AgentAvatar appearance={appearance} name="Chief of Staff" size={48} label="Chief of Staff" />));
    expect(host.querySelector("img")?.height).toBe(48);
    await act(async () => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(host.textContent).toBe("CS");
    expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Chief of Staff");
  });
  it("allows only one live character, releases it offscreen and disposes on unmount", async () => {
    await act(async () => root.render(<><AgentCharacter appearance={appearance} /><AgentCharacter appearance={appearance} /></>));
    expect(createCharacter).not.toHaveBeenCalled();
    await show();
    expect(createCharacter).toHaveBeenCalledTimes(1);
    await act(async () => { observers[0]([{ isIntersecting: false }]); });
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
    expect(createCharacter).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    expect(renderer.destroy).toHaveBeenCalledTimes(2);
  });
  it("uses only static images for reduced motion and an explicit still policy", async () => {
    reduced = true;
    await act(async () => root.render(<><AgentCharacter appearance={appearance} /><AgentCharacter appearance={appearance} motion="still" /></>));
    await show();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(host.querySelectorAll("img")).toHaveLength(2);
  });
  it("retains the draft assignment across remounts and clears it only after creation", async () => {
    let draft!: ReturnType<typeof useAgentAppearanceDraft>;
    function Draft() { draft = useAgentAppearanceDraft("company:new-agent"); return null; }
    await act(async () => root.render(<Draft />));
    const first = draft.appearance;
    await act(async () => root.render(null));
    await act(async () => root.render(<Draft />));
    expect(draft.appearance).toEqual(first);
    expect(JSON.parse(sessionStorage.getItem("paperclip.agent-appearance.company:new-agent")!)).toEqual(first);
    draft.clear();
    expect(sessionStorage.getItem("paperclip.agent-appearance.company:new-agent")).toBeNull();
  });
});
