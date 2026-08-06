import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_API_KEY_PERMISSION_KEYS } from "@paperclipai/shared";
import { lookupBoardKeyRoute } from "./board-key-route-registry.js";

const ROUTES_DIR = path.resolve(import.meta.dirname, "../routes");
const ROUTE_REGISTRATION = /\b(?:router|routes)\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\2/g;
const ROUTE_CALL = /\b(?:router|routes)\.(?:get|post|put|patch|delete)\s*\(/g;
const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";

type InventoriedRoute = { file: string; method: string; path: string };

function mountedPath(file: string, routePath: string) {
  const mount = file === "companies.ts"
    ? "/api/companies"
    : file === "auth.ts"
      ? "/api/auth"
      : file === "health.ts"
        ? "/api/health"
        : file === "cloud.ts"
          ? "/api/cloud"
          : routePath.startsWith("/mcp")
            ? ""
            : "/api";
  const joined = `${mount}${routePath === "/" ? "" : routePath}` || "/";
  return joined
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, SAMPLE_UUID)
    .replace(/\{\*[^}]+\}/g, "inventory-tail");
}

function inventoryRoutes() {
  const inventory: InventoriedRoute[] = [];
  const unsupported: string[] = [];
  for (const file of fs.readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts") && !name.includes(".test."))) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    const calls = source.match(ROUTE_CALL)?.length ?? 0;
    let captured = 0;
    for (const match of source.matchAll(ROUTE_REGISTRATION)) {
      captured += 1;
      const routePath = match[3]!;
      if (routePath.includes("${")) {
        unsupported.push(`${file}: dynamic template route ${routePath}`);
        continue;
      }
      inventory.push({
        file,
        method: match[1]!.toUpperCase(),
        path: mountedPath(file, routePath),
      });
    }
    // companies.ts has one frozen constant route: COMPANY_IMPORT_ROUTE_PATH.
    const allowedNonLiteralCalls = file === "companies.ts" ? 1 : 0;
    if (calls - captured !== allowedNonLiteralCalls) {
      unsupported.push(`${file}: ${calls - captured} route registration(s) do not use a literal path`);
    }
  }
  inventory.push({ file: "companies.ts", method: "POST", path: "/api/companies/import" });
  const unique = new Map<string, InventoriedRoute>();
  const duplicates: InventoriedRoute[] = [];
  for (const route of inventory) {
    const key = `${route.method} ${route.path}`;
    if (unique.has(key)) duplicates.push(route);
    else unique.set(key, route);
  }
  return { inventory: [...unique.values()], unsupported, duplicates };
}

describe("board-key route registry", () => {
  it.each([
    ["GET", "/api/companies/11111111-1111-4111-8111-111111111111/issues", "issues:read", "company"],
    ["POST", "/api/issues/11111111-1111-4111-8111-111111111111/checkout", "issues:control", "company"],
    ["DELETE", "/api/board-api-keys/11111111-1111-4111-8111-111111111111", "board_api_keys:revoke_self", "key_self"],
    ["POST", "/api/board-api-keys", "deny", "board_key_denied"],
    ["GET", "/api/cli-auth/me", "deny", "board_key_denied"],
    ["GET", "/api/not-yet-registered", "deny", "undeclared"],
  ] as const)("classifies %s %s", (method, routePath, action, classification) => {
    expect(lookupBoardKeyRoute(method, routePath)).toMatchObject({ action, classification });
  });

  it("inventories every checked-in route registration with an explicit policy", () => {
    const { inventory, unsupported, duplicates } = inventoryRoutes();
    const undeclared = inventory
      .map((route) => ({ ...route, metadata: lookupBoardKeyRoute(route.method, route.path) }))
      .filter((route) => route.metadata.classification === "undeclared");
    const unsafeDuplicates = duplicates.filter(
      (route) => lookupBoardKeyRoute(route.method, route.path).classification !== "board_key_denied",
    );

    expect(inventory.length).toBeGreaterThan(500);
    expect(unsupported).toEqual([]);
    // cases.ts and pipelines.ts intentionally overlap while both experimental
    // surfaces are hard-denied. A duplicate on an allowed route is unsafe.
    expect(unsafeDuplicates).toEqual([]);
    expect(undeclared).toEqual([]);
    expect(inventory.map((route) => ({
      ...route,
      metadata: lookupBoardKeyRoute(route.method, route.path),
    }))).toMatchSnapshot();
    for (const route of inventory) {
      const { action } = lookupBoardKeyRoute(route.method, route.path);
      expect(action === "deny" || BOARD_API_KEY_PERMISSION_KEYS.includes(action)).toBe(true);
    }
  });
});
