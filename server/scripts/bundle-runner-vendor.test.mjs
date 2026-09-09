import { describe, expect, it } from "vitest";

import { findMissingVendorDependencies } from "./bundle-runner-vendor.mjs";

describe("findMissingVendorDependencies", () => {
  it("returns nothing when every external the bundle needs is already declared", () => {
    const missing = findMissingVendorDependencies(
      new Set(["acpx", "ajv", "smol-toml"]),
      new Set(["acpx", "ajv", "smol-toml", "express"]),
    );

    expect(missing).toEqual([]);
  });

  it("flags a bundle external that isn't declared as a server dependency", () => {
    // This is the exact shape of the incident this check exists to catch:
    // packages/paperclip-runner/package.json grew a new runtime dependency
    // (smol-toml) that never got mirrored into server/package.json, so the
    // vendored bundle would fail to resolve it at runtime (#13110, #13116).
    const missing = findMissingVendorDependencies(
      new Set(["acpx", "ajv", "smol-toml"]),
      new Set(["acpx", "ajv"]),
    );

    expect(missing).toEqual(["smol-toml"]);
  });

  it("sorts multiple missing dependencies for a stable error message", () => {
    const missing = findMissingVendorDependencies(
      new Set(["smol-toml", "ajv-formats", "acpx"]),
      new Set(),
    );

    expect(missing).toEqual(["acpx", "ajv-formats", "smol-toml"]);
  });
});
