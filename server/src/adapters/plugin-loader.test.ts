import { describe, expect, it } from "vitest";
import type { AdapterLoginCapability } from "@paperclipai/adapter-utils";
import { validateAdapterModule } from "./plugin-loader.js";

// A minimal external adapter module. The loader calls `createServerAdapter()`
// and then validates the returned module. Each test controls the returned
// `loginCapability` to check the fail-closed rule at load time.
function makeModule(loginCapability?: unknown) {
  return {
    createServerAdapter: () => ({
      type: "vendor_local",
      execute: async () => ({}),
      testEnvironment: async () => ({}),
      ...(loginCapability === undefined ? {} : { loginCapability }),
    }),
  };
}

const validLoginCapability: AdapterLoginCapability = {
  panelMode: "displayed_code",
  timeoutPolicy: "caller_bounded",
  getCommand: () => "vendor login",
  parsePrompt: () => null,
};

describe("validateAdapterModule login capability", () => {
  it("loads an adapter with no login capability", () => {
    expect(() => validateAdapterModule(makeModule(), "vendor-pkg")).not.toThrow();
  });

  it("loads an adapter with a well-formed login capability", () => {
    expect(() => validateAdapterModule(makeModule(validLoginCapability), "vendor-pkg")).not.toThrow();
  });

  it("rejects an adapter with a malformed login capability", () => {
    const bad = { ...validLoginCapability, panelMode: "hidden_code" };
    expect(() => validateAdapterModule(makeModule(bad), "vendor-pkg")).toThrow(
      /invalid login capability/,
    );
  });

  it("rejects an adapter with a non-object login capability", () => {
    expect(() => validateAdapterModule(makeModule("displayed_code"), "vendor-pkg")).toThrow(
      /invalid login capability/,
    );
  });
});
