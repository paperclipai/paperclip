import { describe, expect, it } from "vitest";
import { fitPrint, SINGLE_BOX, STACK_BOX } from "./MediaPrint";

describe("fitPrint", () => {
  it("fits a landscape print to the stack box by width and a portrait one by height", () => {
    expect(fitPrint({ aspect: 4 / 3 }, STACK_BOX)).toEqual({ width: 245, height: 183.75, border: 3.3 });
    expect(fitPrint({ aspect: 3 / 4 }, STACK_BOX)).toEqual({ width: 165, height: 220, border: 3.3 });
  });

  it("never lets a print grow past the box", () => {
    for (const aspect of [0.5, 1, 2, 16 / 9]) {
      const print = fitPrint({ aspect }, STACK_BOX);
      expect(print.width).toBeLessThanOrEqual(STACK_BOX.maxWidth);
      expect(print.height).toBeLessThanOrEqual(STACK_BOX.maxHeight);
      expect(print.width / print.height).toBeCloseTo(aspect, 2);
    }
  });

  it("assumes 4:3 when the picture's ratio is unknown", () => {
    expect(fitPrint({}, SINGLE_BOX)).toEqual({ width: 240, height: 180, border: 4 });
    expect(fitPrint({ aspect: 0 }, SINGLE_BOX)).toEqual(fitPrint({}, SINGLE_BOX));
  });
});
