// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentCharacter } from "./AgentCharacter";

const createMock = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/shared/cliplab/runtime", () => ({ createCharacter: createMock }));
vi.mock("@paperclipai/shared/cliplab/definition", () => ({ characterDefinition: vi.fn(), animationId: (state: string) => state }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let media: MediaQueryList;
let observers: Array<(visible: boolean) => void>;
beforeEach(() => {
  observers = [];
  media = Object.assign(new EventTarget(), { matches: false }) as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(visible => callback([{ isIntersecting: visible }])); }
    observe() {} disconnect() {}
  });
  createMock.mockReset().mockImplementation((host: HTMLElement) => {
    const canvas = document.createElement("canvas"); host.appendChild(canvas);
    return { destroy: vi.fn(() => canvas.remove()), setDefinition: vi.fn(), setAnimation: vi.fn() };
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function settle() { await act(async () => { await vi.dynamicImportSettled(); }); }
async function reveal() { await act(async () => observers.forEach(notify => notify(true))); await settle(); }

it("animates visible org leaders together, bounds GPU contexts, and hands off offscreen slots", async () => {
  await act(async () => root.render(<>{Array.from({ length: 12 }, (_, index) => <AgentCharacter key={index} animationGroup="org-chart" trackingScope="page" followCursor />)}</>));
  await reveal();
  expect(container.querySelectorAll("canvas")).toHaveLength(8);
  expect(createMock).toHaveBeenCalledTimes(8);
  for (const call of createMock.mock.calls) expect(call[2]).toMatchObject({ trackingScope: "page", followCursor: true });
  await act(async () => observers[0](false)); await settle();
  expect(container.querySelectorAll("canvas")).toHaveLength(8);
  expect(createMock).toHaveBeenCalledTimes(9);
  // Reduced motion disposes every live renderer and reveals the static images.
  await act(async () => { Object.assign(media, { matches: true }); media.dispatchEvent(new Event("change")); });
  expect(container.querySelectorAll("canvas")).toHaveLength(0);
  expect(container.querySelectorAll(".invisible")).toHaveLength(0);
});

it("retains one hero outside the org chart and ignores custom avatars", async () => {
  await act(async () => root.render(<><AgentCharacter /><AgentCharacter /><AgentCharacter animationGroup="org-chart" appearance={{ schemaVersion: 1, characterVersion: "cap-v1", paletteId: "arctic-blue", customAvatarAssetId: "22222222-2222-4222-8222-222222222222" }} /></>));
  await reveal();
  expect(container.querySelectorAll("canvas")).toHaveLength(1);
  expect(createMock).toHaveBeenCalledTimes(1);
  expect(container.querySelector('img[src="/api/assets/22222222-2222-4222-8222-222222222222/content"]')).not.toBeNull();
});
