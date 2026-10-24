import { describe, expect, it } from "vitest";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

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
