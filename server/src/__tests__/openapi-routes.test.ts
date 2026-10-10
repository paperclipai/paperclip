import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { COMPANY_IMPORT_TRANSFERS_ROUTE_PATH } from "@paperclipai/shared/company-import-transfer";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "pipelines.ts": "/api",
  "cases.ts": "/api",
  "smoke-lab.ts": "/api",
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agents.ts": "/api",
  "agent-commentary.ts": "/api",
  "agent-avatars.ts": "/api",
  "agent-profile-avatar.ts": "/api",
  "announcements.ts": "/api",
  "ai-connections.ts": "/api",
  "decision-models.ts": "/api",
  "attention.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "board-chat.ts": "/api",
  "browser-use.ts": "/api",
  "built-in-agents.ts": "/api",
  "chat-channels.ts": "/api",
  "slack-tools.ts": "/api",
  "email.ts": "/api",
  "cloud.ts": "/api/cloud",
  "customer-success.ts": "/api/customer-success/v1",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "company-skill-policy.ts": "/api",
  "connection-intents.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "dot-runner.ts": "/api",
  "decision-queues.ts": "/api",
  "decisions.ts": "/api",
  "decision-training.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "folders.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "inbox-agent-policy.ts": "/api",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "llms.ts": "/api",
  "managed-agent-profiles.ts": "/api",
  "onboarding-seed.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
  "primary-agent.ts": "/api",
  "public-mcp.ts": "/api",
  "project-tools.ts": "/api",
  "resource-memberships.ts": "/api",
  "remote-agent-profiles.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "summary-slots.ts": "/api",
  "status-cards.ts": "/api",
  "teams-catalog.ts": "/api",
  "tool-access.ts": "/api",
  "voice-sessions.ts": "/api",
  "tool-gateway.ts": "/api",
  "user-profiles.ts": "/api",
};

const ROUTE_LITERAL_PATTERN =
  /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTE_ARRAY_PATTERN = /router\.(get|post|put|patch|delete)\(\s*\[([^\]]+)\]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
const explicitOpenApiCoverageExclusions = new Set<string>();

const explicitOpenApiOperationCoverageExclusions = new Set([
  // Inspection uses its own versioned Cloud-permit/managed-run protocol,
  // documented in CUSTOMER-SUCCESS-INSPECTION.md and the shared contract.
  // Ordinary board sessions and agent API keys cannot invoke these endpoints.
  "GET /api/customer-success/v1/run-authority",
  "POST /api/customer-success/v1/read",
  // OAuth discovery and protocol endpoints have their own metadata contract;
  // browser connection-management operations remain documented in the board API.
  // Markdown rendering of the separately documented assistant setup page.
  "GET /api/mcp/setup.md",
  "GET /.well-known/oauth-authorization-server",
  "POST /mcp/oauth/register",
  "POST /mcp/oauth/device_authorization",
  "GET /mcp/oauth/authorize",
  "POST /mcp/oauth/token",
  "POST /mcp/oauth/revoke",
  "GET /.well-known/oauth-authorization-server/mcp/runner/oauth",
  "POST /mcp/runner/oauth/register",
  "POST /mcp/runner/oauth/device_authorization",
  "GET /mcp/runner/oauth/authorize",
  "POST /mcp/runner/oauth/token",
  "POST /mcp/runner/oauth/revoke",
  // This endpoint is authenticated by the provider signature rather than by a
  // Paperclip board/agent credential. It intentionally stays out of the public
  // board API document, while this exact exclusion keeps route coverage honest.
  "POST /api/chat-webhooks/agentmail/{publicId}",
  "POST /api/chat-webhooks/{publicId}/{provider}",
  "POST /api/voice-webhooks/{publicId}/events",
  "POST /api/voice-webhooks/{publicId}/tools",
]);

// The set of contract-first routes whose OpenAPI document leads the mounted
// request handler. The company-and-environment Claude setup-token login routes
// now have request handlers, so the set is empty. A new contract-first route
// belongs here only until its handler lands.
const specOnlyContractFirstRoutes = new Set<string>([]);

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

// Route files may compose paths from shared path constants inside template
// literals; substitute the constants' values before normalizing.
const routePathConstantSubstitutions: Record<string, string> = {
  "${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}": COMPANY_IMPORT_TRANSFERS_ROUTE_PATH,
};

function normalizeExpressPath(routePath: string) {
  let substituted = routePath;
  for (const [placeholder, value] of Object.entries(
    routePathConstantSubstitutions,
  )) {
    substituted = substituted.split(placeholder).join(value);
  }
  return substituted
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if (file === "public-mcp.ts" && (routePath.startsWith("/mcp/oauth/") || routePath.startsWith("/.well-known/"))) return routePath;
  if (
    (file === "chat-channels.ts" || file === "email.ts") &&
    routePath.startsWith("/api/chat-webhooks/")
  ) {
    return routePath;
  }
  if (file === "voice-sessions.ts" && routePath.startsWith("/api/voice-webhooks/")) return routePath;
  if (file === "tool-gateway.ts" && routePath.startsWith("/mcp/gateways/")) {
    return routePath;
  }
  if (
    file === "connection-intents.ts" &&
    (routePath.startsWith("/mcp/") || routePath.startsWith("/runtime-tools/"))
  ) {
    return routePath;
  }
  if ((file === "companies.ts" || file === "health.ts") && routePath === "/") {
    return prefix;
  }
  if (file === "companies.ts" || file === "health.ts") {
    return `${prefix}${routePath}`;
  }
  if (file === "auth.ts") {
    return `${prefix}${routePath === "/" ? "" : routePath}`;
  }
  return `${prefix}${routePath}`;
}

