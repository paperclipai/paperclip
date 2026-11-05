import { describe, expect, it } from "vitest";
import { collectSecretRefPaths, parseSecretRefBindingObject } from "../services/json-schema-secret-refs.ts";

describe("parseSecretRefBindingObject", () => {
  const secretId = "11111111-1111-1111-1111-111111111111";

  it("parses a binding object and defaults the version to latest", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId })).toEqual({
      secretId,
      version: "latest",
    });
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: "latest" })).toEqual({
      secretId,
      version: "latest",
    });
  });

  it("parses a pinned numeric version", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: 3 })).toEqual({
      secretId,
      version: 3,
    });
  });

  it("rejects non-binding values", () => {
    expect(parseSecretRefBindingObject(secretId)).toBeNull();
    expect(parseSecretRefBindingObject("raw-api-key")).toBeNull();
    expect(parseSecretRefBindingObject(null)).toBeNull();
    expect(parseSecretRefBindingObject([{ type: "secret_ref", secretId }])).toBeNull();
    expect(parseSecretRefBindingObject({ type: "user_secret_ref", secretId })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: "not-a-uuid" })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: 0 })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: "2" })).toBeNull();
  });
});

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
