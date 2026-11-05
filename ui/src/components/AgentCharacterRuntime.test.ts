// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCharacter } from "@paperclipai/shared/cliplab/runtime";
import { characterDefinition } from "@paperclipai/shared/cliplab/definition";
import { appearanceForPalette } from "@paperclipai/shared";
const renderer = vi.hoisted(() => ({ render: vi.fn(), resize: vi.fn(), dispose: vi.fn() }));
vi.mock("@paperclipai/shared/cliplab/renderer", () => ({ CharacterRenderer: class { render = renderer.render; resize = renderer.resize; dispose = renderer.dispose; } }));
let intersect: (entries: any[]) => void;
let hidden = false;
let frames: Map<number, FrameRequestCallback>;
let reduced: MediaQueryList;
let coarse: MediaQueryList;
let target: HTMLDivElement;
let region: HTMLDivElement;
const players: Array<ReturnType<typeof createCharacter>> = [];
function media() { return Object.assign(new EventTarget(), { matches: false }) as unknown as MediaQueryList; }
beforeEach(() => {
  vi.clearAllMocks(); renderer.render.mockReset(); hidden = false; frames = new Map(); reduced = media(); coarse = media();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  vi.stubGlobal("matchMedia", (query: string) => query.includes("reduced-motion") ? reduced : coarse);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: typeof intersect) { intersect = callback; } observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  target = document.createElement("div"); region = document.createElement("div"); region.appendChild(target); document.body.appendChild(region);
});
afterEach(() => { players.splice(0).forEach(player => player.destroy()); region.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function create() {
  const player = createCharacter(target, characterDefinition(appearanceForPalette("arctic-blue")), { trackingRegion: region });
  players.push(player); return player;
}
it("stops scheduling offscreen, when hidden, for reduced motion, and after disposal", () => {
  const player = create(); expect(frames.size).toBe(0);
  intersect([{ isIntersecting: true }]); expect(frames.size).toBe(1);
  hidden = true; document.dispatchEvent(new Event("visibilitychange")); expect(frames.size).toBe(0);
  hidden = false; document.dispatchEvent(new Event("visibilitychange")); expect(frames.size).toBe(1);
  Object.assign(reduced, { matches: true }); reduced.dispatchEvent(new Event("change")); expect(frames.size).toBe(0);
  Object.assign(reduced, { matches: false }); reduced.dispatchEvent(new Event("change")); expect(frames.size).toBe(1);
  intersect([{ isIntersecting: false }]); expect(frames.size).toBe(0);
  intersect([{ isIntersecting: true }]); player.destroy(); player.destroy();
  expect(frames.size).toBe(0); expect(renderer.dispose).toHaveBeenCalledTimes(1); expect(target.children).toHaveLength(0);
});
it("tracks only its region, ignores touch, and removes listeners for coarse pointers", () => {
  const add = vi.spyOn(region, "addEventListener"), remove = vi.spyOn(region, "removeEventListener");
  const documentAdd = vi.spyOn(document, "addEventListener");
  create(); intersect([{ isIntersecting: true }]);
  expect(add.mock.calls.some(([event]) => event === "pointermove")).toBe(true);
  expect(documentAdd.mock.calls.some(([event]) => event === "pointermove")).toBe(false);
  const before = renderer.render.mock.calls.at(-1)?.[3];
  region.dispatchEvent(Object.assign(new Event("pointermove"), { pointerType: "touch", clientX: 100, clientY: 100 }));
  const [id, frame] = [...frames][0]; frames.delete(id); frame(performance.now() + 16);
  expect(renderer.render.mock.calls.at(-1)?.[3]).toEqual(before);
  Object.assign(coarse, { matches: true }); coarse.dispatchEvent(new Event("change"));
  expect(remove.mock.calls.some(([event]) => event === "pointermove")).toBe(true);
});
it("disposes the canvas and subscriptions when the first render fails", () => {
  renderer.render.mockImplementationOnce(() => { throw new Error("lost context"); });
  expect(() => create()).toThrow("lost context");
  expect(renderer.dispose).toHaveBeenCalledTimes(1); expect(target.children).toHaveLength(0); expect(frames.size).toBe(0);
});

it("falls back when a later expression render fails", () => {
  const onError = vi.fn();
  const player = createCharacter(target, characterDefinition(appearanceForPalette("arctic-blue")), { onError });
  players.push(player); intersect([{ isIntersecting: true }]);
  renderer.render.mockImplementationOnce(() => { throw new Error("lost context"); });
  expect(() => player.setAnimation("success")).not.toThrow();
  expect(onError).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
});

it("can follow the whole page while measuring gaze from the character and cleaning up", () => {
  const page = document.documentElement;
  const remove = vi.spyOn(page, "removeEventListener");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, width: 100, height: 100 } as DOMRect);
  const player = createCharacter(target, characterDefinition(appearanceForPalette("arctic-blue")), { trackingScope: "page", displaySize: 256 });
  players.push(player); intersect([{ isIntersecting: true }]);
  // Outside the character and its parent region, but still on the page.
  page.dispatchEvent(Object.assign(new Event("pointermove"), { pointerType: "mouse", clientX: 900, clientY: 150 }));
  const [id, frame] = [...frames][0]; frames.delete(id); frame(performance.now() + 50);
  const gaze = renderer.render.mock.calls.at(-1)?.[3];
  expect(gaze.x).toBeGreaterThan(0); expect(gaze.y).toBe(0);
  player.destroy();
  expect(remove.mock.calls.some(([event]) => event === "pointermove")).toBe(true);
});
