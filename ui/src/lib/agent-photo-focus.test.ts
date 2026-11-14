import { describe, expect, it } from "vitest";
import { avatarFocusFromDrag } from "./agent-photo-focus";

const image = { containerSize: 100, imageWidth: 200, imageHeight: 100 };

describe("avatarFocusFromDrag", () => {
  it.each([
    { name: "moves a wide photo left in the crop when dragged right", deltaX: 25, deltaY: 0, x: 25, y: 50 },
    { name: "moves a wide photo right in the crop when dragged left", deltaX: -25, deltaY: 0, x: 75, y: 50 },
    { name: "keeps a wide photo still when dragged vertically", deltaX: 0, deltaY: 40, x: 50, y: 50 },
  ])("$name", ({ deltaX, deltaY, x, y }) => {
    expect(avatarFocusFromDrag({ start: { x: 50, y: 50 }, deltaX, deltaY, ...image })).toEqual({ x, y });
  });

  it("moves a tall photo up in the crop when dragged down", () => {
    expect(avatarFocusFromDrag({
      start: { x: 50, y: 50 }, deltaX: 0, deltaY: 25, containerSize: 100, imageWidth: 100, imageHeight: 200,
    })).toEqual({ x: 50, y: 25 });
  });

  it("stops at the photo edge", () => {
    expect(avatarFocusFromDrag({ start: { x: 0, y: 50 }, deltaX: 80, deltaY: 0, ...image })).toEqual({ x: 0, y: 50 });
    expect(avatarFocusFromDrag({ start: { x: 100, y: 50 }, deltaX: -80, deltaY: 0, ...image })).toEqual({ x: 100, y: 50 });
  });

  it("leaves a square photo centered", () => {
    expect(avatarFocusFromDrag({
      start: { x: 50, y: 50 }, deltaX: 40, deltaY: -30, containerSize: 100, imageWidth: 100, imageHeight: 100,
    })).toEqual({ x: 50, y: 50 });
  });
});
