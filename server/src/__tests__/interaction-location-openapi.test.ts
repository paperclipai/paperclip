import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../routes/openapi.js";

describe("interaction location API contract", () => {
  it("documents the fixed response and company-access denial", () => {
    const route = buildOpenApiDocument().paths["/api/companies/{companyId}/interaction-locations/{interactionId}"].get;
    const schema = route.responses[200].content["application/json"].schema;
    expect(schema.required).toEqual(expect.arrayContaining(["version", "companyId", "interactionId", "issueId"]));
    expect(schema.properties.version).toMatchObject({ type: "number", enum: [1] });
    expect(schema.properties.companyId.type).toBe("string");
    expect(schema.properties.interactionId.format).toBe("uuid");
    expect(schema.properties.issueId.format).toBe("uuid");
    expect(route.responses[403].description).toBe("Forbidden");
    expect(route.responses[404].description).toBe("Not found");
  });
});
