// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_RUNTIME_FEATURES, readRuntimeFeaturesBootstrap } from "./runtime-features";

describe("runtime feature bootstrap", () => {
  afterEach(() => {
    document.head.innerHTML = "";
  });

  function setSnapshot(value: string) {
    const script = document.createElement("script");
    script.id = "paperclip-runtime-features";
    script.type = "application/json";
    script.textContent = value;
    document.head.appendChild(script);
  }

  it("accepts the closed versioned feature declaration", () => {
    setSnapshot(JSON.stringify({
      schemaVersion: 1,
      hostFeatures: ["apps.named_mcp_gateways", "apps.access_profiles"],
    }));
    expect(readRuntimeFeaturesBootstrap()).toEqual({
      schemaVersion: 1,
      hostFeatures: ["apps.named_mcp_gateways", "apps.access_profiles"],
    });
  });

  it.each([
    "not json",
    JSON.stringify({ schemaVersion: 2, hostFeatures: ["apps.access_profiles"] }),
    JSON.stringify({ schemaVersion: 1, hostFeatures: ["apps.unknown"] }),
    JSON.stringify({ schemaVersion: 1, hostFeatures: ["apps.access_profiles", "apps.access_profiles"] }),
  ])("fails closed for invalid bootstrap data", (value) => {
    setSnapshot(value);
    expect(readRuntimeFeaturesBootstrap()).toEqual(EMPTY_RUNTIME_FEATURES);
  });
});
