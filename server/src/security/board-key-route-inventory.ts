import { createRequire } from "node:module";
import type { Express } from "express";
import { lookupBoardKeyRoute, type BoardKeyRouteMetadata } from "./board-key-route-registry.js";

/**
 * Runtime board-key route inventory.
 *
 * The board-key gate ({@link lookupBoardKeyRoute}) must have an explicit policy
 * for every route that is actually reachable. Earlier this was checked by
 * regex-scraping `server/src/routes/*.ts` and guessing mount prefixes, which
 * could not see nested routers, app-level mounts, or dynamic surfaces, so a
 * reachable route without metadata could ship undetected.
 *
 * Instead we enumerate the *real* Express router that `createApp` mounts. The
 * `router` package that Express 5 delegates to does not retain the string mount
 * path on a mounted layer (only opaque matcher closures), so {@link
 * installRouteInventoryProbe} records the raw mount path as each router is
 * mounted. {@link collectMountedRoutes} then walks the built app's layer stack
 * and reconstructs every final normalized path, including nested routers.
 *
 * Truly runtime-generated surfaces (plugin sub-apps, handlers injected through
 * `createApp` options) are not present in the statically built stack. They are
 * declared through the {@link BOARD_KEY_RUNTIME_ROUTE_SURFACES} registration
 * hook. Anything mounted at runtime that is *not* registered there resolves to
 * an `undeclared` classification and is denied by the gate — it stays denied
 * until it is registered.
 *
 * The route-inventory test compares the runtime set against
 * {@link BOARD_KEY_ROUTE_INVENTORY} bidirectionally, so a new reachable route
 * without metadata (missing) and a declared row with no live route (stale) both
 * fail CI.
 */

const require = createRequire(import.meta.url);

/** Stashes the raw mount path recorded by the inventory probe on a layer. */
const MOUNT_PATH = Symbol.for("paperclip.boardKey.inventoryMountPath");

/** Sample id substituted for every `:param` so a route can be classified. */
export const INVENTORY_SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";

/** All concrete methods an `all(...)` registration is reachable through. */
const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface RuntimeRoute {
  methods: string[];
  path: string;
}

export interface InventoryTuple {
  tuple: string;
  metadata: BoardKeyRouteMetadata;
}

/**
 * Rewrite an Express route pattern into a concrete path the registry can
 * classify: every `:param` becomes a sample id and every splat becomes a fixed
 * tail segment. A trailing literal such as `.txt` on a `:param` is preserved.
 */
export function normalizeInventoryPath(routePath: string): string {
  return routePath
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, INVENTORY_SAMPLE_UUID)
    .replace(/\*[A-Za-z][A-Za-z0-9_]*/g, "inventory-tail")
    .replace(/\{\*[^}]+\}/g, "inventory-tail");
}

/**
 * Patch the shared `router` prototype so every mounted sub-router records the
 * raw mount path it was mounted at. Must be installed *before* `createApp`
 * imports and builds its routers. Returns an idempotent restore function.
 */
export function installRouteInventoryProbe(): () => void {
  const RouterCtor = require("router") as { prototype: RouterProto };
  const proto = RouterCtor.prototype;
  const originalUse = proto.use;
  proto.use = function inventoryUse(this: RouterProto, ...args: unknown[]) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args as never[]);
    const first = args[0];
    const mountPath =
      typeof first === "string" || (Array.isArray(first) && first.every((p) => typeof p === "string"))
        ? first
        : "/";
    for (let i = before; i < this.stack.length; i++) {
      const layer = this.stack[i]!;
      if (!layer.route) layer[MOUNT_PATH] = mountPath;
    }
    return result;
  };
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    proto.use = originalUse;
  };
}

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: RouterLayer[] };
  [MOUNT_PATH]?: string | string[];
}

interface RouterProto {
  stack: RouterLayer[];
  use: (...args: never[]) => unknown;
}

