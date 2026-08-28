import { describe, expect, it } from "vitest";
import { resolveUiDevMiddlewareEnv } from "../../../scripts/dev-runner-env.mjs";

describe("resolveUiDevMiddlewareEnv", () => {
  it("defaults to true when unset", () => {
    expect(resolveUiDevMiddlewareEnv({})).toBe("true");
  });

  it("respects an explicit false override", () => {
    expect(resolveUiDevMiddlewareEnv({ PAPERCLIP_UI_DEV_MIDDLEWARE: "false" })).toBe("false");
  });

  it("respects an explicit true value", () => {
    expect(resolveUiDevMiddlewareEnv({ PAPERCLIP_UI_DEV_MIDDLEWARE: "true" })).toBe("true");
  });
});
