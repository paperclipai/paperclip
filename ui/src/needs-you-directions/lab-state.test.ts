import { describe, expect, it } from "vitest";
import { kitIdOf, labSearch, landingSearch, readLabState } from "./lab-state";

describe("readLabState", () => {
  it("lands a bare URL on the registry's landing view, dark, with animation on and the production palette", () => {
    expect(readLabState("")).toEqual({ direction: "all", view: "landing", theme: "dark", chrome: true, anim: true, proposal: false });
  });

  it("reads a kit with no surface as its first surface", () => {
    expect(readLabState("?d=d1-focus")).toMatchObject({ direction: "d1-focus", view: "landing" });
  });

  it("reads a surface with no kit as Today's", () => {
    expect(readLabState("?s=card")).toMatchObject({ direction: "today", view: "card" });
  });

  it("keeps the every-direction board reachable by URL", () => {
    expect(readLabState("?d=all")).toMatchObject({ direction: "all" });
    expect(readLabState("?d=all&s=landing")).toMatchObject({ direction: "all", view: "landing" });
  });

  it("ignores an unknown kit or surface", () => {
    expect(readLabState("?d=nope&s=landing")).toMatchObject({ direction: "today", view: "landing" });
    expect(readLabState("?d=d2-workspace&s=nope")).toMatchObject({ direction: "d2-workspace", view: "landing" });
  });

  it("turns the light theme, the bare frame, animation off and the proposal palette on only on request", () => {
    expect(readLabState("?theme=light&chrome=0&anim=0&proposal=1")).toMatchObject({ theme: "light", chrome: false, anim: false, proposal: true });
    expect(readLabState("?theme=dusk&chrome=1&anim=1&proposal=0")).toMatchObject({ theme: "dark", chrome: true, anim: true, proposal: false });
  });
});

describe("labSearch", () => {
  it("writes the defaults as the short form", () => {
    expect(labSearch(readLabState(""))).toBe("?d=all&s=landing&theme=dark");
    expect(landingSearch()).toBe("?d=all&s=landing&theme=dark");
  });

  it("carries chrome, animation and proposal only when they differ from the defaults", () => {
    expect(labSearch({ direction: "today", view: "landing", theme: "light", chrome: false, anim: false, proposal: true })).toBe("?d=today&s=landing&theme=light&chrome=0&anim=0&proposal=1");
    expect(labSearch({ direction: "d1-focus", view: "board", theme: "dark", chrome: true, anim: true, proposal: false })).toBe("?d=d1-focus&s=board&theme=dark");
  });

  it("round-trips through readLabState", () => {
    for (const search of ["?d=d2-workspace&s=card&theme=light", "?d=all&s=board&theme=dark&anim=0", "?d=today&s=landing&theme=dark&chrome=0&proposal=1"]) {
      expect(labSearch(readLabState(search))).toBe(search);
    }
  });
});

describe("kitIdOf", () => {
  it("reads the every-direction board as Today and a direction as itself", () => {
    expect(kitIdOf(readLabState("?d=all&s=landing"))).toBe("today");
    expect(kitIdOf(readLabState("?d=d1-focus"))).toBe("d1-focus");
  });
});
