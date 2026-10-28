import { describe, expect, it } from "vitest";
import { kitIdOf, labSearch, readLabState } from "./lab-state";

describe("readLabState", () => {
  it("lands a bare URL on MVP V1's overview, dark, with animation on", () => {
    expect(readLabState("")).toEqual({ direction: "d5-v1-mvp", view: "board", theme: "dark", chrome: true, anim: true });
  });

  it("reads a kit with no surface as its thread", () => {
    expect(readLabState("?d=d1-solid")).toMatchObject({ direction: "d1-solid", view: "thread" });
  });

  it("reads a surface with no kit as Today's", () => {
    expect(readLabState("?s=panel")).toMatchObject({ direction: "today", view: "panel" });
  });

  it("keeps the every-kit contact sheet and the kinds sheet reachable by URL", () => {
    expect(readLabState("?d=all")).toMatchObject({ direction: "all", view: "board" });
    expect(readLabState("?d=today&s=kinds")).toMatchObject({ direction: "today", view: "kinds" });
  });

  it("ignores an unknown kit or surface", () => {
    expect(readLabState("?d=nope&s=thread")).toMatchObject({ direction: "today", view: "thread" });
    expect(readLabState("?d=d2-tint&s=nope")).toMatchObject({ direction: "d2-tint", view: "thread" });
  });

  it("turns the light theme, the bare frame and animation off only on request", () => {
    expect(readLabState("?theme=light&chrome=0&anim=0")).toMatchObject({ theme: "light", chrome: false, anim: false });
    expect(readLabState("?theme=dusk&chrome=1&anim=1")).toMatchObject({ theme: "dark", chrome: true, anim: true });
  });
});

describe("labSearch", () => {
  it("writes the defaults as the short form", () => {
    expect(labSearch(readLabState(""))).toBe("?d=d5-v1-mvp&s=board&theme=dark");
  });

  it("carries chrome and animation only when they are off", () => {
    expect(labSearch({ direction: "today", view: "gallery", theme: "light", chrome: false, anim: false })).toBe("?d=today&s=gallery&theme=light&chrome=0&anim=0");
  });

  it("round-trips through readLabState", () => {
    for (const search of ["?d=d3-tactile&s=stack&theme=light", "?d=all&s=board&theme=dark&anim=0", "?d=today&s=kinds&theme=dark&chrome=0"]) {
      expect(labSearch(readLabState(search))).toBe(search);
    }
  });
});

describe("kitIdOf", () => {
  it("renders the every-kit board's single views with Today", () => {
    expect(kitIdOf(readLabState("?d=all&s=thread"))).toBe("today");
    expect(kitIdOf(readLabState("?d=d4-hybrid"))).toBe("d4-hybrid");
  });
});
