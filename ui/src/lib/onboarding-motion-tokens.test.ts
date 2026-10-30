// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { motionEase, motionMilliseconds, motionNumber, motionSeconds } from "./onboarding-motion-tokens";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});
it("uses the CSS defaults before styles load and honors runtime token overrides", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  expect(motionSeconds("--onboarding-motion-step")).toBe(0.28);
  expect(motionNumber("--onboarding-motion-hero-stiffness")).toBe(150);
  document.documentElement.style.setProperty("--onboarding-motion-step", "0.7s");
  document.documentElement.style.setProperty("--onboarding-motion-hero-stiffness", "190");
  document.documentElement.style.setProperty("--motion-ease-out-expo", "cubic-bezier(0.1, 0.2, 0.3, 1)");
  expect(motionSeconds("--onboarding-motion-step")).toBe(0.7);
  expect(motionMilliseconds("--onboarding-motion-step")).toBe(700);
  expect(motionNumber("--onboarding-motion-hero-stiffness")).toBe(190);
  expect(motionEase("--motion-ease-out-expo")).toEqual([0.1, 0.2, 0.3, 1]);
});
it("removes animation durations under reduced motion without removing the connection status hold", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  expect(motionSeconds("--onboarding-motion-step")).toBe(0);
  expect(motionSeconds("--onboarding-motion-label-exit")).toBe(0);
  expect(motionMilliseconds("--onboarding-motion-connected-hold")).toBe(2000);
});
