// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ENABLED_ADVANCED_ADAPTER_TYPES,
  ENABLED_INVITE_ADAPTER_TYPES,
  adapterLabels,
  getDefaultLocalAdapterCommand,
  isLocalCliAdapter,
} from "./agent-adapters";

describe("agent adapter helpers", () => {
  it("treats Hermes as a first-class local CLI adapter", () => {
    expect(adapterLabels.hermes_local).toBe("Hermes (local)");
    expect(isLocalCliAdapter("hermes_local")).toBe(true);
    expect(getDefaultLocalAdapterCommand("hermes_local")).toBe("hermes");
  });

  it("enables Hermes in invite and advanced creation flows", () => {
    expect(ENABLED_INVITE_ADAPTER_TYPES.has("hermes_local")).toBe(true);
    expect(ENABLED_ADVANCED_ADAPTER_TYPES.has("hermes_local")).toBe(true);
  });

  it("treats Hermes Gateway as an advanced remote adapter, not a local CLI adapter", () => {
    expect(adapterLabels.hermes_gateway).toBe("Hermes Gateway");
    expect(ENABLED_ADVANCED_ADAPTER_TYPES.has("hermes_gateway")).toBe(true);
    expect(isLocalCliAdapter("hermes_gateway")).toBe(false);
  });
});
