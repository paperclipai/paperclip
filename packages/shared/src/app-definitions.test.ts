import { describe,expect,it } from "vitest";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { appDefinitionsSchema } from "./validators/app-definition.js";
describe("AppDefinition catalog",()=>{
 it("validates all Wave 1 definitions",()=>expect(()=>appDefinitionsSchema.parse(APP_DEFINITIONS)).not.toThrow());
 it("contains thirteen reviewed providers",()=>expect(APP_DEFINITIONS.map((app)=>app.slug)).toEqual(["zapier","github","slack","notion","posthog","linear","google-sheets","context7","oauth-generic","api-key-generic","sentry","vercel","anthropic"]));
 it("uses discovery-first Notion MCP OAuth metadata",()=>{
  const notion=APP_DEFINITIONS.find((app)=>app.slug==="notion");
  expect(notion?.redirectConstraints).toBe("https-or-loopback-http");
  expect(notion?.methods[0]?.defaults).toEqual({serverUrl:"https://mcp.notion.com/mcp"});
 });
 it("preserves required Linear OAuth scopes",()=>expect(APP_DEFINITIONS.find((app)=>app.slug==="linear")?.methods[0]?.defaults?.scopesHint).toEqual(["read","write"]));
 it("offers PostHog OAuth and API-key methods with pinned safe defaults",()=>{const posthog=APP_DEFINITIONS.find((app)=>app.slug==="posthog");expect(posthog?.methods.map((method)=>method.key)).toEqual(["mcp-oauth","mcp-api-key"]);for(const method of posthog?.methods??[]){expect(method.riskTier).toBe("S3");expect(method.tenantFields?.find((field)=>field.key==="readOnly")?.defaultValue).toBe(true);expect(method.tenantFields?.find((field)=>field.key==="projectId")?.transport).toEqual({location:"header",name:"x-posthog-project-id"});expect(method.configRequirements?.atLeastOneOf).toEqual(["features","tools"])}});
 it("enforces method and field invariants",()=>{for(const app of APP_DEFINITIONS)for(const method of app.methods){if(method.auth==="api_key")expect(method.keyPlacement).toBeTruthy();if(method.auth==="oauth")expect(method.ownershipModes.length).toBeGreaterThan(0);for(const field of method.credentialFields??[])if(field.required&&field.type!=="checkbox")expect(field.placeholder).toBeTruthy()}});
});
