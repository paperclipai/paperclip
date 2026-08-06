import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOARD_API_KEY_PERMISSION_KEYS } from "@paperclipai/shared";
import { lookupBoardKeyRoute } from "./board-key-route-registry.js";
import {
  BOARD_KEY_ROUTE_INVENTORY,
  BOARD_KEY_RUNTIME_ROUTE_SURFACES,
  collectMountedRoutes,
  installRouteInventoryProbe,
  inventoryTuple,
  inventoryTuples,
  type RuntimeRoute,
} from "./board-key-route-inventory.js";

// The inventory is derived from the real Express router `createApp` mounts, not
// from source regexes. The probe must be installed before `createApp` builds
// its routers so Express 5 mount prefixes are recoverable, so the app is built
// once here and shared across the inventory assertions.
let app: Express;
let restoreProbe: () => void;

beforeAll(async () => {
  restoreProbe = installRouteInventoryProbe();
  const { createApp } = await import("../app.js");
  app = (await createApp({} as never, {
    uiMode: "none",
    serverPort: 0,
    storageService: {} as never,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: false,
    // Mount every optionally-gated router so the inventory reflects production.
    // The Better Auth handler is injected with `app.all(...)`; it is covered by
    // BOARD_KEY_RUNTIME_ROUTE_SURFACES rather than mounted here.
    databaseBackupService: { runManualBackup: async () => ({}) },
    decisionServiceOptions: {} as never,
  } as never)) as unknown as Express;
}, 120_000);

afterAll(() => {
  restoreProbe?.();
});

function runtimeInventory(extra: readonly RuntimeRoute[] = []): string[] {
  const routes = [...collectMountedRoutes(app), ...BOARD_KEY_RUNTIME_ROUTE_SURFACES, ...extra];
  return [...new Set(inventoryTuples(routes).map((entry) => entry.tuple))].sort();
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

  it("enumerates the real createApp route stack, including nested routers", () => {
    const routes = collectMountedRoutes(app);
    // Sanity: this is the whole mounted API surface, not a handful of files.
    expect(routes.length).toBeGreaterThan(500);
    // Nested routers resolve to fully-qualified paths, not bare sub-paths.
    const paths = routes.map((route) => route.path);
    expect(paths).toContain("/api/companies/:companyId/issues");
    expect(paths.some((path) => path.startsWith("/api/companies/:companyId/skills/:skillId/"))).toBe(true);
    expect(paths.every((path) => path.startsWith("/api/") || path.startsWith("/_plugins/")
      || path.startsWith("/llms/") || path.startsWith("/mcp/"))).toBe(true);
  });

  it("declares an explicit policy for every reachable route", () => {
    const entries = inventoryTuples([
      ...collectMountedRoutes(app),
      ...BOARD_KEY_RUNTIME_ROUTE_SURFACES,
    ]);
    // Missing metadata: no reachable route may fall through to `undeclared`.
    const undeclared = entries.filter((entry) => entry.metadata.classification === "undeclared");
    expect(undeclared.map((entry) => entry.metadata.routePattern)).toEqual([]);
    // Every action is either an explicit deny or a real board-key permission.
    for (const entry of entries) {
      const { action } = entry.metadata;
      expect(action === "deny" || BOARD_API_KEY_PERMISSION_KEYS.includes(action)).toBe(true);
    }
  });

  it("matches the explicit registry inventory bidirectionally", () => {
    const runtime = runtimeInventory();
    const declared = [...new Set(BOARD_KEY_ROUTE_INVENTORY)].sort();
    // Missing metadata (runtime rows absent from the registry) and stale
    // metadata (registry rows with no live route) both surface as a set diff.
    const missing = runtime.filter((tuple) => !declared.includes(tuple));
    const stale = declared.filter((tuple) => !runtime.includes(tuple));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it("fails when a direct app.post is registered without metadata", () => {
    // Regression for the PoC: a route added straight onto the app (bypassing the
    // route modules the old regex scanned) must be seen by the inventory and
    // must fail the gate as undeclared until it is classified.
    const before = runtimeInventory();
    expect(before).toEqual([...new Set(BOARD_KEY_ROUTE_INVENTORY)].sort());

    (app as unknown as { post: (path: string, handler: () => void) => void })
      .post("/api/security-review-poc", () => {});

    const pocRoute = collectMountedRoutes(app).find((route) => route.path === "/api/security-review-poc");
    expect(pocRoute).toBeDefined();
    expect(inventoryTuple("POST", "/api/security-review-poc").metadata.classification).toBe("undeclared");

    const after = runtimeInventory();
    // The gate now fails: an undeclared row appears that the registry never declared.
    expect(after).not.toEqual(before);
    expect(after).toContain("undeclared | deny | /api/security-review-poc");
    expect(after.filter((tuple) => !BOARD_KEY_ROUTE_INVENTORY.includes(tuple)))
      .toEqual(["undeclared | deny | /api/security-review-poc"]);
  });
});