function loadActualRoutes() {
  const routes = new Set<string>();
  const excludedRoutes = new Set<string>();
  const unknownRouteFiles: string[] = [];

  for (const file of fs
    .readdirSync(ROUTES_DIR)
    .filter((entry) => entry.endsWith(".ts"))) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const operation = `${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`;
      if (explicitOpenApiOperationCoverageExclusions.has(operation)) {
        excludedRoutes.add(operation);
      } else {
        routes.add(operation);
      }
    }

    for (const match of source.matchAll(ROUTE_ARRAY_PATTERN)) {
      for (const literal of match[2].matchAll(/["'`]([^"'`]+)["'`]/g)) {
        const operation = `${match[1].toUpperCase()} ${normalizeExpressPath(resolveMountedPath(file, prefix, literal[1]))}`;
        if (explicitOpenApiOperationCoverageExclusions.has(operation)) excludedRoutes.add(operation);
        else routes.add(operation);
      }
    }

    if (file === "public-mcp.ts") {
      // The shared gateway mounts these protocol paths for each OAuth resource.
      if (source.includes("router.get(metadataPath,")) {
        excludedRoutes.add("GET /.well-known/oauth-authorization-server");
        excludedRoutes.add("GET /.well-known/oauth-authorization-server/mcp/runner/oauth");
      }
      for (const match of source.matchAll(/router\.(get|post)\(oauthPath \+ "([^"]+)"/g)) {
        for (const oauthPath of ["/mcp/oauth", "/mcp/runner/oauth"]) {
          const operation = `${match[1].toUpperCase()} ${oauthPath}${match[2]}`;
          if (explicitOpenApiOperationCoverageExclusions.has(operation)) excludedRoutes.add(operation);
          else routes.add(operation);
        }
      }
    }
    if (file === "dot-runner.ts") {
      for (const name of ["path", "invitePath"]) {
        const basePath = new RegExp(`const ${name} = "([^"]+)"`).exec(source)?.[1];
        if (!basePath) throw new Error(`Dot ${name} route prefix is missing`);
        const methods = new RegExp(`router\\.(get|post|delete)\\(${name}(?: \\+ "([^"]+)")?`, "g");
        for (const match of source.matchAll(methods)) {
          routes.add(`${match[1].toUpperCase()} ${normalizeExpressPath(prefix + basePath + (match[2] ?? ""))}`);
        }
      }
    }

    if (
      file === "companies.ts" &&
      source.includes("router.post(COMPANY_IMPORT_ROUTE_PATH")
    ) {
      routes.add("POST /api/companies/import");
    }
    if (
      file === "companies.ts" &&
      source.includes("router.post(COMPANY_IMPORT_TRANSFERS_ROUTE_PATH")
    ) {
      routes.add(`POST /api/companies${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}`);
    }
  }

  return {
    routes,
    excludedRoutes,
    unknownRouteFiles: unknownRouteFiles.sort(),
  };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<
    Record<string, Record<string, unknown>>
  >(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
}

