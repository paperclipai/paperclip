import { describe, expect, it } from "vitest";
import { resolveUiExposure, shouldServeBuiltUi } from "../../../scripts/dev-runner-ui-mode.ts";

describe("resolveUiExposure", () => {
  it("keeps an explicit loopback CLI bind local", () => {
    expect(resolveUiExposure({ cliBindMode: "loopback" })).toBe("loopback");
  });

  it("treats lan and tailnet CLI binds as remote", () => {
    expect(resolveUiExposure({ cliBindMode: "lan" })).toBe("remote");
    expect(resolveUiExposure({ cliBindMode: "tailnet" })).toBe("remote");
  });

  it("treats a custom CLI bind as remote unless the host is loopback", () => {
    expect(resolveUiExposure({ cliBindMode: "custom", cliBindHost: "100.126.197.57" })).toBe("remote");
    expect(resolveUiExposure({ cliBindMode: "custom", cliBindHost: "127.0.0.1" })).toBe("loopback");
  });

  it("falls back to the instance config bind when no CLI bind is given", () => {
    expect(resolveUiExposure({ fileServer: { bind: "tailnet" } })).toBe("remote");
    expect(resolveUiExposure({ fileServer: { bind: "loopback" } })).toBe("loopback");
  });

  it("infers exposure from the instance config host when no bind is set", () => {
    expect(resolveUiExposure({ fileServer: { host: "100.126.197.57" } })).toBe("remote");
    expect(resolveUiExposure({ fileServer: { host: "127.0.0.1" } })).toBe("loopback");
    expect(resolveUiExposure({ fileServer: { host: "0.0.0.0" } })).toBe("remote");
  });

  it("prefers the CLI bind over the instance config", () => {
    expect(resolveUiExposure({ cliBindMode: "loopback", fileServer: { bind: "tailnet" } })).toBe("loopback");
  });

  it("defaults to loopback when nothing is configured", () => {
    expect(resolveUiExposure({})).toBe("loopback");
  });
});

describe("shouldServeBuiltUi", () => {
  it("always respects an explicit PAPERCLIP_UI_DEV_MIDDLEWARE choice", () => {
    expect(
      shouldServeBuiltUi({
        explicitUiDevMiddleware: "true",
        managedRuntimeExposure: true,
        cliBindMode: "tailnet",
      }),
    ).toBe(false);
    expect(
      shouldServeBuiltUi({
        explicitUiDevMiddleware: "false",
        managedRuntimeExposure: false,
        cliBindMode: "tailnet",
      }),
    ).toBe(false);
  });

  it("serves the built UI for managed runtime exposure", () => {
    expect(shouldServeBuiltUi({ managedRuntimeExposure: true })).toBe(true);
  });

  it("serves the built UI for a tailnet-bound instance without CLI flags", () => {
    expect(
      shouldServeBuiltUi({
        managedRuntimeExposure: false,
        fileServer: { bind: "tailnet", host: "100.126.197.57" },
      }),
    ).toBe(true);
  });

  it("keeps the dev middleware for loopback-only instances", () => {
    expect(shouldServeBuiltUi({ managedRuntimeExposure: false, fileServer: { bind: "loopback" } })).toBe(false);
    expect(shouldServeBuiltUi({ managedRuntimeExposure: false })).toBe(false);
  });
});
