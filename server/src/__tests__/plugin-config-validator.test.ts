/**
 * @fileoverview MO-070 — TDD coverage for plugin-config-validator.
 *
 * Validates configJson against the plugin manifest's instanceConfigSchema.
 * This is the API boundary that prevents bad config from reaching the worker
 * at startup — the Vexion plugin manifests use ajv with `secret-ref` format.
 *
 * MO-070 Phase B — Bug class targeted: BUG-CORE-002 (config validation drift).
 */

import { describe, expect, it } from "vitest";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

describe("plugin-config-validator", () => {
  it("PASSES an empty config against an empty schema", () => {
    const result = validateInstanceConfig({}, { type: "object" } as any);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("FAILS when a required property is missing", () => {
    const schema = {
      type: "object",
      required: ["apiKey"],
      properties: { apiKey: { type: "string" } },
    } as any;

    const result = validateInstanceConfig({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("FAILS with structured field error on type mismatch", () => {
    const schema = {
      type: "object",
      properties: { timeout: { type: "number" } },
    } as any;

    const result = validateInstanceConfig({ timeout: "thirty" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toMatchObject({ field: expect.stringContaining("timeout") });
  });

  it("collects ALL errors when allErrors is enabled (not just first)", () => {
    const schema = {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "string" } },
    } as any;

    const result = validateInstanceConfig({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts the custom `secret-ref` format (validates as always-true)", () => {
    const schema = {
      type: "object",
      properties: { apiKey: { type: "string", format: "secret-ref" } },
    } as any;

    // Any string passes secret-ref (UUID validation happens later at resolve time)
    const result = validateInstanceConfig({ apiKey: "anything-here" }, schema);
    expect(result.valid).toBe(true);
  });

  it("validates standard ajv formats (uuid)", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
    } as any;

    expect(validateInstanceConfig({ id: "not-a-uuid" }, schema).valid).toBe(false);
    expect(validateInstanceConfig({ id: "12345678-1234-1234-1234-123456789012" }, schema).valid).toBe(true);
  });
});