describe("openapi routes", () => {
  it("documents only writable agent update fields and lifecycle status requests", () => {
    const document = buildOpenApiSpec() as any;
    const properties = document.paths["/api/agents/{id}"].patch.requestBody.content["application/json"].schema.properties;
    expect(properties).not.toHaveProperty("spentMonthlyCents");
    expect(properties.status.enum).toEqual(["paused", "idle", "terminated"]);
    expect(properties).toHaveProperty("name");
    expect(properties).toHaveProperty("budgetMonthlyCents");
  });

  it("documents public Dot pairing capabilities while ordinary consent keeps board authentication", () => {
    const spec = buildOpenApiSpec() as any;
    for (const [method, path] of [
      ["get", "/api/dot-mcp/requests/{id}"],
      ["post", "/api/dot-mcp/requests/{id}/dot-pairing"],
      ["post", "/api/dot-mcp/requests/{id}/dot-pairing/preview"],
    ]) {
      expect(spec.paths[path][method].security).toEqual([]);
      expect(spec.paths[path][method].responses["404"]).toBeDefined();
    }
    expect(spec.paths["/api/mcp/requests/{id}/consent"].post.security).not.toEqual([]);
  });

  it("documents manager-only task privacy hints without protected scope identity", () => {
    const spec = buildOpenApiSpec() as any;
    const operation = spec.paths["/api/issues/{id}/privacy-constraints"].get;
    const schema = operation.responses["200"].content["application/json"].schema;
    expect(schema.properties).toEqual({
      publicBlockedBy: { type: "string", enum: ["parent", "project"], nullable: true },
      leavesPersonalProject: { type: "boolean" },
    });
    expect(schema.required).toEqual(["publicBlockedBy", "leavesPersonalProject"]);
    expect(operation.responses["403"]).toBeDefined();
    expect(operation.responses["404"]).toBeDefined();
  });

  it("documents strict run-attributed feedback without a read endpoint", () => {
    const { spec } = loadSpecRoutes();
    const path = spec.paths["/api/companies/{companyId}/agent-commentary"];
    expect(Object.keys(path)).toEqual(["post"]);
    const operation = path.post;
    expect(operation.security).toEqual([{ AgentBearerAuth: [] }]);
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "agent", heartbeatBound: true });
    expect(operation.description).toContain("X-Paperclip-Run-Id");
    const body = operation.requestBody.content["application/json"].schema;
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties).sort()).toEqual(["body", "idempotencyKey", "kind"]);
    expect(body.properties.body.maxLength).toBe(524288);
    for (const code of ["200", "201"]) {
      const result = operation.responses[code].content["application/json"].schema;
      expect(result.additionalProperties).toBe(false);
      expect(Object.keys(result.properties).sort()).toEqual(["createdAt", "id", "kind", "replayed"]);
    }
    expect(operation.responses["409"]).toBeDefined();
    expect(operation.responses["503"]).toBeDefined();
  });

  it("documents board-only pool management with revision-checked deletion", () => {
    const { spec } = loadSpecRoutes();
    const pools = spec.paths["/api/companies/{companyId}/ai-connection-pools"];
    const remove = spec.paths["/api/companies/{companyId}/ai-connection-pools/{poolId}"].delete;
    const inspection = spec.paths["/api/companies/{companyId}/ai-connection-pools/{poolId}/inspection"].get;
    for (const operation of [pools.get, pools.post, remove, inspection]) {
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    expect(remove.requestBody.required).toBe(true);
    expect(remove.requestBody.content["application/json"].schema).toMatchObject({
      required: ["expectedRevision"], additionalProperties: false,
      properties: { expectedRevision: { type: "integer", minimum: 0, exclusiveMinimum: true } },
    });
    expect(Object.keys(remove.responses)).toEqual(expect.arrayContaining(["200", "400", "401", "403", "404", "409"]));
  });

  it("documents personal board-only announcements and private responses", () => {
    const { spec } = loadSpecRoutes();
    const current = spec.paths["/api/announcements/current"].get;
    const image = spec.paths["/api/announcements/{id}/image"].get;
    const animation = spec.paths["/api/announcements/{id}/animation"].get;
    const dismiss = spec.paths["/api/announcements/{id}/dismiss"].post;
    for (const operation of [current, image, animation, dismiss]) {
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      const success = operation.responses["200"] ?? operation.responses["204"];
      expect(success.headers["Cache-Control"].schema.enum).toEqual(["private, no-store"]);
    }
    expect(current.responses["200"].content["application/json"].schema.nullable).toBe(true);
    expect(Object.keys(image.responses["200"].content)).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(dismiss.requestBody.content["application/json"].schema).toMatchObject({
      required: ["companyId"], additionalProperties: false,
    });
    expect(dismiss.description).toContain("viewers may dismiss their own");
  });

  it("documents exact failed-run selection and durable accepted retry responses", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const wake = res.body.paths["/api/agents/{id}/wakeup"].post;
    expect(
      wake.requestBody.content["application/json"].schema.properties
        .failedRunId,
    ).toMatchObject({ type: "string", format: "uuid" });
    expect(wake.responses["202"]).toBeDefined();
    expect(wake.responses["409"]).toBeDefined();
    expect(wake.description).toContain("durable queued/deferred receipt");
  });
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe(
      "Get the generated OpenAPI document",
    );
    expect(
      res.body.paths["/api/companies/{companyId}/agents"].get.summary,
    ).toBe("List agents in a company");
    expect(res.body.paths["/api/agents/{id}/keys"].post.summary).toBe(
      "Create an agent API key",
    );
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
      AgentBearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(res.body.paths["/api/mcp/project-tools"].post.security).toEqual([{ AgentRunAuth: [] }]);
    expect(res.body.paths["/api/mcp/project-tools"].post["x-paperclip-authorization"]).toEqual({ actor: "agent", heartbeatBound: true, taskBound: true });
    expect(res.body.paths["/mcp/gateways/{gatewayPublicId}"].post.security).toEqual([]);
    expect(res.body.paths["/api/mcp/gateways/{gatewayPublicId}"]).toBeUndefined();
    expect(res.body.paths["/api/companies"].get.parameters).toContainEqual({
      name: "scope",
      in: "query",
      required: false,
      schema: { type: "string", enum: ["accessible"] },
    });
    expect(res.body.paths["/api/companies"].get.responses["403"]).toBeDefined();
    expect(res.body.paths["/api/companies"].get.responses["400"]).toBeDefined();
    expect(
      res.body.paths["/api/companies"].post.responses["201"],
    ).toBeDefined();
    expect(
      res.body.paths["/api/companies"].post.requestBody.content[
        "application/json"
      ].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(
      JSON.stringify(res.body.paths["/api/companies"].post.responses),
    ).not.toContain("candidates");
    expect(
      res.body.paths["/api/companies/{companyId}/skills/scan-projects"].post
        .responses["200"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        candidates: { type: "array" },
      },
      required: expect.arrayContaining(["candidates"]),
    });
    expect(
      res.body.paths["/api/agents/{id}/keys"].post.requestBody.content[
        "application/json"
      ].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
    expect(
      res.body.paths["/api/companies/{companyId}/folders"].post.responses[
        "201"
      ],
    ).toBeDefined();
    expect(
      Object.keys(
        res.body.paths[
          "/api/issues/{id}/work-products/{workProductId}/review-document"
        ].post.responses,
      ).sort(),
    ).toEqual(["200", "201", "401", "403", "404", "409", "413", "415", "422"]);
    expect(
      res.body.paths["/api/issues/{id}/interactions/{interactionId}/withdraw"]
        .post.summary,
    ).toBe("Withdraw a pending issue thread interaction");
    const createInteraction =
      res.body.paths["/api/issues/{id}/interactions"].post;
    expect(createInteraction.description).toContain(
      "defaults to canonical `anyone`",
    );
    const createInteractionSchema = JSON.stringify(
      createInteraction.requestBody.content["application/json"].schema,
    );
    for (const resolverPolicy of [
      "anyone",
      "not_creator",
      "human_only",
      "board_or_agents",
      "board_only",
    ]) {
      expect(createInteractionSchema).toContain(`\"${resolverPolicy}\"`);
    }
    expect(
      res.body.paths["/api/companies/{companyId}/folders/items/move"].post
        .summary,
    ).toBe("Move an item into or out of a folder");
    const createQueue =
      res.body.paths["/api/companies/{companyId}/decision-queues"].post;
    expect(createQueue.security).toContainEqual({ AgentBearerAuth: [] });
    expect(createQueue.responses["200"]).toBeDefined();
    expect(createQueue.responses["201"]).toBeDefined();
    expect(
      createQueue.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        key: { type: "string", minLength: 1, maxLength: 80 },
        title: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["key", "title"],
    });
    const updateTriage =
      res.body.paths[
        "/api/companies/{companyId}/decision-triage/{sourceKind}/{sourceId}"
      ].put;
    expect(updateTriage.responses["422"]).toBeDefined();
    expect(
      updateTriage.requestBody.content["application/json"].schema.properties,
    ).toMatchObject({
      decideBy: { nullable: true },
      snoozedUntil: { type: "string", format: "date-time", nullable: true },
    });
    expect(
      JSON.stringify(res.body.paths["/api/tool-gateway/tools"].get),
    ).not.toContain("sessionToken");
    expect(
      JSON.stringify(res.body.paths["/api/tool-gateway/tools/call"].post),
    ).not.toContain("sessionToken");
  });

  it("publishes the complete board contract for chat channels", () => {
    const { spec } = loadSpecRoutes();
    const boardSecurity = [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }];
    const operations = [
      ["get", "/api/companies/{companyId}/chat-endpoints"],
      ["post", "/api/companies/{companyId}/chat-endpoints"],
      ["get", "/api/chat-endpoints/{endpointId}"],
      ["get", "/api/chat-endpoints/{endpointId}/github/configuration"],
      ["put", "/api/chat-endpoints/{endpointId}/github/configuration"],
      ["post", "/api/chat-endpoints/{endpointId}/github/verify"],
      ["put", "/api/chat-endpoints/{endpointId}/github/progress"],
      ["get", "/api/chat-endpoints/{endpointId}/github/reviews"],
      ["get", "/api/chat-endpoints/{endpointId}/github/personal-connections"],
      ["post", "/api/chat-endpoints/{endpointId}/github/identity"],
      ["post", "/api/chat-endpoints/{endpointId}/github/people/lookup"],
      ["post", "/api/chat-endpoints/{endpointId}/github/registration"],
      ["post", "/api/chat-endpoints/{endpointId}/github/app"],
      ["post", "/api/chat-endpoints/{endpointId}/github/repositories/refresh"],
      ["patch", "/api/chat-endpoints/{endpointId}"],
      ["post", "/api/chat-endpoints/{endpointId}/setup"],
      ["post", "/api/chat-endpoints/{endpointId}/setup-secret"],
      ["post", "/api/chat-endpoints/{endpointId}/test"],
      ["post", "/api/chat-endpoints/{endpointId}/photon/inspect"],
      ["get", "/api/chat-endpoints/{endpointId}/resources"],
      ["put", "/api/chat-endpoints/{endpointId}/resources"],
      ["get", "/api/chat-endpoints/{endpointId}/principals"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link-intent",
      ],
      [
        "delete",
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link",
      ],
      ["get", "/api/chat-identity-links/preview"],
      ["post", "/api/chat-identity-links/confirm"],
      ["get", "/api/chat-endpoints/{endpointId}/conversations"],
      ["get", "/api/chat-endpoints/{endpointId}/activity"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay",
      ],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/replay",
      ],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve",
      ],
      ["post", "/api/chat-endpoints/{endpointId}/actions/{actionId}/resolve"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications",
      ],
      ["get", "/api/issues/{issueId}/chat-binding"],
      [
        "get",
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications/{publicationId}/status",
      ],
    ] as const;

    for (const [method, routePath] of operations) {
      const operation = spec.paths[routePath]?.[method];
      expect(
        operation,
        `${method.toUpperCase()} ${routePath} is documented`,
      ).toBeDefined();
      expect(
        operation.security,
        `${method.toUpperCase()} ${routePath} is board-only`,
      ).toEqual(boardSecurity);
      expect(operation["x-paperclip-authorization"]).toEqual({
        actor: "board",
      });
      expect(operation.tags).toContain("chat-channels");
    }

    const create = spec.paths["/api/companies/{companyId}/chat-endpoints"].post;
    expect(create.responses["201"]).toBeDefined();
    expect(create.requestBody.content["application/json"].schema).toMatchObject(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          provider: {
            type: "string",
            enum: ["slack", "github", "discord", "microsoft-teams", "telegram", "speko", "imessage-photon"],
          },
          assignedAgentId: { type: "string", format: "uuid" },
        },
        required: ["provider", "assignedAgentId"],
      },
    );

    const endpointResponse =
      spec.paths["/api/chat-endpoints/{endpointId}"].get.responses["200"]
        .content["application/json"].schema;
    expect(endpointResponse).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        assignedAgentId: { type: "string", format: "uuid" },
        status: {
          type: "string",
          enum: [
            "draft",
            "verifying",
            "active",
            "paused",
            "attention",
            "revoked",
            "archived",
          ],
        },
        capabilities: { type: "object", additionalProperties: false },
        setup: { type: "object", additionalProperties: false },
      },
    });
    expect(JSON.stringify(endpointResponse)).not.toContain('"credentials":');
    expect(JSON.stringify(endpointResponse)).not.toContain("privateKey");
    expect(JSON.stringify(endpointResponse)).not.toContain("signingSecret");
    expect(
      endpointResponse.properties.setup.properties.callbacksNeedUpdate,
    ).toEqual({ type: "boolean" });
    expect(
      endpointResponse.properties.setup.properties.callbackSurfaces.properties
        .events.properties.status.enum,
    ).toEqual(["current", "stale", "unverified"]);

    const setup = spec.paths["/api/chat-endpoints/{endpointId}/setup"].post;
    expect(
      setup.requestBody.content["application/json"].schema.properties.action
        .enum,
    ).toEqual([
      "configure",
      "verify",
      "pause",
      "resume",
      "reconnect",
      "remove",
    ]);
    expect(setup.description).toContain(
      "Discord: `applicationId`, `guildId`, `botToken`",
    );
    expect(setup.responses["409"]).toBeDefined();
    expect(setup.responses["422"]).toBeDefined();
    expect(setup.responses["502"]).toBeDefined();
    expect(setup.responses["503"]).toBeDefined();

    const photon = spec.paths["/api/chat-endpoints/{endpointId}/photon/inspect"].post;
    expect(photon.requestBody.content["application/json"].schema.required).toEqual([
      "projectId", "projectSecret",
    ]);
    const photonResponse = photon.responses["200"].content["application/json"].schema;
    expect(photonResponse.properties.allocation.enum).toEqual(["dedicated", "shared"]);
    expect(photonResponse.properties.lines.items.additionalProperties).toBe(false);
    expect(JSON.stringify(photonResponse)).not.toMatch(/projectSecret|token/);
    expect(photon.responses["422"]).toBeDefined();
    expect(photon.responses["429"]).toBeDefined();
    expect(photon.responses["502"]).toBeDefined();
    expect(photon.responses["503"]).toBeDefined();

    const setupSecret =
      spec.paths["/api/chat-endpoints/{endpointId}/setup-secret"].post;
    expect(
      setupSecret.responses["201"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["webhookSecret"],
    });
    expect(setupSecret.responses["409"]).toBeDefined();
    expect(setupSecret.responses["422"]).toBeDefined();

    const resolveAction =
      spec.paths["/api/chat-endpoints/{endpointId}/actions/{actionId}/resolve"]
        .post;
    expect(
      resolveAction.requestBody.content["application/json"].schema.properties
        .action.enum,
    ).toEqual(["mark_delivered", "retry_anyway", "cancel"]);
    expect(resolveAction.responses["409"]).toBeDefined();
    expect(resolveAction.responses["422"]).toBeDefined();

    const activity =
      spec.paths["/api/chat-endpoints/{endpointId}/activity"].get.responses[
        "200"
      ].content["application/json"].schema.oneOf[0].items;
    expect(activity.properties.actionType.enum).toEqual([
      "slash_task_start",
      "provider_effect",
      "github_webhook_ingress",
      "slack_session_sync",
      "slack_session_stop",
    ]);
    const fileTransfer = activity.properties.fileTransfer;
    expect(fileTransfer).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["provider", "phase", "filename", "version"],
      properties: {
        provider: { type: "string", enum: ["microsoft-teams"] },
        version: { type: "integer", minimum: 0, exclusiveMinimum: true },
      },
    });
    expect(Object.keys(fileTransfer.properties).sort()).toEqual([
      "expiresAt",
      "filename",
      "phase",
      "provider",
      "version",
    ]);
    expect(fileTransfer.properties.phase.enum).toHaveLength(15);
    const boardSend =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications"
      ].post;
    expect(boardSend.responses["409"]).toBeDefined();
    expect(boardSend.responses["422"]).toBeDefined();
    expect(boardSend.description).toContain(
      "chat_board_send_attachments_already_bound",
    );
    expect(boardSend.description).toContain(
      "Other errors do not establish non-delivery",
    );
    const batchStatus =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications/{publicationId}/status"
      ].get.responses["200"].content["application/json"].schema;
    expect(batchStatus.required).toEqual(
      expect.arrayContaining([
        "publication",
        "parts",
        "total",
        "published",
        "awaitingConsent",
        "declined",
        "expired",
        "cancelled",
        "settled",
        "canDismiss",
      ]),
    );
    expect(batchStatus.properties.parts.items.properties.fileTransfer).toEqual(
      fileTransfer,
    );
    expect(batchStatus.properties.publication.properties.state.enum).toContain(
      "awaiting_consent",
    );
    const resolvePublication =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve"
      ].post.requestBody.content["application/json"].schema;
    expect(resolvePublication.properties.fileTransfer).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["phase", "version"],
      properties: {
        phase: { enum: fileTransfer.properties.phase.enum },
        version: { type: "integer", minimum: 0, exclusiveMinimum: true },
      },
    });
    expect(JSON.stringify(batchStatus)).not.toMatch(
      /uploadUrl|privateState|tokenSha256|credentialFingerprint/,
    );

    const replaceResources =
      spec.paths["/api/chat-endpoints/{endpointId}/resources"].put;
    expect(
      replaceResources.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["resources"],
    });
    expect(replaceResources.responses["409"]).toBeDefined();
    expect(replaceResources.responses["422"]).toBeDefined();

    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link"
      ].delete.responses["204"],
    ).toBeDefined();
    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay"
      ].post.responses["204"],
    ).toBeDefined();
    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/replay"
      ].post.responses["204"],
    ).toBeDefined();

    const endpointScopedOperations = operations.filter(
      ([, routePath]) =>
        routePath.includes("{endpointId}") ||
        routePath === "/api/issues/{issueId}/chat-binding",
    );
    for (const [method, routePath] of endpointScopedOperations) {
      expect(
        spec.paths[routePath][method].responses["404"],
        `${method.toUpperCase()} ${routePath} preserves the non-member 404 boundary`,
      ).toBeDefined();
    }

    expect(
      spec.paths["/api/chat-webhooks/{publicId}/{provider}"],
    ).toBeUndefined();
  });

  it("documents session-bound voice authority without durable credentials", () => {
    const {spec} = loadSpecRoutes();
    const start = spec.paths["/api/companies/{companyId}/voice-sessions"].post;
    expect(start.security).toEqual([{BoardSessionAuth: []}]);
    expect(start["x-paperclip-authorization"]).toEqual({actor: "board", sessionBound: true});
    expect(start.requestBody.content["application/json"].schema.required).toEqual(expect.arrayContaining(["endpointId", "idempotencyKey"]));
    expect(start.responses["201"]).toBeDefined();
    expect(JSON.stringify(start.responses)).not.toContain("signingSecret");
    expect(spec.paths["/api/voice-webhooks/{publicId}/tools"]).toBeUndefined();
    expect(spec.paths["/api/voice-webhooks/{publicId}/events"]).toBeUndefined();
    const decision=spec.paths["/api/companies/{companyId}/voice-phone/{endpointId}/incoming/{callId}"].post;
    expect(decision.requestBody.content["application/json"].schema.required).toEqual(expect.arrayContaining(["approve", "approvalCode"]));
  });

  it("covers the mounted server routes exactly", () => {
    const {
      routes: actualRoutes,
      excludedRoutes,
      unknownRouteFiles,
    } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes]
      .filter((route) => !specRoutes.has(route))
      .sort();
    const extraInSpec = [...specRoutes]
      .filter(
        (route) =>
          !actualRoutes.has(route) && !specOnlyContractFirstRoutes.has(route),
      )
      .sort();

    expect({
      unknownRouteFiles,
      missingInSpec,
      extraInSpec,
      excludedRoutes: [...excludedRoutes].sort(),
    }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
      excludedRoutes: [...explicitOpenApiOperationCoverageExclusions].sort(),
    });
  });

  it("documents the authenticated personal primary-agent contract", () => {
    const { spec } = loadSpecRoutes();
    const path = spec.paths["/api/companies/{companyId}/primary-agent/me"];
    for (const operation of [path.get, path.put]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
      expect(operation.responses["200"].content["application/json"].schema.required).toEqual([
        "companyId", "userId", "primaryAgentId", "initialized",
      ]);
    }
    expect(path.put.requestBody.content["application/json"].schema).toMatchObject({
      additionalProperties: false,
      required: ["primaryAgentId"],
      properties: { primaryAgentId: { type: "string", format: "uuid" } },
    });
    expect(path.put.responses["422"]).toBeDefined();
  });

  it("documents operator Dot invitations and current pairing and event-test fields", () => {
    const { spec } = loadSpecRoutes();
    const invitations = spec.paths["/api/companies/{companyId}/dot-invitations"];
    for (const operation of [invitations.get, invitations.post]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.responses["200"]).toBeDefined();
    }
    expect(invitations.post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    const base = "/api/companies/{companyId}/agents/{agentId}/dot-binding";
    expect(spec.paths[base].post.requestBody.content["application/json"].schema.properties.replaceBindingId).toMatchObject({ type: "string", format: "uuid" });
    expect(spec.paths[base + "/event-test"].post.requestBody.content["application/json"].schema.properties.bindingId).toMatchObject({ type: "string", format: "uuid" });
  });

  it("documents board-only repository discovery and selection", () => {
    const { spec } = loadSpecRoutes();
    const discovery = spec.paths["/api/companies/{companyId}/project-repositories"].get;
    const replacement = spec.paths["/api/projects/{id}/repositories"].put;
    for (const operation of [discovery, replacement]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    expect(replacement.requestBody.content["application/json"].schema.required).toContain("repositoryIds");
    expect(replacement.responses["422"]).toBeDefined();
  });

  it("documents the manager-only GitHub wizard and compatible owner-aware registration", () => {
    const { spec } = loadSpecRoutes();
    for (const [suffix, method] of [["draft", "put"], ["setup", "post"], ["identity/start", "post"], ["identity/confirm", "post"]]) {
      const operation = spec.paths[`/api/chat-endpoints/{endpointId}/github/${suffix}`][method];
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    const registration = spec.paths["/api/chat-endpoints/{endpointId}/github/registration"].post;
    const input = registration.requestBody.content["application/json"].schema;
    expect(input.properties.ownerType.enum).toEqual(["personal", "organization"]);
    expect(input.required).not.toContain("ownerType");
    const response = registration.responses["200"].content["application/json"].schema;
    expect(response.oneOf ?? response.anyOf).toHaveLength(2);
  });

  it("documents GitHub recovery, draft receipts, paged repositories and old review lookups", () => {
    const { spec } = loadSpecRoutes();
    const root = "/api/chat-endpoints/{endpointId}/github/";
    const setup = spec.paths[root + "setup"].post.responses["200"].content["application/json"].schema;
    expect(setup.properties.restartableRegistrationId.format).toBe("uuid");
    const restart = spec.paths[root + "registration/restart"].post;
    expect(restart["x-paperclip-authorization"]).toEqual({ actor: "board" });
    const restartInput = restart.requestBody.content["application/json"].schema;
    expect(restartInput.required).toEqual(expect.arrayContaining(["registrationId", "appNotCreated"]));
    expect(restartInput.properties.appNotCreated.enum ?? [restartInput.properties.appNotCreated.const]).toEqual([true]);
    const receipt = spec.paths[root + "draft"].put.responses["200"].content["application/json"].schema;
    expect(receipt.required).toEqual(["saved"]);
    expect(receipt.properties).not.toHaveProperty("state");
    const app = spec.paths[root + "app"].post.requestBody.content["application/json"].schema;
    expect(app.properties.clientId).toBeDefined();
    expect(app.properties.clientSecret).toBeDefined();
    expect(app.required).not.toContain("clientId");
    const page = spec.paths[root + "repositories"].get;
    expect(page.parameters.map((param: { name: string }) => param.name)).toEqual(expect.arrayContaining(["endpointId", "offset", "limit", "search"]));
    expect(page.responses["200"].content["application/json"].schema.properties).toHaveProperty("totalCount");
    expect(spec.paths[root + "repositories/access"].put["x-paperclip-authorization"]).toEqual({ actor: "board" });
    const review = spec.paths[root + "reviews/{reviewId}"].get;
    expect(review.parameters.map((param: { name: string }) => param.name)).toEqual(["endpointId", "reviewId"]);
    expect(review.responses["404"]).toBeDefined();
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(
      spec.paths["/runtime-tools/github/credentials"].post.security,
    ).toEqual([{ RuntimeToolsBearerAuth: [] }]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(
      spec.paths["/api/plugins/install"].post["x-paperclip-authorization"],
    ).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(
      spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(
      spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post[
        "x-paperclip-authorization"
      ],
    ).toEqual({
      actor: "board",
    });
    expect(
      spec.paths["/api/companies/{companyId}/cost-events"].post.responses[
        "201"
      ],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/{companyId}/cost-events"].post.responses[
        "403"
      ],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/{companyId}/managed-agent-profiles"].post
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(
      spec.paths["/api/companies/{companyId}/remote-agent-profiles"].get
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    const remoteAgentProfileBody =
      spec.paths["/api/companies/{companyId}/remote-agent-profiles"].post
        .requestBody.content["application/json"].schema;
    expect(remoteAgentProfileBody.properties.service).toMatchObject({
      type: "string",
      enum: ["aws_bedrock_agentcore_harness"],
    });
    expect(
      remoteAgentProfileBody.properties.credentialSecretId,
    ).toBeUndefined();
    expect(
      spec.paths["/api/instance/database-backups"].post.responses["201"],
    ).toBeDefined();
    expect(
      spec.paths["/api/invites/{token}/accept"].post.responses["202"],
    ).toBeDefined();
    expect(
      spec.paths["/api/board-api-keys"].post.responses["201"],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/import"].post.responses["202"],
    ).toBeDefined();
    expect(
      spec.paths["/api/routines/{id}/run"].post.responses["422"],
    ).toBeDefined();
  });

  it("publishes the Claude browser-code grammar and strict setup-token response shapes", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/setup-token-login-sessions";

    // The submitted browser code carries the bounded printable-ASCII grammar.
    const codeBody =
      spec.paths[`${base}/{sessionId}/code`].post.requestBody.content[
        "application/json"
      ].schema;
    const browserCode = codeBody.properties.browserCode;
    expect(browserCode.minLength).toBe(1);
    expect(browserCode.maxLength).toBe(512);
    expect(typeof browserCode.pattern).toBe("string");
    expect(browserCode.pattern.length).toBeGreaterThan(0);

    // Every Claude request object forbids an unknown property.
    const startBody =
      spec.paths[base].post.requestBody.content["application/json"].schema;
    expect(startBody.additionalProperties).toBe(false);
    expect(codeBody.additionalProperties).toBe(false);

    // The four contract-first routes carry typed strict response schemas.
    const responseSchemas: Record<string, Record<string, unknown>> = {
      start:
        spec.paths[base].post.responses["201"].content["application/json"]
          .schema,
      status:
        spec.paths[`${base}/{sessionId}`].get.responses["200"].content[
          "application/json"
        ].schema,
      prompt:
        spec.paths[`${base}/{sessionId}/prompt`].get.responses["200"].content[
          "application/json"
        ].schema,
      code: spec.paths[`${base}/{sessionId}/code`].post.responses["200"]
        .content["application/json"].schema,
    };
    const forbiddenProperties = ["token", "accountId", "leaseId"];
    for (const [name, schema] of Object.entries(responseSchemas)) {
      expect(schema.type, `${name} response is a typed object`).toBe("object");
      expect(schema.additionalProperties, `${name} response is strict`).toBe(
        false,
      );
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      expect(
        Object.keys(properties).length,
        `${name} response lists properties`,
      ).toBeGreaterThan(0);
      for (const forbidden of forbiddenProperties) {
        expect(
          properties[forbidden],
          `${name} response hides ${forbidden}`,
        ).toBeUndefined();
      }
      // No property name looks like a raw prompt secret or a token.
      for (const property of Object.keys(properties)) {
        expect(
          /token|secret|accountId|leaseId/i.test(property),
          `${name}.${property} is not secret-adjacent`,
        ).toBe(false);
      }
    }

    // The status and code routes share the public response; it hides the prompt.
    expect(responseSchemas.status.properties).toEqual(
      responseSchemas.code.properties,
    );
    expect(
      (responseSchemas.status.properties as Record<string, unknown>).prompt,
    ).toBeUndefined();
    // The owner start response adds the panel mode and the one-time prompt.
    expect(
      (responseSchemas.start.properties as Record<string, unknown>).panelMode,
    ).toBeDefined();
    expect(
      (responseSchemas.start.properties as Record<string, unknown>).prompt,
    ).toBeDefined();
    // The prompt route returns the authorization URL and the optional transport
    // advisory. The advisory is present on a non-confidential transport, so the
    // client can show a non-blocking disclaimer.
    expect(
      Object.keys(responseSchemas.prompt.properties as Record<string, unknown>),
    ).toEqual(["authorizationUrl", "transportAdvisory"]);
  });

  it("documents the 404 non-member gate on the Claude setup-token cancel route", () => {
    const { spec } = loadSpecRoutes();
    const cancel =
      spec.paths[
        "/api/companies/{companyId}/setup-token-login-sessions/{sessionId}/cancel"
      ].post;
    // The 404 is reachable at run time. The company-access gate returns a fixed
    // 404 for a non-member before the cancel logic runs, so the spec declares
    // it. The idempotent cancel still returns 200 for an owner-scoped missing,
    // terminal, or foreign session id.
    const codes = Object.keys(cancel.responses).sort();
    expect(codes).toEqual(["200", "401", "403", "404"]);
  });
});


describe("heartbeat run ID OpenAPI contract", () => {
  it("publishes the runtime UUID constraint and 400 response on all agent-router run endpoints", async () => {
    const response = await request(createApp()).get("/api/openapi.json");
    expect(response.status).toBe(200);
    const paths = response.body.paths;
    let checked = 0;
    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/api/heartbeat-runs/{runId}") || path.endsWith("/issues")) continue;
      for (const operation of Object.values(operations as Record<string, any>)) {
        const parameter = operation.parameters.find((param: { name: string }) => param.name === "runId");
        expect(parameter.schema.pattern).toEqual(expect.any(String));
        const pattern = new RegExp(parameter.schema.pattern);
        for (const id of [
          "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "AAAAAAAA-AAAA-5AAA-BAAA-AAAAAAAAAAAA",
        ]) expect(pattern.test(id), id).toBe(true);
        for (const id of [
          "undefined", "not-a-uuid", " aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ",
          "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
        ]) expect(pattern.test(id), JSON.stringify(id)).toBe(false);
        expect(operation.responses["400"]).toBeDefined();
        checked++;
      }
    }
    expect(checked).toBe(12);
  });
});

// Reading a comment thread completely is a three-part mechanism — a page limit
// that clamps, a keyset cursor whose empty page is ambiguous, and a total that
// lives on a sibling route — and the document used to declare none of it. Both
// routes published `{"type":"object","additionalProperties":{}}`, which codegen
// turns into `Record<string, unknown>`: a type that reads as a contract and
// carries nothing. Three separate investigations consulted it and came away
// with a wrong conclusion about the API.
describe("issue comment completeness OpenAPI contract", () => {
  const paramsOf = (operation: Record<string, any>) =>
    new Map<string, any>(
      (operation.parameters ?? []).map((param: any) => [param.name, param]),
    );

  it("declares the comment paging parameters", () => {
    const { spec } = loadSpecRoutes();
    const operation = spec.paths["/api/issues/{id}/comments"].get;
    const params = paramsOf(operation);

    expect([...params.keys()].sort()).toEqual([
      "after",
      "afterCommentId",
      "id",
      "limit",
      "order",
    ]);
    for (const name of ["limit", "after", "afterCommentId", "order"]) {
      expect(params.get(name).in, name).toBe("query");
      expect(params.get(name).required, name).toBe(false);
      expect(params.get(name).description, name).toEqual(expect.any(String));
    }
    expect(params.get("limit").schema.type).toBe("integer");
    expect(params.get("order").schema.enum).toEqual(["asc", "desc"]);
    // The handler tolerates an unknown `order` by falling back to `desc`, but
    // the contract must not promise it: a generated client or a contract
    // validator rejects what the enum excludes, so prose describing the
    // leniency documents behaviour a conforming consumer cannot use. This pins
    // the one phrase that promised it, not the general class.
    expect(params.get("order").description).not.toContain("other than");
    expect(params.get("order").description).toContain("asc");

    // The clamp is published as a mechanism, never as a number — and NEITHER
    // END of the range is published, which is the part that needs a test.
    //
    // CORRECTED: an earlier version of this comment said the bound is omitted
    // because "the constant cannot be imported here". That reason is too
    // strong. Importing from `services/issues.js` is what turned 81 tests in
    // two unrelated route suites red (`openapi.ts` is reachable from
    // `routes/agents.ts`, and those suites mock that module partially), but
    // the sibling artifacts route publishes `maximum: 100` from a constant in
    // `@paperclipai/shared`, which no server suite mocks. An import route
    // exists; it is the DECLARATION that would be wrong.
    //
    // This handler validates nothing. A `limit` that is not a finite number
    // above zero becomes `null`, meaning NO limit, so `0`, `-5` and `abc` are
    // accepted and return the whole thread. A published range is what a
    // contract validator and a generated client enforce, so `minimum` would
    // reject requests the server honours and `maximum` would reject an
    // over-cap request that in fact succeeds with a clamped page. The
    // artifacts route may publish its range because its query schema is the
    // parser; this one's bound is a post-parse clamp.
    expect(params.get("limit").schema.maximum).toBeUndefined();
    expect(params.get("limit").schema.minimum).toBeUndefined();
    expect(params.get("limit").schema.exclusiveMinimum).toBeUndefined();
    expect(params.get("limit").description).toContain("clamped");
    expect(params.get("limit").description).not.toMatch(/\d{3,}/);
    // The leniency has to be stated, or dropping the constraint just removes
    // information: an unlimited read is the surprising outcome a caller needs
    // warned about, and it is what `limit=0` returns.
    expect(params.get("limit").description).toMatch(/zero|negative/i);
    expect(params.get("limit").description).toContain("NO limit");
  });

  // A control for the two pins above: the sibling route that CAN publish a
  // range still does. Without it, `minimum`/`maximum` being undefined is also
  // what a converter that stopped emitting ranges at all would produce, and
  // both pins would pass while saying nothing about this route's choice.
  it("still publishes a range where the query schema is the parser", () => {
    const { spec } = loadSpecRoutes();
    const params = paramsOf(
      spec.paths["/api/companies/{companyId}/artifacts"].get,
    );
    expect(params.get("limit").schema.minimum).toBe(1);
    expect(params.get("limit").schema.maximum).toBeGreaterThan(0);
  });

  it("names the empty-page hazard and the reconciliation that settles it", () => {
    const { spec } = loadSpecRoutes();
    const operation = spec.paths["/api/issues/{id}/comments"].get;
    // An empty page is returned for a non-UUID anchor and for a UUID that is
    // not a comment of this issue, byte-identical to end-of-thread. So a
    // termination test cannot prove a thread was read whole, and the contract
    // has to say where the proof actually comes from.
    expect(operation.description).toContain("not a UUID");
    expect(operation.description).toContain("commentCursor.totalComments");
    expect(operation.description).toContain("heartbeat-context");
  });

  it("agrees with itself about the end-of-page signal", () => {
    const { spec } = loadSpecRoutes();
    const operation = spec.paths["/api/issues/{id}/comments"].get;
    const limitProse = paramsOf(operation).get("limit").description;
    const cursor =
      spec.paths["/api/issues/{id}/heartbeat-context"].get.responses["200"]
        .content["application/json"].schema.properties.commentCursor;
    const totalProse = cursor.properties.totalComments.description;

    // Three fields describe termination: this route, its `limit` parameter,
    // and `totalComments`. An earlier revision had the route saying "stop when
    // a page comes back shorter than `limit`" eighteen lines from the
    // parameter warning that a short page is "never proof the thread ended" —
    // each field read correctly alone and they contradicted each other. The
    // clamp is why: a `limit` above the server's cap returns a short page
    // while rows remain. So all three are pinned on the empty-page rule, and
    // the retired instruction is pinned absent.
    expect(operation.description).toContain("Do NOT stop on a short page");
    expect(operation.description).not.toContain("shorter than `limit`");
    for (const [where, prose] of [
      ["route", operation.description],
      ["totalComments", totalProse],
    ] as const) {
      expect(prose, where).toMatch(/empty/i);
      expect(prose, where).toMatch(/clamp/i);
    }
    expect(limitProse).toContain("clamped");
    expect(limitProse).toContain("never proof the thread ended");

    // An empty page is terminal ONLY for an anchor taken from a previous page.
    // That is what separates it from the unknown-anchor case in the test
    // above, and omitting the distinction makes the two statements look like a
    // contradiction rather than a condition.
    expect(operation.description).toContain("previous page");

    // The leniency the contract publishes is bounded by what a conforming
    // client can send. Zero and negatives are integers, so they are
    // documented; a non-numeric `limit` behaves the same way server-side but
    // `type: integer` means a generated client or validator rejects it first,
    // so documenting it would describe a request this contract's readers
    // cannot make. Same defect as the retired `order` leniency clause.
    expect(paramsOf(operation).get("limit").schema.type).toBe("integer");
    expect(limitProse).not.toMatch(/non-numeric/i);
    expect(limitProse).toMatch(/negative/i);
  });

  it("names every way an anchor row can be erased, and no more", () => {
    const { spec } = loadSpecRoutes();
    const operation = spec.paths["/api/issues/{id}/comments"].get;

    // Erasure matters because `listComments` returns `[]` for an anchor it
    // cannot find, which is byte-identical to end-of-thread. An ordinary
    // comment deletion is NOT erasure — it leaves the row with a deleted
    // timestamp and the anchor lookup does not filter on it — so the contract
    // has to separate the two or readers distrust every anchor equally.
    expect(operation.description).toContain("does NOT erase it");
    expect(operation.description).toContain("still QUEUED for dispatch");
    expect(operation.description).toContain("deleting an agent hard-deletes");

    // The erasing condition is "the comment is still a pending queue entry and
    // the actor authored it" — `discardQueuedComment` never consults a run.
    // An earlier revision said "cancelling a queued comment on an active run",
    // borrowing the `activeRun && isLegacyQueuedComment` guard that sits on
    // the `else` branch of the comment-delete route and governs only the
    // `removeComment` fallback. Attaching it to the discard path told clients
    // an anchor was safe whenever no run was active. Pin it absent.
    expect(operation.description).not.toMatch(/queued comment on an active run/);
    expect(operation.description).toContain("no run has to be active");

    // This paragraph is an enumeration, which makes it the kind of claim that
    // rots silently: a new hard delete of the table makes the spec incomplete
    // without touching the spec. An earlier revision said "only cancelling a
    // queued comment erases the row" and was already wrong about agent
    // deletion. So pin the set of hard-delete sites, and fail here when it
    // grows so whoever adds the fifth re-reads the paragraph above.
    const SERVER_SRC = path.resolve(__dirname, "..");
    const sitesOf = (dir: string): string[] => {
      const found: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          found.push(...sitesOf(full));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          if (fs.readFileSync(full, "utf8").includes("delete(issueComments)")) {
            found.push(path.relative(SERVER_SRC, full));
          }
        }
      }
      return found;
    };

    expect(sitesOf(SERVER_SRC).sort()).toEqual([
      // The `deleteComment` port behind `discardQueuedComment` — documented
      // as erasure. Reached by `DELETE /issues/{id}/queued-comments/{id}` and
      // by the comment-delete route whenever the comment is still queued.
      "modules/wake-queue/adapters/queued-comment-postgres.ts",
      // `agentService.remove` — documented as erasure. It de-attributes the
      // agent's issues (`createdByAgentId: null`) but deletes its comments
      // outright, so the issue stays readable with a hole in its thread.
      "services/agents.ts",
      // Company deletion takes the issues with it, so a reader gets a 404
      // rather than a misleading `[]`. Deliberately not in the paragraph.
      "services/companies.ts",
      // `removeComment` — NOT the main cancel path, despite the name. Its one
      // caller is the `else` branch taken when no queue wake exists, gated on
      // `activeRun && isLegacyQueuedComment`. Mistaking this for the whole
      // cancel story is what produced the wrong condition above.
      "services/issues.ts",
    ]);

    // No separate "the scan can find something" control is needed here: this
    // is a set equality, so the four expected paths are themselves the
    // positive control. A scan that silently matched nothing would fail the
    // presence half rather than pass as "no new erasure paths".
  });

  it("declares the comments response as an array of rows", () => {
    const { spec } = loadSpecRoutes();
    const schema =
      spec.paths["/api/issues/{id}/comments"].get.responses["200"].content[
        "application/json"
      ].schema;

    // The route returns a bare JSON array; the old declaration claimed an
    // object, so the published type was not merely vague but wrong.
    expect(schema.type).toBe("array");
    expect(schema.items.properties.id).toMatchObject({
      type: "string",
      format: "uuid",
    });
    expect(schema.items.required).toContain("id");
    expect(schema.items.properties.id.description).toContain("`after`");
    // A row carries columns this schema does not describe, so it must stay
    // open: `additionalProperties: false` here would publish a false closure.
    expect(schema.items.additionalProperties).toBeUndefined();
  });

  it("publishes commentCursor as the API's only declared comment total", () => {
    const { spec } = loadSpecRoutes();
    const operation = spec.paths["/api/issues/{id}/heartbeat-context"].get;
    const schema =
      operation.responses["200"].content["application/json"].schema;
    const cursor = schema.properties.commentCursor;

    expect(schema.required).toContain("commentCursor");
    expect([...cursor.required].sort()).toEqual([
      "latestCommentAt",
      "latestCommentId",
      "totalComments",
    ]);
    expect(cursor.properties.totalComments.type).toBe("integer");
    expect(cursor.properties.latestCommentId).toMatchObject({
      type: "string",
      nullable: true,
    });
    expect(cursor.properties.latestCommentAt).toMatchObject({
      type: "string",
      format: "date-time",
      nullable: true,
    });

    // Three claims this field has to carry, each of which a previous revision
    // of this contract got wrong in a different direction:
    //
    //  1. Ordinary deletion TOMBSTONES the row, so it does not lower the
    //     count. Only the legacy queued-comment path hard-deletes. Stating
    //     "deletion removes the row" overcounts the race by a wide margin.
    //  2. The anchor and the read are two requests, so a disagreement does not
    //     identify its own cause.
    //  3. Re-reading the count does NOT discriminate the causes. A 501-row
    //     thread read at `limit=500` can show a fresh total of 500 that
    //     matches the rows read while one comment stays unseen. So the count
    //     corroborates a read and never proves one complete.
    const totalProse = cursor.properties.totalComments.description;
    expect(totalProse).toContain("tombstone");
    expect(totalProse).toContain("arrived between them");
    expect(totalProse).toContain("hard-deleted");
    expect(totalProse).toContain("does not separate those cases");
    expect(totalProse).toContain("never as a verdict");
    expect(totalProse).toContain("cannot prove one complete");

    // `latestCommentId` is only an incremental anchor when paired with
    // `order=asc`; under the default `desc` the cursor walks backwards, so the
    // obvious reading of "latest comment + after" returns history forever.
    expect(cursor.properties.latestCommentId.description).toContain(
      "order=asc",
    );

    // This schema describes one field of a much larger response. It has to say
    // so, or a reader takes the declared key for the whole contract -- the
    // same mistake in the other direction.
    expect(operation.description).toContain("not evidence");
    expect(schema.additionalProperties).toBeUndefined();

    const params = paramsOf(operation);
    expect(params.get("wakeCommentId").in).toBe("query");
    expect(params.get("wakeCommentId").description).toContain("wakeComment");
  });

  it("publishes `.describe()` prose on parameters and nested properties", () => {
    const { spec } = loadSpecRoutes();

    // Control for the four tests above: descriptions reach the document
    // generally, not through anything special-cased for the comment routes.
    // Zod 4 keeps `.describe()` text in `z.globalRegistry` rather than on
    // `_def`, and the converter read neither -- so every description already
    // written in a request or response schema was dropped on the way out.
    const runId = (
      spec.paths["/api/heartbeat-runs/{runId}"].get.parameters ?? []
    ).find((param: any) => param.name === "runId");
    expect(runId.description).toContain("malformed values return 400");
    const search =
      spec.paths["/runtime-tools/connections/search"].post.requestBody.content[
        "application/json"
      ].schema;
    expect(search.properties.retryProviderChoice.description).toContain(
      "explicitly asks to reconsider",
    );

    // `.describe()` binds to whichever schema it was called on, so the two
    // orderings resolve through different branches. `after` describes before
    // `.optional()` and `limit` after it, which keeps a live example of each.
    const params = paramsOf(spec.paths["/api/issues/{id}/comments"].get);
    expect(params.get("after").description).toContain("Keyset cursor");
    expect(params.get("limit").description).toContain("clamped");
  });
});
