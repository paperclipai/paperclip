// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workerFactory = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("./sandboxed-parser-worker", () => ({
  createSandboxedWorker: workerFactory.create,
}));

import {
  invalidateDynamicParser,
  loadDynamicParser,
  setDynamicParserResultNotifier,
} from "./dynamic-loader";

type FakeWorker = {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (message: { type: string; id?: number }) => void;
  terminate: ReturnType<typeof vi.fn>;
};

function createFakeWorker(): Worker {
  const worker: FakeWorker = {
    onmessage: null,
    onerror: null,
    postMessage(message: { type: string; id?: number }) {
      if (message.type === "init") {
        queueMicrotask(() => worker.onmessage?.({ data: { type: "ready" } } as MessageEvent));
        return;
      }
      if (message.type === "parse") {
        queueMicrotask(() => worker.onmessage?.({
          data: { type: "result", id: message.id, entries: [] },
        } as MessageEvent));
      }
    },
    terminate: vi.fn(),
  };
  return worker as unknown as Worker;
}

describe("dynamic UI parser result notifications", () => {
  const adapterType = "coalescing_test";
  const animationFrames: FrameRequestCallback[] = [];

  beforeEach(() => {
    workerFactory.create.mockImplementation(createFakeWorker);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("module.exports = { parseStdoutLine: () => [] }")));
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    }));
  });

  afterEach(() => {
    invalidateDynamicParser(adapterType);
    setDynamicParserResultNotifier(null);
    animationFrames.length = 0;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("recomputes once per animation frame when many lines finish together", async () => {
    const notify = vi.fn();
    setDynamicParserResultNotifier(notify);
    const parser = await loadDynamicParser(adapterType);
    expect(parser).not.toBeNull();

    for (let index = 0; index < 3_577; index += 1) {
      parser?.parseStdoutLine(`line ${index}`, "2026-07-20T23:52:22Z");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();

    animationFrames[0]?.(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
