import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { openApiRoutes } from "../routes/openapi.js";

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

describe("openapi routes", () => {
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe("Get the generated OpenAPI document");
    expect(res.body.paths["/api/companies/{companyId}/agents"].get.summary).toBe("List agents in a company");
    expect(res.body.paths["/api/agents/{id}/keys"].post.summary).toBe("Create an agent API key");
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
      AgentBearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(res.body.paths["/api/companies"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(res.body.paths["/api/agents/{id}/keys"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
  });
});