function joinMount(prefix: string, mount: string): string {
  const clean = mount === "/" ? "" : mount;
  return `${prefix}${clean}`;
}

function joinRoute(prefix: string, routePath: string): string {
  if (routePath === "/") return prefix || "/";
  return `${prefix}${routePath}`;
}

function routeMethods(methods: Record<string, boolean>): string[] {
  const explicit = Object.keys(methods)
    .filter((method) => method !== "_all")
    .map((method) => method.toUpperCase());
  const set = new Set(methods._all ? [...explicit, ...ALL_METHODS] : explicit);
  return set.size > 0 ? [...set] : ["GET"];
}

/**
 * Walk the built Express app's layer stack and return every mounted route with
 * its fully-resolved path. Nested routers are followed through the mount paths
 * recorded by {@link installRouteInventoryProbe}.
 */
export function collectMountedRoutes(app: Express): RuntimeRoute[] {
  const root = ((app as unknown as { router?: RouterProto; _router?: RouterProto }).router
    ?? (app as unknown as { _router?: RouterProto })._router);
  if (!root) throw new Error("Express app has no router stack to inventory");
  const routes: RuntimeRoute[] = [];
  const walk = (stack: RouterLayer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        routes.push({ methods: routeMethods(layer.route.methods), path: joinRoute(prefix, layer.route.path) });
      } else if (layer.handle?.stack) {
        const recorded = layer[MOUNT_PATH];
        const mounts = Array.isArray(recorded) ? recorded : [recorded ?? "/"];
        for (const mount of mounts) {
          walk(layer.handle.stack, joinMount(prefix, typeof mount === "string" ? mount : "/"));
        }
      }
    }
  };
  walk(root.stack, "");
  return routes;
}

/** `classification | action | routePattern`, with sample ids canonicalized. */
export function inventoryTuple(method: string, rawPath: string): InventoryTuple {
  const metadata = lookupBoardKeyRoute(method, normalizeInventoryPath(rawPath));
  const canonicalPattern = metadata.routePattern.split(INVENTORY_SAMPLE_UUID).join("{id}");
  return { tuple: `${metadata.classification} | ${metadata.action} | ${canonicalPattern}`, metadata };
}

/**
 * Expand runtime routes into per-method inventory tuples. Feeds every method of
 * every route (statically mounted plus registered runtime surfaces) through the
 * registry.
 */
export function inventoryTuples(routes: readonly RuntimeRoute[]): InventoryTuple[] {
  const entries: InventoryTuple[] = [];
  for (const route of routes) {
    for (const method of route.methods) {
      entries.push(inventoryTuple(method, route.path));
    }
  }
  return entries;
}

/**
 * Explicit runtime-registration hook. Surfaces that are only mounted at
 * runtime — not present in the statically built `createApp` stack — are
 * declared here so the inventory reflects them. Any runtime surface that is not
 * registered here (and not a generic parameterized route already in the stack)
 * classifies as `undeclared` and is denied by the gate until it is registered.
 *
 * - `/api/auth/{*authPath}`: the Better Auth request handler is injected through
 *   `createApp({ betterAuthHandler })` with `app.all(...)`, so it is absent when
 *   the app is built without that option. Board keys never reach auth routes;
 *   its policy coincides with the statically mounted `authRoutes` denial.
 */
export const BOARD_KEY_RUNTIME_ROUTE_SURFACES: readonly RuntimeRoute[] = [
  { methods: [...ALL_METHODS], path: "/api/auth/{*authPath}" },
];

/**
 * The explicit board-key route registry: every `classification | action |
 * routePattern` the gate is expected to produce for a reachable route. The
 * route-inventory test asserts the runtime set equals this set exactly, so both
 * a reachable route with no metadata and a declared row with no live route fail
 * CI. Regenerate with the route-inventory test's diff output when routes change.
 */
