export default (ctx) => {
  const first = ctx.surfaces[0].id;
  const second = ctx.surfaces[1]?.id ?? first;
  const d1 = ctx.directions[0].id;
  const d2 = ctx.directions[1].id;
  const landing = `?d=${ctx.landing.direction}&s=${ctx.landing.view}&theme=dark`;
  return `import { describe, expect, it } from "vitest";
import { kitIdOf, labSearch, landingSearch, readLabState } from "./lab-state";

describe("readLabState", () => {
  it("lands a bare URL on the registry's landing view, dark, with animation on and the production palette", () => {
    expect(readLabState("")).toEqual({ direction: ${JSON.stringify(ctx.landing.direction)}, view: ${JSON.stringify(ctx.landing.view)}, theme: "dark", chrome: true, anim: true, proposal: false });
  });

  it("reads a kit with no surface as its first surface", () => {
    expect(readLabState("?d=${d1}")).toMatchObject({ direction: "${d1}", view: "${first}" });
  });

  it("reads a surface with no kit as Today's", () => {
    expect(readLabState("?s=${second}")).toMatchObject({ direction: "today", view: "${second}" });
  });

  it("keeps the every-direction board reachable by URL", () => {
    expect(readLabState("?d=all")).toMatchObject({ direction: "all" });
    expect(readLabState("?d=all&s=${first}")).toMatchObject({ direction: "all", view: "${first}" });
  });

  it("ignores an unknown kit or surface", () => {
    expect(readLabState("?d=nope&s=${first}")).toMatchObject({ direction: "today", view: "${first}" });
    expect(readLabState("?d=${d2}&s=nope")).toMatchObject({ direction: "${d2}", view: "${first}" });
  });

  it("turns the light theme, the bare frame, animation off and the proposal palette on only on request", () => {
    expect(readLabState("?theme=light&chrome=0&anim=0&proposal=1")).toMatchObject({ theme: "light", chrome: false, anim: false, proposal: true });
    expect(readLabState("?theme=dusk&chrome=1&anim=1&proposal=0")).toMatchObject({ theme: "dark", chrome: true, anim: true, proposal: false });
  });
});

describe("labSearch", () => {
  it("writes the defaults as the short form", () => {
    expect(labSearch(readLabState(""))).toBe(${JSON.stringify(landing)});
    expect(landingSearch()).toBe(${JSON.stringify(landing)});
  });

  it("carries chrome, animation and proposal only when they differ from the defaults", () => {
    expect(labSearch({ direction: "today", view: "${first}", theme: "light", chrome: false, anim: false, proposal: true })).toBe("?d=today&s=${first}&theme=light&chrome=0&anim=0&proposal=1");
    expect(labSearch({ direction: "${d1}", view: "board", theme: "dark", chrome: true, anim: true, proposal: false })).toBe("?d=${d1}&s=board&theme=dark");
  });

  it("round-trips through readLabState", () => {
    for (const search of ["?d=${d2}&s=${second}&theme=light", "?d=all&s=board&theme=dark&anim=0", "?d=today&s=${first}&theme=dark&chrome=0&proposal=1"]) {
      expect(labSearch(readLabState(search))).toBe(search);
    }
  });
});

describe("kitIdOf", () => {
  it("reads the every-direction board as Today and a direction as itself", () => {
    expect(kitIdOf(readLabState("?d=all&s=${first}"))).toBe("today");
    expect(kitIdOf(readLabState("?d=${d1}"))).toBe("${d1}");
  });
});
`;
};
