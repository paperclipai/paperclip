// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appearanceForPalette } from "@paperclipai/shared";
import { CAP_V1_COLORS } from "@paperclipai/shared/cliplab/palette-tokens";
import type { createCharacter as CreateCharacter } from "@paperclipai/shared/cliplab/runtime";
import { OnboardingCharacter } from "./OnboardingCharacter";

const createCharacter = vi.hoisted(() => vi.fn<typeof CreateCharacter>());
vi.mock("@paperclipai/shared/cliplab/runtime", () => ({ createCharacter }));

let root: Root;
let host: HTMLDivElement;
const appearance = appearanceForPalette("arctic-blue");
function player() {
  return { destroy: vi.fn(), seek: vi.fn(), play: vi.fn(), pause: vi.fn(), setDefinition: vi.fn(), setAnimation: vi.fn() };
}
beforeEach(() => {
  createCharacter.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class {});
  vi.stubGlobal("ResizeObserver", class {});
  vi.stubGlobal("WebGLRenderingContext", class {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(awake = false, selectedAppearance = appearance) {
  await act(async () => {
    root.render(<OnboardingCharacter appearance={selectedAppearance} awake={awake} />);
  });
  await act(async () => { await vi.dynamicImportSettled(); });
}
function expectFallback() {
  expect(host.querySelector("img")?.classList.contains("invisible")).toBe(false);
}

it("releases the first canvas if its colored twin cannot start", async () => {
  const gray = player();
  createCharacter.mockReturnValueOnce(gray).mockImplementationOnce(() => { throw new Error("WebGL context limit"); });
  await render();
  expect(gray.destroy).toHaveBeenCalledOnce();
  expectFallback();
  await render(true);
  expect(createCharacter).toHaveBeenCalledTimes(2);
});

it("owns the canvas before seeking so synchronous render errors can release it", async () => {
  const gray = player();
  createCharacter.mockImplementationOnce((_target, _definition, options) => {
    gray.seek.mockImplementationOnce(() => options?.onError?.());
    return gray;
  });
  await render();
  expect(gray.destroy).toHaveBeenCalledOnce();
  expect(createCharacter).toHaveBeenCalledOnce();
  expectFallback();
});

it("stops the wake and releases both canvases after a synchronous render error", async () => {
  const gray = player(), twin = player();
  createCharacter.mockImplementationOnce((_target, _definition, options) => {
    gray.setAnimation.mockImplementationOnce(() => options?.onError?.());
    return gray;
  }).mockReturnValueOnce(twin);
  await render();
  await render(true);
  expect(gray.destroy).toHaveBeenCalledOnce();
  expect(twin.destroy).toHaveBeenCalledOnce();
  expect(gray.play).not.toHaveBeenCalled();
  expect(twin.setAnimation).not.toHaveBeenCalled();
  expectFallback();
});

it("releases both canvases if a wake transition throws", async () => {
  const gray = player(), twin = player();
  gray.setAnimation.mockImplementationOnce(() => { throw new Error("renderer unavailable"); });
  createCharacter.mockReturnValueOnce(gray).mockReturnValueOnce(twin);
  await render();
  await render(true);
  expect(gray.destroy).toHaveBeenCalledOnce();
  expect(twin.destroy).toHaveBeenCalledOnce();
  expectFallback();
});

it.each([false, true])("refreshes the sleeping twin when its palette changes (wake: %s)", async (awake) => {
  const gray = player(), twin = player(), nextGray = player(), nextTwin = player();
  createCharacter.mockReturnValueOnce(gray).mockReturnValueOnce(twin)
    .mockReturnValueOnce(nextGray).mockReturnValueOnce(nextTwin);
  await render();
  await render(awake, appearanceForPalette("coral-mint"));
  expect(gray.destroy).toHaveBeenCalledOnce();
  expect(twin.destroy).toHaveBeenCalledOnce();
  const definition = createCharacter.mock.calls[3][1];
  expect(definition.character.color).toBe(CAP_V1_COLORS["coral-mint"].a);
  expect(definition.character.color2).toBe(CAP_V1_COLORS["coral-mint"].b);
  if (awake) expect(nextTwin.play).toHaveBeenCalledOnce();
});
