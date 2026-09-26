import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";
import { ISSUE_LIST_QUERY_PARAMS } from "../services/issues.js";

/**
 * The `GET /api/companies/{companyId}/issues` entry in the OpenAPI document used
 * to declare two parameters: `companyId` and `view`. Thirty-seven names worked.
 * A client authoring against the spec could not discover `identifier`, so it
 * guessed, and a guessed name returned the whole board with status 200.
 *
 * These tests read the built spec document, not the source, so they fail if the
 * declaration and the document ever part ways.
 */
describe("issue list OpenAPI query parameters", () => {
  const spec = buildOpenApiSpec() as {
    paths: Record<
      string,
      {
        get?: {
          parameters?: Array<{
            name: string;
            in: string;
            description?: string;
            schema?: { type?: string };
          }>;
        };
      }
    >;
  };

  const operation = spec.paths["/api/companies/{companyId}/issues"]?.get;
  const queryParams = (operation?.parameters ?? []).filter((p) => p.in === "query");
  const queryNames = queryParams.map((p) => p.name);

  it("declares the exact identifier filter", () => {
    expect(operation, "GET issue list is missing from the spec document").toBeTruthy();
    expect(queryNames).toContain("identifier");
  });

  it("declares the key alias", () => {
    expect(queryNames).toContain("key");
  });

  it("says identifier is exact and warns that q is not", () => {
    const identifier = queryParams.find((p) => p.name === "identifier");
    expect(identifier?.description ?? "").toMatch(/exact/i);
    expect(identifier?.description ?? "").toMatch(/prefix/i);

    const q = queryParams.find((p) => p.name === "q");
    expect(q?.description ?? "").toMatch(/substring/i);
    expect(q?.description ?? "").toMatch(/identifier/);
  });

  it("documents every name in the single source, so the two cannot drift", () => {
    const declared = new Set(Object.keys(ISSUE_LIST_QUERY_PARAMS));
    const documented = new Set(queryNames);
    expect(
      [...declared].filter((name) => !documented.has(name)),
      "a parameter the handler reads is absent from the spec — a client cannot discover it",
    ).toEqual([]);
    expect(
      [...documented].filter((name) => !declared.has(name)),
      "the spec documents a parameter the handler does not read — it would return the whole board",
    ).toEqual([]);
  });

  it("serves the spec with the new parameters over HTTP", async () => {
    const app = express();
    const { openApiRoutes } = await import("../routes/openapi.js");
    app.use(openApiRoutes());

    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);

    const document = res.body as {
      paths: Record<string, { get?: { parameters?: Array<{ name: string; in: string }> } }>;
    };
    const names = (document.paths["/api/companies/{companyId}/issues"]?.get?.parameters ?? [])
      .filter((p) => p.in === "query")
      .map((p) => p.name);
    expect(names).toContain("identifier");
    expect(names).toContain("key");
  });
});
