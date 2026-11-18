// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { afterVisibleConversationPaint } from "./onboarding-chat";

afterEach(() => vi.restoreAllMocks());

it("waits for a visible tab and two painted frames, then starts once", () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const start = vi.fn();
  const cancel = afterVisibleConversationPaint(start);
  expect(frames).toHaveLength(0);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(start).not.toHaveBeenCalled();
  frames.shift()!(0);
  expect(start).not.toHaveBeenCalled();
  frames.shift()!(1);
  expect(start).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(frames).toHaveLength(0);
  cancel();
});

it("does not start after unmount, including a pending second frame", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const start = vi.fn();
  const cancel = afterVisibleConversationPaint(start);
  frames.shift()!(0);
  cancel();
  frames.shift()!(1);
  expect(start).not.toHaveBeenCalled();
});
