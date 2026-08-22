import { describe, expect, it } from "vitest";
import { formatRunErrorCode, getRunErrorCodeLabel } from "./runErrors";

describe("runErrors", () => {
  it("maps process_lost to a human-readable label", () => {
    expect(getRunErrorCodeLabel("process_lost")).toBe("Run interrupted by control-plane restart");
    expect(formatRunErrorCode("process_lost")).toBe(
      "Run interrupted by control-plane restart (process_lost)",
    );
  });

  it("falls back to raw code when no label exists", () => {
    expect(getRunErrorCodeLabel("unknown_code")).toBeNull();
    expect(formatRunErrorCode("unknown_code")).toBe("unknown_code");
  });
});
