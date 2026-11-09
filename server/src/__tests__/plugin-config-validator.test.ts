import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@paperclipai/shared";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

const SECRET_ID = "11111111-1111-4111-8111-111111111111";
const binding = { type: "secret_ref", secretId: SECRET_ID, version: "latest" };

// The shape plugin manifests use: a string field marked as a secret reference.
const schema = {
  type: "object",
  properties: {
    apiKey: { type: "string", title: "API key", format: "secret-ref" },
    region: { type: "string" },
    auth: {
      type: "object",
      properties: { token: { type: "string", format: "secret-ref" } },
      additionalProperties: false,
    },
  },
  required: ["apiKey"],
  additionalProperties: false,
} as unknown as JsonSchema;

describe("validateInstanceConfig secret-ref fields", () => {
  it("accepts the secret_ref binding object the settings form saves for a string secret-ref field", () => {
    const configJson = { apiKey: binding, region: "us", auth: { token: { ...binding, version: 2 } } };
    expect(validateInstanceConfig(configJson, schema)).toEqual({ valid: true });
    // Validation does not rewrite what gets stored or sent to the worker.
    expect(configJson.apiKey).toEqual(binding);
  });

  it("still enforces the rest of the schema around a binding", () => {
    expect(validateInstanceConfig({ apiKey: binding, region: 5 }, schema)).toMatchObject({
      valid: false,
      errors: [{ field: "/region" }],
    });
    expect(validateInstanceConfig({ region: "us" }, schema).valid).toBe(false);
  });

  it("rejects objects that are not valid secret_ref bindings and objects in ordinary string fields", () => {
    expect(validateInstanceConfig({ apiKey: { type: "secret_ref", secretId: "not-a-uuid" } }, schema)).toMatchObject({
      valid: false,
      errors: [{ field: "/apiKey", message: "must be string" }],
    });
    expect(validateInstanceConfig({ apiKey: binding, region: binding }, schema)).toMatchObject({
      valid: false,
      errors: [{ field: "/region", message: "must be string" }],
    });
  });
});
