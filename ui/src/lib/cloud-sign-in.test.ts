import { afterEach, describe, expect, it, vi } from "vitest";
import { beginCloudSignIn, clearCloudSignInAttempt } from "./cloud-sign-in";

afterEach(() => vi.unstubAllGlobals());

describe("Cloud sign-in recovery", () => {
  it("bounds redirects across documents and resets after verified authentication", () => {
    const values = new Map<string, string>();
    const replace = vi.fn();
    vi.stubGlobal("window", {
      location: { replace },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    expect(beginCloudSignIn("https://cloud.test/entry")).toBe(true);
    expect(beginCloudSignIn("https://cloud.test/entry")).toBe(false);
    expect(replace).toHaveBeenCalledTimes(1);
    clearCloudSignInAttempt();
    expect(beginCloudSignIn("https://cloud.test/entry")).toBe(true);
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it("uses manual recovery when tab storage is unavailable", () => {
    const replace = vi.fn();
    vi.stubGlobal("window", {
      location: { replace },
      get sessionStorage() { throw new Error("Storage disabled"); },
    });
    expect(beginCloudSignIn("https://cloud.test/entry")).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(clearCloudSignInAttempt).not.toThrow();
  });
});
