import { describe, expect, it } from "vitest";
import { accessForConnection } from "./personal-access";
import type { InstallState } from "@/lib/tool-installs";

const installed = (...ids: string[]): InstallState => ({ onAll: false, agentIds: new Set(ids) });

describe("accessForConnection", () => {
  it("keeps a company-wide draft for ordinary connections", () => {
    expect(accessForConnection({ mode: "all", agentIds: new Set() }, installed("a"), false)).toEqual({ mode: "all", agentIds: new Set() });
  });

  it("turns a stale company-wide draft into the installed agents for personal sign-in connections", () => {
    expect(accessForConnection({ mode: "all", agentIds: new Set() }, installed("a", "b"), true)).toEqual({ mode: "specific", agentIds: new Set(["a", "b"]) });
  });

  it("uses the installed agents for a per-user connection even when bindings name a different agent", () => {
    // Bindings say only CTO (or company-wide); installs say Chief of Staff and CTO.
    expect(accessForConnection({ mode: "specific", agentIds: new Set(["cto"]) }, installed("cos", "cto"), false, true))
      .toEqual({ mode: "specific", agentIds: new Set(["cos", "cto"]) });
    expect(accessForConnection({ mode: "all", agentIds: new Set() }, installed("cos", "cto"), false, true))
      .toEqual({ mode: "specific", agentIds: new Set(["cos", "cto"]) });
  });

  it("shows no agents for a per-user connection with no installs", () => {
    expect(accessForConnection({ mode: "all", agentIds: new Set() }, installed(), false, true)).toEqual({ mode: "specific", agentIds: new Set() });
  });
});
