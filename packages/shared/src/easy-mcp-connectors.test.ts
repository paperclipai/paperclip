import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { appDefinitionSchema } from "./validators/app-definition.js";

const appBySlug = (slug: string) => {
  const app = APP_DEFINITIONS.find((candidate) => candidate.slug === slug);
  expect(app, "expected app definition for " + slug).toBeDefined();
  return app!;
};

const methodFor = (slug: string, key: string) => {
  const method = appBySlug(slug).methods.find((candidate) => candidate.key === key);
  expect(method, "expected method " + slug + "/" + key).toBeDefined();
  return method!;
};

const verifiedProviders = [
  "airtable", "calendly", "exa", "firecrawl", "gsc-wizard", "linear",
  "make", "parallel-search", "posthog", "tavily", "windsor-ai",
];
const newProviders = ["calendly", "exa", "firecrawl", "gsc-wizard", "parallel-search", "tavily", "windsor-ai"];

describe("verified MCP connector definitions", () => {
  it("keeps the 11 qualified providers on remote MCP methods", () => {
    expect(new Set(verifiedProviders).size).toBe(11);
    for (const slug of verifiedProviders) {
      expect(appBySlug(slug).methods.some((method) => method.transport === "mcp_remote"), slug).toBe(true);
      expect(appBySlug(slug).availability?.available, slug).not.toBe(false);
    }
  });

  it("parses the seven newly added definitions against the shared schema", () => {
    for (const slug of newProviders) {
      const definition = appBySlug(slug);
      expect(appDefinitionSchema.parse(definition)).toEqual(definition);
    }
  });

  it("uses reviewed DCR registration for Airtable and retains the manual key method", () => {
    expect(methodFor("airtable", "mcp-oauth")).toMatchObject({
      transport: "mcp_remote", auth: "oauth", ownershipModes: ["dcr"], oauthClientRegistration: "dcr",
      defaults: { serverUrl: "https://mcp.airtable.com/mcp" },
    });
    expect(methodFor("airtable", "mcp-pat")).toMatchObject({
      transport: "mcp_remote", auth: "api_key", keyPlacement: { location: "header", name: "Authorization", prefix: "Bearer " },
    });
  });

  it("keeps keyless search endpoints credential-free", () => {
    for (const [slug, key, endpoint] of [
      ["exa", "public-search", "https://mcp.exa.ai/mcp"],
      ["parallel-search", "public-search", "https://search.parallel.ai/mcp"],
    ]) {
      const method = methodFor(slug!, key!);
      expect(method).toMatchObject({ transport: "mcp_remote", auth: "none", defaults: { serverUrl: endpoint } });
      expect(method.credentialFields).toBeUndefined();
      expect(method.keyPlacement).toBeUndefined();
    }
  });

  it("retains Tavily's reviewed MCP session initialization preference", () => {
    const overridePath = new URL("../../../scripts/app-definition-overrides/tavily.json", import.meta.url);
    const parsed = appDefinitionSchema.parse(JSON.parse(fs.readFileSync(overridePath, "utf8")));
    expect(parsed.methods[0]?.defaults?.mcpSessionRequired).toBe(true);
    const invalidTransport = structuredClone(parsed);
    invalidTransport.methods[0]!.transport = "rest_api";
    expect(appDefinitionSchema.safeParse(invalidTransport).success).toBe(false);
  });
});
