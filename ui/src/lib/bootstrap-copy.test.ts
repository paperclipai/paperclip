import { describe, expect, it } from "vitest";
import { buildBootstrapPendingMessage } from "./bootstrap-copy";

describe("buildBootstrapPendingMessage", () => {
  it("explains that an existing invite must be accepted in the browser", () => {
    expect(buildBootstrapPendingMessage(true)).toContain("finish setup in the browser");
    expect(buildBootstrapPendingMessage(true)).toContain("rotate the invite");
  });

  it("explains that the command only generates the invite URL", () => {
    expect(buildBootstrapPendingMessage(false)).toContain("generate the first-admin invite URL");
    expect(buildBootstrapPendingMessage(false)).toContain("open that invite in the browser");
  });
});
