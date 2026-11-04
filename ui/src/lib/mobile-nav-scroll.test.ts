import { describe, expect, it } from "vitest";
import { MobileNavScrollTracker } from "./mobile-nav-scroll";

function tracker(top = 0) {
  return new MobileNavScrollTracker({ topZone: 24, hideDistance: 32, showDistance: 16 }, top, 1000);
}

describe("mobile navigation scroll response", () => {
  it("hides after deliberate downward movement, including slow scrolling", () => {
    const nav = tracker(100);
    for (let top = 101; top < 132; top++) expect(nav.update(top, 1000)).toBe(true);
    expect(nav.update(132, 1000)).toBe(false);
  });

  it("ignores small reversals and reveals after a deliberate upward scroll", () => {
    const nav = tracker(100);
    expect(nav.update(200, 1000)).toBe(false);
    expect(nav.update(195, 1000)).toBe(false);
    expect(nav.update(198, 1000)).toBe(false);
    expect(nav.update(183, 1000)).toBe(false);
    expect(nav.update(182, 1000)).toBe(true);
    expect(nav.update(187, 1000)).toBe(true);
  });

  it("keeps navigation available near the top and through top rubber-banding", () => {
    const nav = tracker();
    expect(nav.update(-40, 1000)).toBe(true);
    expect(nav.update(24, 1000)).toBe(true);
    expect(nav.update(100, 1000)).toBe(false);
    expect(nav.update(20, 1000)).toBe(true);
  });

  it("uses the same top-zone threshold for sparse and frequent events", () => {
    const slow = tracker();
    const fast = tracker();
    for (let top = 1; top <= 55; top++) expect(slow.update(top, 1000)).toBe(true);
    expect(fast.update(55, 1000)).toBe(true);
    expect(slow.update(56, 1000)).toBe(false);
    expect(fast.update(56, 1000)).toBe(false);
  });

  it("does not reveal when bottom overscroll rebounds", () => {
    const nav = tracker(900);
    expect(nav.update(1000, 1000)).toBe(false);
    expect(nav.update(1040, 1000)).toBe(false);
    expect(nav.update(1000, 1000)).toBe(false);
    expect(nav.update(984, 1000)).toBe(true);
  });

  it("ignores scroll corrections caused by changing document bounds", () => {
    const nav = tracker(900);
    expect(nav.update(1000, 1000)).toBe(false);
    expect(nav.update(940, 940)).toBe(false);
    expect(nav.update(924, 940)).toBe(true);
  });
});
