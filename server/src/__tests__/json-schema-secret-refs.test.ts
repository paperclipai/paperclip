import { describe, expect, it } from "vitest";
import { collectSecretRefPaths } from "../services/json-schema-secret-refs.ts";

describe("collectSecretRefPaths", () => {
  it("collects nested secret-ref paths from object properties", () => {
    expect(Array.from(collectSecretRefPaths({
      type: "object",
      properties: {
        credentials: {
          type: "object",
          properties: {
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
      },
    }))).toEqual(["credentials.apiKey"]);
  });

  it("collects secret-ref paths from JSON Schema composition keywords", () => {
    expect(Array.from(collectSecretRefPaths({
      type: "object",
      allOf: [
        {
          properties: {
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
        {
          properties: {
            nested: {
              oneOf: [
                {
                  properties: {
                    token: { type: "string", format: "secret-ref" },
                  },
                },
              ],
            },
          },
        },
      ],
    })).sort()).toEqual(["apiKey", "nested.token"]);
  });
});
