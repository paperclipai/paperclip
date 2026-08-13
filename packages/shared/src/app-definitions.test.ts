import { describe,expect,it } from "vitest";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { appDefinitionsSchema } from "./validators/app-definition.js";
describe("AppDefinition catalog",()=>{
 it("validates all Wave 1 definitions",()=>expect(()=>appDefinitionsSchema.parse(APP_DEFINITIONS)).not.toThrow());
 it("contains twelve reviewed providers",()=>expect(APP_DEFINITIONS.map((app)=>app.slug)).toEqual(["zapier","github","slack","notion","linear","google-sheets","context7","oauth-generic","api-key-generic","sentry","vercel","anthropic"]));
 it("uses discovery-first Notion MCP OAuth metadata",()=>{
  const notion=APP_DEFINITIONS.find((app)=>app.slug==="notion");
  expect(notion?.redirectConstraints).toBe("https-or-loopback-http");
  expect(notion?.methods[0]?.defaults).toEqual({serverUrl:"https://mcp.notion.com/mcp"});
 });
 it("preserves required Linear OAuth scopes",()=>expect(APP_DEFINITIONS.find((app)=>app.slug==="linear")?.methods[0]?.defaults?.scopesHint).toEqual(["read","write"]));
 it("enforces method and field invariants",()=>{for(const app of APP_DEFINITIONS)for(const method of app.methods){if(method.auth==="api_key")expect(method.keyPlacement).toBeTruthy();if(method.auth==="oauth")expect(method.ownershipModes.length).toBeGreaterThan(0);for(const field of method.credentialFields??[])if(field.required&&field.type!=="checkbox")expect(field.placeholder).toBeTruthy()}});
});
