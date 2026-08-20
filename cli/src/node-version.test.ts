import { describe, expect, it } from "vitest";
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from "./node-version.js";

describe("isSupportedNodeVersion", () => {
  it("accepts the Node 24 LTS floor and newer releases", () => {
    expect(MINIMUM_NODE_VERSION).toBe("24.11.0");
    expect(isSupportedNodeVersion("v24.11.0")).toBe(true);
    expect(isSupportedNodeVersion("24.19.0")).toBe(true);
    expect(isSupportedNodeVersion("v26.0.0")).toBe(true);
  });

  it("rejects pre-LTS Node 24 and older major releases", () => {
    expect(isSupportedNodeVersion("v24.10.0")).toBe(false);
    expect(isSupportedNodeVersion("v22.23.0")).toBe(false);
    expect(isSupportedNodeVersion("unknown")).toBe(false);
  });
});
