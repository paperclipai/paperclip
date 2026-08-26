import { describe, expect, it } from "vitest";
import {
  ProviderSchemaContractError,
  validateProviderSchemaContract,
} from "./provider-schema.js";

describe("validateProviderSchemaContract", () => {
  it("accepts an empty surface", () => {
    expect(() => validateProviderSchemaContract({ providers: {}, mcp: {} })).not.toThrow();
    expect(() => validateProviderSchemaContract({})).not.toThrow();
  });

  it("accepts legal boundary names at exactly the 64-char limit", () => {
    const atLimit = "a".repeat(64);
    expect(() =>
      validateProviderSchemaContract({
        providers: { [atLimit]: { models: { [atLimit]: {} } } },
        mcp: { [atLimit]: {} },
      }),
    ).not.toThrow();
  });

  it("rejects a tool/function name of 75 chars with a specific PROVIDER_SCHEMA_CONTRACT error", () => {
    const tooLong = "a".repeat(75);
    let caught: unknown;
    try {
      validateProviderSchemaContract({
        providers: {
          gateway: {
            tools: [{ name: tooLong, description: "x" }],
          },
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderSchemaContractError);
    const error = caught as ProviderSchemaContractError;
    expect(error.code).toBe("PROVIDER_SCHEMA_CONTRACT");
    expect(error.tool).toBe(tooLong);
    expect(error.connection).toBe("gateway");
    expect(error.length).toBe(75);
    expect(error.maxLength).toBe(64);
    expect(error.message).toContain("tool/function name");
    expect(error.message).toContain("gateway");
  });

  it("rejects a nested function.name shape", () => {
    const tooLong = "b".repeat(70);
    expect(() =>
      validateProviderSchemaContract({
        providers: { gw: { tools: [{ function: { name: tooLong } }] } },
      }),
    ).toThrow(ProviderSchemaContractError);
  });

  it("rejects an over-long provider connection id", () => {
    const tooLong = "c".repeat(65);
    expect(() =>
      validateProviderSchemaContract({ providers: { [tooLong]: { models: { m: {} } } } }),
    ).toThrow(/provider connection name/);
  });

  it("rejects an over-long model id", () => {
    const tooLong = "d".repeat(66);
    expect(() =>
      validateProviderSchemaContract({ providers: { gw: { models: { [tooLong]: {} } } } }),
    ).toThrow(/model id/);
  });

  it("rejects an over-long MCP server id", () => {
    const tooLong = "e".repeat(67);
    expect(() => validateProviderSchemaContract({ mcp: { [tooLong]: {} } })).toThrow(/MCP server name/);
  });

  it("honours a custom maxNameLength", () => {
    const name = "f".repeat(20);
    expect(() =>
      validateProviderSchemaContract({ providers: { gw: { tools: [{ name }] } }, maxNameLength: 10 }),
    ).toThrow(ProviderSchemaContractError);
    expect(() =>
      validateProviderSchemaContract({ providers: { gw: { tools: [{ name }] } }, maxNameLength: 64 }),
    ).not.toThrow();
  });
});
