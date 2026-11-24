// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playFinishBurst } from "./finish-burst";

const reduced = (matches: boolean) => vi.stubGlobal("matchMedia", () => ({ matches }));
const burst = () => document.querySelector<HTMLElement>("[data-finish-burst]");
const anchor = () => {
  const el = document.createElement("button");
  el.getBoundingClientRect = () => ({ left: 100, top: 40, width: 20, height: 20 }) as DOMRect;
  document.body.appendChild(el);
  return el;
};

beforeEach(() => { vi.useFakeTimers(); reduced(false); });
afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("draws a check with eight rays centered on the control", () => {
  playFinishBurst(anchor());
  expect(burst()!.style.left).toBe("110px");
  expect(burst()!.style.top).toBe("50px");
  expect(burst()!.querySelectorAll("i")).toHaveLength(8);
  expect(burst()!.querySelector("svg path")).not.toBeNull();
});

it("is hidden from assistive technology and survives the control being removed", () => {
  const el = anchor();
  playFinishBurst(el);
  el.remove();
  expect(burst()!.getAttribute("aria-hidden")).toBe("true");
});

it("cleans up after itself", () => {
  playFinishBurst(anchor());
  vi.runAllTimers();
  expect(burst()).toBeNull();
});

it("does nothing when reduced motion is on", () => {
  reduced(true);
  playFinishBurst(anchor());
  expect(burst()).toBeNull();
});
