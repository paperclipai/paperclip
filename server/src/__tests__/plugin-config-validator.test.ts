import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_CONFIG_FORM_KEYWORDS, validateInstanceConfig } from "../services/plugin-config-validator.js";

const schemaWithFormKeywords = {
  type: "object",
  properties: {
    apiKey: { type: "string", format: "secret-ref" },
    sshUser: {
      type: "string",
      "x-paperclip-advanced": true,
      "x-paperclip-group": "SSH access",
    },
  },
};

describe("validateInstanceConfig", () => {
  it("accepts the form keywords that the plugin settings form reads", () => {
    expect(validateInstanceConfig({ sshUser: "root" }, schemaWithFormKeywords)).toEqual({ valid: true });
  });

  it("still reports values that do not match a schema with form keywords", () => {
    expect(validateInstanceConfig({ sshUser: 22 }, schemaWithFormKeywords)).toEqual({
      valid: false,
      errors: [{ field: "/sshUser", message: "must be string" }],
    });
  });
});

describe("validateInstanceConfig with array entry keywords", () => {
  const backendsSchema = {
    type: "object",
    properties: {
      backends: {
        type: "array",
        "x-paperclip-itemLabel": "name",
        "x-paperclip-itemSummary": ["type", "baseUrl", "key"],
        items: {
          type: "object",
          required: ["id", "type"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["litellm", "ollama"] },
            baseUrl: { type: "string" },
            key: { format: "secret-ref" },
            slots: { type: "integer", minimum: 1, "x-paperclip-advanced": true },
          },
        },
      },
    },
  };

  it("accepts the item label and summary keywords", () => {
    expect(
      validateInstanceConfig(
        {
          backends: [
            {
              id: "proxy",
              name: "LiteLLM proxy",
              type: "litellm",
              baseUrl: "https://ai.example.com",
              key: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
              slots: 4,
            },
          ],
        },
        backendsSchema,
      ),
    ).toEqual({ valid: true });
  });

  it("still reports an invalid array entry by its path", () => {
    expect(validateInstanceConfig({ backends: [{ id: "x", type: "vllm" }] }, backendsSchema)).toEqual({
      valid: false,
      errors: [{ field: "/backends/0/type", message: "must be equal to one of the allowed values" }],
    });
  });

  it("still rejects keywords the form does not read", () => {
    expect(() =>
      validateInstanceConfig({}, { type: "object", properties: { a: { type: "string", "x-paperclip-typo": true } } }),
    ).toThrow(/unknown keyword/);
  });

  it("registers every x-paperclip keyword the settings form declares", () => {
    const formSource = readFileSync(
      fileURLToPath(new URL("../../../ui/src/components/JsonSchemaForm.tsx", import.meta.url)),
      "utf8",
    );
    const declared = [...formSource.matchAll(/^\s*"(x-paperclip-[A-Za-z-]+)"\?:/gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...PLUGIN_CONFIG_FORM_KEYWORDS].sort()).toEqual([...declared].sort());
  });
});
