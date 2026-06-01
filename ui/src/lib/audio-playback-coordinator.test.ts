// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAudioPlayback,
  releaseAudioPlayback,
  resetAudioPlaybackCoordinatorForTests,
} from "./audio-playback-coordinator";

describe("audio-playback-coordinator", () => {
  afterEach(() => {
    resetAudioPlaybackCoordinatorForTests();
  });

  it("pauses the previously playing audio when another claims playback", () => {
    const first = document.createElement("audio");
    const second = document.createElement("audio");
    const pauseFirst = vi.spyOn(first, "pause");

    Object.defineProperty(first, "paused", { configurable: true, get: () => false });
    Object.defineProperty(second, "paused", { configurable: true, get: () => true });

    claimAudioPlayback(first);
    claimAudioPlayback(second);

    expect(pauseFirst).toHaveBeenCalledTimes(1);
  });

  it("does not pause audio that is already paused", () => {
    const first = document.createElement("audio");
    const second = document.createElement("audio");
    const pauseFirst = vi.spyOn(first, "pause");

    Object.defineProperty(first, "paused", { configurable: true, get: () => true });

    claimAudioPlayback(first);
    claimAudioPlayback(second);

    expect(pauseFirst).not.toHaveBeenCalled();
  });

  it("clears the active element on release", () => {
    const audio = document.createElement("audio");
    claimAudioPlayback(audio);
    releaseAudioPlayback(audio);

    const next = document.createElement("audio");
    const pauseNext = vi.spyOn(next, "pause");
    Object.defineProperty(audio, "paused", { configurable: true, get: () => false });

    claimAudioPlayback(audio);

    expect(pauseNext).not.toHaveBeenCalled();
  });
});
