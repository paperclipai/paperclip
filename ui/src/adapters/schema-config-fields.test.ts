import { describe, expect, it } from "vitest";
import type { ConfigFieldSchema } from "@paperclipai/adapter-utils";
import { resolveSchemaFieldDefaultValue } from "./schema-config-fields";

describe("resolveSchemaFieldDefaultValue", () => {
  it("uses a disabled timeout default for hermes_local", () => {
    const timeoutField: ConfigFieldSchema = {
      key: "timeoutSec",
      label: "Timeout (sec)",
      type: "number",
      default: 300,
    };

    expect(resolveSchemaFieldDefaultValue(timeoutField, "hermes_local")).toBe(0);
  });

  it("keeps schema timeout defaults for non-hermes adapters", () => {
    const timeoutField: ConfigFieldSchema = {
      key: "timeoutSec",
      label: "Timeout (sec)",
      type: "number",
      default: 300,
    };

    expect(resolveSchemaFieldDefaultValue(timeoutField, "codex_local")).toBe(300);
  });
});
