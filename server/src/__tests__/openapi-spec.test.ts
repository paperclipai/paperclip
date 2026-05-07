import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
};

Object.assign(apiPrefixes, {
  "agents.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "llms.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "user-profiles.ts": "/api",
  "issue-tree-control.ts": "/api",
});

function normalizeExpressPath(routePath: string) {
  return routePath
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function loadActualRoutes() {
  const routes = new Set<string>();

  for (const file of fs.readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith(".ts"))) {
    const prefix = apiPrefixes[file];
    if (!prefix) continue;

    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];

      let fullPath: string;
      if ((file === "companies.ts" || file === "health.ts") && routePath === "/") {
        fullPath = prefix;
      } else if (file === "companies.ts" || file === "health.ts") {
        fullPath = `${prefix}${routePath}`;
      } else if (file === "auth.ts") {
        fullPath = `${prefix}${routePath === "/" ? "" : routePath}`;
      } else {
        fullPath = `${prefix}${routePath}`;
      }

      routes.add(`${method} ${normalizeExpressPath(fullPath)}`);
    }
  }

  routes.add("GET /api/openapi.json");
  return routes;
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      routes.add(`${method.toUpperCase()} ${routePath}`);
    }
  }

  return { spec, routes };
}

describe("OpenAPI spec", () => {
  it("covers the mounted server routes exactly", () => {
    const actualRoutes = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes].filter((route) => !specRoutes.has(route)).sort();
    const extraInSpec = [...specRoutes].filter((route) => !actualRoutes.has(route)).sort();

    expect({ missingInSpec, extraInSpec }).toEqual({
      missingInSpec: [],
      extraInSpec: [],
    });
  });

  it("documents auth semantics for public and privileged routes", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.components?.securitySchemes).toMatchObject({
      BoardSessionAuth: expect.any(Object),
      BoardApiKeyAuth: expect.any(Object),
      AgentBearerAuth: expect.any(Object),
    });

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/plugins/install"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
  });

  it("uses the live response codes for the reviewed operations", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["403"]).toBeDefined();
    expect(spec.paths["/api/instance/database-backups"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/invites/{token}/accept"].post.responses["202"]).toBeDefined();
  });
});
