import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { UIAdapterModule } from "./types";
import {
  findUIAdapter,
  getUIAdapter,
  listUIAdapters,
  registerUIAdapter,
  syncExternalAdapters,
  unregisterUIAdapter,
} from "./registry";
import { processUIAdapter } from "./process";
import { SchemaConfigFields } from "./schema-config-fields";

const externalUIAdapter: UIAdapterModule = {
  type: "external_test",
  label: "External Test",
  parseStdoutLine: () => [],
  ConfigFields: () => null,
  buildAdapterConfig: () => ({}),
};

describe("ui adapter registry", () => {
  beforeEach(() => {
    unregisterUIAdapter("external_test");
    syncExternalAdapters([]);
  });

  afterEach(() => {
    unregisterUIAdapter("external_test");
    syncExternalAdapters([]);
  });

  it("registers adapters for lookup and listing", () => {
    registerUIAdapter(externalUIAdapter);

    expect(findUIAdapter("external_test")).toBe(externalUIAdapter);
    expect(getUIAdapter("external_test")).toBe(externalUIAdapter);
    expect(listUIAdapters().some((adapter) => adapter.type === "external_test")).toBe(true);
  });

  it("falls back to the process parser for unknown types after unregistering", () => {
    registerUIAdapter(externalUIAdapter);

    unregisterUIAdapter("external_test");

    expect(findUIAdapter("external_test")).toBeNull();
    const fallback = getUIAdapter("external_test");
    // Unknown types return a lazy-loading wrapper (for external adapters),
    // not the process adapter directly. The type is preserved.
    expect(fallback.type).toBe("external_test");
    // But it uses the schema-based config fields for external adapter forms.
    expect(fallback.ConfigFields).toBe(SchemaConfigFields);
  });

  it("restores built-in Hermes adapters when external overrides are paused or removed", () => {
    for (const type of ["hermes_local", "hermes_gateway"]) {
      const builtin = getUIAdapter(type);

      syncExternalAdapters([{ type, label: "External Hermes" }]);

      const overridden = getUIAdapter(type);
      expect(overridden).not.toBe(builtin);
      expect(overridden.type).toBe(type);
      expect(overridden.label).toBe("External Hermes");
      expect(overridden.ConfigFields).toBe(builtin.ConfigFields);
      expect(overridden.buildAdapterConfig).toBe(builtin.buildAdapterConfig);

      syncExternalAdapters([{ type, label: "External Hermes", overrideDisabled: true }]);

      expect(getUIAdapter(type)).toBe(builtin);

      syncExternalAdapters([{ type, label: "External Hermes" }]);
      expect(getUIAdapter(type)).not.toBe(builtin);

      syncExternalAdapters([]);

      expect(getUIAdapter(type)).toBe(builtin);
    }
  });
});
