// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetFetchRejectionDiagnostics,
  classifyFetchCaller,
  readFetchInitiator,
  readFetchWrapperState,
  startFetchRejectionDiagnostics,
} from "./fetch-rejection-origin";

const ORIGIN = "https://board.example.test";

/** A `fetch` that `Function.prototype.toString` reports as native code. */
function nativeLookingFetch(result: () => Promise<Response>): typeof fetch {
  const holder = { run: result };
  return Function.prototype.call.bind(function (this: typeof holder) {
    return this.run();
  }, holder) as unknown as typeof fetch;
}

function fakeWindow(fetchImpl: typeof fetch): Window {
  return { fetch: fetchImpl, location: { origin: ORIGIN } } as unknown as Window;
}

afterEach(() => {
  __resetFetchRejectionDiagnostics();
});

describe("classifyFetchCaller", () => {
  it("names the app when the first caller frame is a same-origin bundle (Chromium)", () => {
    const stack = [
      "Error",
      `    at fetch (${ORIGIN}/assets/index-abc.js:1:100)`,
      `    at apiFetch (${ORIGIN}/assets/index-abc.js:1:200)`,
      `    at request (${ORIGIN}/assets/index-abc.js:1:300)`,
    ].join("\n");
    expect(classifyFetchCaller(stack, ORIGIN)).toBe("app");
  });

  it("names the app for a same-origin caller (Firefox and Safari format)", () => {
    const stack = [
      `fetch@${ORIGIN}/assets/index-abc.js:1:100`,
      `apiFetch@${ORIGIN}/assets/index-abc.js:1:200`,
    ].join("\n");
    expect(classifyFetchCaller(stack, ORIGIN)).toBe("app");
  });

  it("names an extension when any caller frame belongs to one", () => {
    const stack = [
      "Error",
      `    at fetch (${ORIGIN}/assets/index-abc.js:1:100)`,
      `    at send (${ORIGIN}/assets/index-abc.js:1:150)`,
      "    at poll (chrome-extension://abcdefghijklmnop/widget.js:4:20)",
    ].join("\n");
    expect(classifyFetchCaller(stack, ORIGIN)).toBe("extension");
  });

  it("does not count the wrapper frame as the caller", () => {
    const stack = [
      "Error",
      `    at fetch (${ORIGIN}/assets/index-abc.js:1:100)`,
      "    at load (https://cdn.other.example/sdk.js:2:30)",
    ].join("\n");
    expect(classifyFetchCaller(stack, ORIGIN)).toBe("other");
  });

  it("returns unknown when no caller frame was captured", () => {
    expect(classifyFetchCaller(undefined, ORIGIN)).toBe("unknown");
    expect(classifyFetchCaller("Error", ORIGIN)).toBe("unknown");
    expect(classifyFetchCaller(`Error\n    at fetch (${ORIGIN}/assets/index-abc.js:1:100)`, ORIGIN)).toBe("unknown");
  });
});

describe("startFetchRejectionDiagnostics", () => {
  it("records a rejected request and rethrows the identical value", async () => {
    const failure = new TypeError("Failed to fetch");
    const target = fakeWindow(nativeLookingFetch(() => Promise.reject(failure)));
    startFetchRejectionDiagnostics(target);

    expect(readFetchInitiator(failure)).toBe("unrecorded");
    await expect(target.fetch("/api/health")).rejects.toBe(failure);
    // Test frames are file paths, not the page origin.
    expect(readFetchInitiator(failure)).toBe("other");
    expect(readFetchWrapperState()).toBe("none");
  });

  it("returns a promise the caller still owns, so a dropped one stays unhandled", async () => {
    const failure = new TypeError("Failed to fetch");
    const original = Promise.reject(failure);
    const target = fakeWindow(nativeLookingFetch(() => original));
    startFetchRejectionDiagnostics(target);
    const returned = target.fetch("/api/health");
    // The wrapper handles only its own copy. The caller's promise is a new
    // one that rejects with the identical value, as the original did.
    expect(returned).not.toBe(original);
    await expect(returned).rejects.toBe(failure);
  });

  it("passes a response through and records nothing", async () => {
    const response = new Response("ok");
    const target = fakeWindow(nativeLookingFetch(() => Promise.resolve(response)));
    startFetchRejectionDiagnostics(target);
    await expect(target.fetch("/api/health")).resolves.toBe(response);
  });

  it("reports a fetch wrapped before and after installation", () => {
    const scripted = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const target = fakeWindow(scripted);
    startFetchRejectionDiagnostics(target);
    expect(readFetchWrapperState()).toBe("before");
    const installedFetch = target.fetch;
    target.fetch = ((...args: Parameters<typeof fetch>) => installedFetch(...args)) as typeof fetch;
    expect(readFetchWrapperState()).toBe("both");
  });

  it("reports a wrapper added after installation", () => {
    const target = fakeWindow(nativeLookingFetch(() => Promise.resolve(new Response("ok"))));
    startFetchRejectionDiagnostics(target);
    const installedFetch = target.fetch;
    target.fetch = ((...args: Parameters<typeof fetch>) => installedFetch(...args)) as typeof fetch;
    expect(readFetchWrapperState()).toBe("after");
  });

  it("installs once", () => {
    const target = fakeWindow(nativeLookingFetch(() => Promise.resolve(new Response("ok"))));
    startFetchRejectionDiagnostics(target);
    const first = target.fetch;
    startFetchRejectionDiagnostics(target);
    expect(target.fetch).toBe(first);
  });

  it("reads nothing from a non-object rejection", () => {
    expect(readFetchInitiator(undefined)).toBe("unrecorded");
    expect(readFetchInitiator("Failed to fetch")).toBe("unrecorded");
    expect(readFetchWrapperState()).toBeUndefined();
  });
});