export const BOARD_KEY_ROUTE_INVENTORY: readonly string[] = [
  "board_key_denied | deny | /_plugins/{*path}",
  "board_key_denied | deny | /api/agents/{id}/{*path}",
  "board_key_denied | deny | /api/auth/{*path}",
  "board_key_denied | deny | /api/board-api-keys",
  "board_key_denied | deny | /api/board-claim/{*path}",
  "board_key_denied | deny | /api/board/{*path}",
  "board_key_denied | deny | /api/bootstrap/{*path}",
  "board_key_denied | deny | /api/cases/{*path}",
  "board_key_denied | deny | /api/cli-auth/{*path}",
  "board_key_denied | deny | /api/cloud/{*path}",
  "board_key_denied | deny | /api/companies/{id}/adapters/{id}/detect-model",
  "board_key_denied | deny | /api/companies/{id}/adapters/{id}/model-profiles",
  "board_key_denied | deny | /api/companies/{id}/adapters/{id}/models",
  "board_key_denied | deny | /api/companies/{id}/adapters/{id}/test-environment",
  "board_key_denied | deny | /api/companies/{id}/agent-configurations",
  "board_key_denied | deny | /api/companies/{id}/agent-hires",
  "board_key_denied | deny | /api/companies/{id}/built-in-agents",
  "board_key_denied | deny | /api/companies/{id}/built-in-agents/{id}/provision",
  "board_key_denied | deny | /api/companies/{id}/built-in-agents/{id}/reconcile",
  "board_key_denied | deny | /api/companies/{id}/built-in-agents/{id}/reset",
  "board_key_denied | deny | /api/companies/{id}/built-in-agents/{id}/routines/{id}/disable",
  "board_key_denied | deny | /api/companies/{id}/built-in-agents/{id}/routines/{id}/enable",
  "board_key_denied | deny | /api/companies/{id}/built-in-agents/{id}/routines/{id}/run",
  "board_key_denied | deny | /api/companies/{id}/built-in-agents/{id}/status",
  "board_key_denied | deny | /api/companies/{id}/feedback-traces",
  "board_key_denied | deny | /api/companies/{id}/inbox-dismissals",
  "board_key_denied | deny | /api/companies/{id}/inbox-dismissals/{id}",
  "board_key_denied | deny | /api/companies/{id}/me/user-secrets",
  "board_key_denied | deny | /api/companies/{id}/me/user-secrets/{id}",
  "board_key_denied | deny | /api/companies/{id}/me/user-secrets/{id}/rotate",
  "board_key_denied | deny | /api/companies/{id}/openclaw/invite-prompt",
  "board_key_denied | deny | /api/companies/{id}/resource-memberships/me",
  "board_key_denied | deny | /api/companies/{id}/resource-memberships/me/agents/{id}",
  "board_key_denied | deny | /api/companies/{id}/resource-memberships/me/documents/{id}",
  "board_key_denied | deny | /api/companies/{id}/resource-memberships/me/projects/{id}",
  "board_key_denied | deny | /api/companies/{id}/sidebar-preferences/me",
  "board_key_denied | deny | /api/companies/{id}/skill-policy",
  "board_key_denied | deny | /api/companies/{id}/skill-policy/evaluate",
  "board_key_denied | deny | /api/companies/{id}/skill-test-run-templates",
  "board_key_denied | deny | /api/companies/{id}/skill-test-run-templates/{id}",
  "board_key_denied | deny | /api/companies/{id}/teams/catalog/installed",
  "board_key_denied | deny | /api/companies/{id}/teams/catalog/{id}/install",
  "board_key_denied | deny | /api/companies/{id}/teams/catalog/{id}/preview",
  "board_key_denied | deny | /api/companies/{id}/users/me/inbox-agent-policy",
  "board_key_denied | deny | /api/companies/{id}/users/{id}/inbox-agent-policy",
  "board_key_denied | deny | /api/companies/{id}/users/{id}/profile",
  "board_key_denied | deny | /api/feedback-traces/{*path}",
  "board_key_denied | deny | /api/health/{*path}",
  "board_key_denied | deny | /api/invites/{*path}",
  "board_key_denied | deny | /api/join-requests/{*path}",
  "board_key_denied | deny | /api/llms/{*path}",
  "board_key_denied | deny | /api/openapi.json/{*path}",
  "board_key_denied | deny | /api/pipelines/{*path}",
  "board_key_denied | deny | /api/plugins/{*path}",
  "board_key_denied | deny | /api/routine-triggers/public/{id}/fire",
  "board_key_denied | deny | /api/sidebar-preferences/{*path}",
  "board_key_denied | deny | /api/tool-gateway/{*path}",
  "board_key_denied | deny | /api/tools/oauth/{*path}",
  "board_key_denied | deny | /llms/{*path}",
  "board_key_denied | deny | /mcp/{*path}",
  "company | activity:read | /api/companies/{id}/{*path}",
  "company | agents:operate | /api/agents/{id}/{*path}",
  "company | agents:read | /api/agents/{id}/{*path}",
  "company | agents:read | /api/companies/{id}/{*path}",
  "company | agents:write | /api/agents/{id}/{*path}",
  "company | agents:write | /api/companies/{id}/{*path}",
  "company | approvals:decide | /api/approvals/{id}/{*path}",
  "company | approvals:read | /api/approvals/{id}/{*path}",
  "company | approvals:read | /api/companies/{id}/{*path}",
  "company | approvals:write | /api/approvals/{id}/{*path}",
  "company | approvals:write | /api/companies/{id}/{*path}",
  "company | artifacts:read | /api/assets/{id}/{*path}",
  "company | artifacts:read | /api/attachments/{id}/{*path}",
  "company | artifacts:read | /api/companies/{id}/{*path}",
  "company | artifacts:write | /api/attachments/{id}/{*path}",
  "company | artifacts:write | /api/companies/{id}/{*path}",
  "company | artifacts:write | /api/work-products/{id}/{*path}",
  "company | audit:read | /api/companies/{id}/{*path}",
  "company | companies:import_export | /api/companies/{id}/{*path}",
  "company | companies:read | /api/companies/{id}/{*path}",
  "company | companies:write | /api/companies/{id}/{*path}",
  "company | costs:read | /api/companies/{id}/{*path}",
  "company | costs:write | /api/companies/{id}/{*path}",
  "company | decisions:read | /api/companies/{id}/{*path}",
  "company | decisions:read | /api/decision-training/{id}/{*path}",
  "company | decisions:read | /api/decisions/{id}/{*path}",
  "company | decisions:write | /api/companies/{id}/{*path}",
  "company | decisions:write | /api/decision-training/{id}/{*path}",
  "company | decisions:write | /api/decisions/{id}/{*path}",
  "company | environments:manage | /api/companies/{id}/{*path}",
  "company | environments:manage | /api/environment-custom-image-setup-sessions/{id}/{*path}",
  "company | environments:manage | /api/environments/{id}/{*path}",
  "company | environments:read | /api/companies/{id}/{*path}",
  "company | environments:read | /api/environment-custom-image-setup-sessions/{id}/{*path}",
  "company | environments:read | /api/environment-leases/{id}/{*path}",
  "company | environments:read | /api/environments/{id}/{*path}",
  "company | goals:read | /api/companies/{id}/{*path}",
  "company | goals:read | /api/goals/{id}/{*path}",
  "company | goals:write | /api/companies/{id}/{*path}",
  "company | goals:write | /api/goals/{id}/{*path}",
  "company | issues:control | /api/issues/{id}/{*path}",
  "company | issues:read | /api/companies/{id}/{*path}",
  "company | issues:read | /api/issues/{id}/{*path}",
  "company | issues:read | /api/issues?companyId={companyId}",
  "company | issues:write | /api/companies/{id}/{*path}",
  "company | issues:write | /api/issues/{id}/{*path}",
  "company | members:manage | /api/companies/{id}/{*path}",
  "company | members:read | /api/companies/{id}/{*path}",
  "company | projects:read | /api/companies/{id}/{*path}",
  "company | projects:read | /api/projects/{id}/{*path}",
  "company | projects:write | /api/companies/{id}/{*path}",
  "company | projects:write | /api/projects/{id}/{*path}",
  "company | routines:read | /api/companies/{id}/{*path}",
  "company | routines:read | /api/routines/{id}/{*path}",
  "company | routines:run | /api/routines/{id}/{*path}",
  "company | routines:write | /api/companies/{id}/{*path}",
  "company | routines:write | /api/routine-triggers/{id}/{*path}",
  "company | routines:write | /api/routines/{id}/{*path}",
  "company | runtime:manage | /api/heartbeat-runs/{id}/{*path}",
  "company | runtime:read | /api/companies/{id}/{*path}",
  "company | runtime:read | /api/heartbeat-runs/{id}/{*path}",
  "company | search:read | /api/companies/{id}/{*path}",
  "company | secrets:manage | /api/companies/{id}/{*path}",
  "company | secrets:manage | /api/secret-provider-configs/{id}/{*path}",
  "company | secrets:manage | /api/secrets/{id}/{*path}",
  "company | secrets:read_metadata | /api/companies/{id}/{*path}",
  "company | secrets:read_metadata | /api/secret-provider-configs/{id}/{*path}",
  "company | secrets:read_metadata | /api/secrets/{id}/{*path}",
  "company | settings:read | /api/companies/{id}/{*path}",
  "company | settings:read | /api/status-cards/{id}/{*path}",
  "company | settings:write | /api/companies/{id}/{*path}",
  "company | settings:write | /api/labels/{id}/{*path}",
  "company | settings:write | /api/status-cards/{id}/{*path}",
  "company | skills:manage | /api/companies/{id}/{*path}",
  "company | skills:read | /api/companies/{id}/{*path}",
  "company | tools:manage | /api/companies/{id}/{*path}",
  "company | tools:manage | /api/tool-applications/{id}/{*path}",
  "company | tools:manage | /api/tool-connections/{id}/{*path}",
  "company | tools:manage | /api/tool-gateway/{*path}",
  "company | tools:manage | /api/tool-profile-entries/{id}/{*path}",
  "company | tools:manage | /api/tool-profiles/{id}/{*path}",
  "company | tools:read | /api/companies/{id}/{*path}",
  "company | tools:read | /api/tool-connections/{id}/{*path}",
  "company | tools:read | /api/tool-gateway/{*path}",
  "company | tools:read | /api/tool-profiles/{id}/{*path}",
  "company | workspaces:manage | /api/execution-workspaces/{id}/{*path}",
  "company | workspaces:read | /api/companies/{id}/{*path}",
  "company | workspaces:read | /api/execution-workspaces/{id}/{*path}",
  "company | workspaces:read | /api/workspace-operations/{id}/{*path}",
  "company_collection | companies:read | /api/companies",
  "instance_global | adapters:manage | /api/adapters/{id}/{*path}",
  "instance_global | adapters:read | /api/adapters/{id}/{*path}",
  "instance_global | catalogs:read | /api/skills/{*path}",
  "instance_global | catalogs:read | /api/teams/{*path}",
  "instance_global | companies:create | /api/companies",
  "instance_global | companies:import_export | /api/companies/import/{*path}",
  "instance_global | instance:manage | /api/instance/{*path}",
  "instance_global | instance:read | /api/instance/{*path}",
  "instance_global | plugins:manage | /api/plugins/{id}/{*path}",
  "instance_global | plugins:read | /api/plugins/{id}/{*path}",
  "instance_global | users:manage | /api/admin/{*path}",
  "instance_global | users:read | /api/admin/{*path}",
  "key_self | board_api_keys:revoke_self | /api/board-api-keys/{id}",
];
