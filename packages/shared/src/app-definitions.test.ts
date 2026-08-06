import { describe,expect,it } from "vitest";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { appDefinitionsSchema } from "./validators/app-definition.js";
describe("AppDefinition catalog",()=>{
 it("validates all Wave 1 definitions",()=>expect(()=>appDefinitionsSchema.parse(APP_DEFINITIONS)).not.toThrow());
 it("contains twelve reviewed providers",()=>expect(APP_DEFINITIONS.map((app)=>app.slug)).toEqual(["zapier","github","slack","notion","linear","google-sheets","context7","oauth-generic","api-key-generic","sentry","vercel","anthropic"]));
 it.each([
  ["notion",["read_content","update_content"]],
  ["linear",["read","write"]],
 ])("preserves required OAuth scopes for %s",(slug,scopes)=>expect(APP_DEFINITIONS.find((app)=>app.slug===slug)?.methods[0]?.defaults?.scopesHint).toEqual(scopes));
 it("enforces method and field invariants",()=>{for(const app of APP_DEFINITIONS)for(const method of app.methods){if(method.auth==="api_key")expect(method.keyPlacement).toBeTruthy();if(method.auth==="oauth")expect(method.ownershipModes.length).toBeGreaterThan(0);for(const field of method.credentialFields??[])if(field.required&&field.type!=="checkbox")expect(field.placeholder).toBeTruthy()}});
});
