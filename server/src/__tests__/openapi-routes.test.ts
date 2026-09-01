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
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agents.ts": "/api",
  "attention.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "board-chat.ts": "/api",
  "built-in-agents.ts": "/api",
  "cloud.ts": "/api/cloud",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "company-skill-policy.ts": "/api",
  "connection-intents.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
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
  "onboarding-seed.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
  "resource-memberships.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "summary-slots.ts": "/api",
  "status-cards.ts": "/api",
  "teams-catalog.ts": "/api",
  "tool-access.ts": "/api",
  "tool-gateway.ts": "/api",
  "user-profiles.ts": "/api",
};

const ROUTE_LITERAL_PATTERN = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const explicitOpenApiCoverageExclusions = new Set([
  // Pipeline routes are experimental and not yet represented in the public OpenAPI document.
  "pipelines.ts",
  // Case routes are experimental (enableCases flag) and not yet in the public OpenAPI document.
  "cases.ts",
  // Smoke lab routes are experimental and not yet represented in the public OpenAPI document.
  "smoke-lab.ts",
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
  for (const [placeholder, value] of Object.entries(routePathConstantSubstitutions)) {
    substituted = substituted.split(placeholder).join(value);
  }
  return substituted
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if (file === "tool-gateway.ts" && routePath.startsWith("/mcp/gateways/")) {
    return routePath;
  }
  if (
    file === "connection-intents.ts"
    && (routePath.startsWith("/mcp/") || routePath.startsWith("/runtime-tools/"))
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

// Routes registered with a shared path constant instead of a string literal,
// so `ROUTE_LITERAL_PATTERN` cannot see them.
const constantPathRoutes: Array<{ file: string; marker: string; route: string }> = [
  { file: "companies.ts", marker: "router.post(COMPANY_IMPORT_ROUTE_PATH", route: "POST /api/companies/import" },
  {
    file: "companies.ts",
    marker: "router.post(COMPANY_IMPORT_TRANSFERS_ROUTE_PATH",
    route: `POST /api/companies${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}`,
  },
];

/**
 * Masks string, template, comment and regex-literal contents with spaces,
 * preserving length so offsets stay valid against the raw source. Brace
 * counting on the result reflects real block nesting.
 *
 * Masking rather than parsing because TypeScript 7 no longer exposes the
 * syntactic compiler API (`ts.createSourceFile` and friends are gone from the
 * published package), and a real parser is not worth a new dependency for one
 * test. The trade is covered rather than assumed: `loadActualRoutes` refuses to
 * report any file this masker cannot brace-balance, and the test asserts that
 * list is empty, so a masking bug fails the suite instead of silently shrinking
 * what gets checked.
 */
function maskLiterals(source: string) {
  const out = source.split("");
  const regexPrecedingKeywords = new Set([
    "return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof", "do", "else", "yield", "await",
  ]);
  // A `/` opens a regex literal unless the previous token can end an expression.
  const opensRegex = (at: number) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    if (/[A-Za-z0-9_$]/.test(out[j])) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k--;
      return regexPrecedingKeywords.has(out.slice(k + 1, j + 1).join(""));
    }
    return !")]".includes(out[j]);
  };

  const blocks: string[] = [];
  // Never write past the end: the masked source must stay the same length as
  // the input for offsets to remain valid against it.
  const blank = (at: number) => {
    if (at < source.length) out[at] = " ";
  };
  let state = "code";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (char === "/" && (next === "/" || next === "*")) {
        state = next === "/" ? "line" : "block";
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (char === "/" && opensRegex(i)) {
        out[i] = " ";
        i++;
        let inClass = false;
        for (; i < source.length && source[i] !== "\n"; i++) {
          const regexChar = source[i];
          if (regexChar === "\\") {
            blank(i);
            blank(i + 1);
            i++;
            continue;
          }
          if (regexChar === "[") inClass = true;
          else if (regexChar === "]") inClass = false;
          out[i] = " ";
          if (regexChar === "/" && !inClass) {
            i++;
            break;
          }
        }
        while (i < source.length && /[a-z]/.test(source[i])) out[i++] = " ";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        state = char === "`" ? "template" : "string";
        blocks.push(char);
        i++;
        continue;
      }
      if (char === "{") {
        blocks.push("brace");
        i++;
        continue;
      }
      if (char === "}") {
        if (blocks.pop() === "substitution") state = "template";
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === "line") {
      if (char === "\n") state = "code";
      else out[i] = " ";
      i++;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        blank(i);
        blank(i + 1);
        i += 2;
        state = "code";
        continue;
      }
      if (char !== "\n") out[i] = " ";
      i++;
      continue;
    }
    // string or template
    if (char === "\\") {
      blank(i);
      blank(i + 1);
      i += 2;
      continue;
    }
    if (char === blocks[blocks.length - 1]) {
      blocks.pop();
      state = "code";
      i++;
      continue;
    }
    if (state === "template" && char === "$" && next === "{") {
      blocks.push("substitution");
      state = "code";
      i += 2;
      continue;
    }
    if (char !== "\n") out[i] = " ";
    i++;
  }
  return out.join("");
}

// `assertBoard(req)` is the one primitive that rejects a non-board actor. Every
// other board gate in the tree reaches it by calling something that calls it —
// `assertBoardOrgAccess` and `assertInstanceAdmin` open with it in `routes/authz.ts`,
// and route files declare their own wrappers on top (`assertCompanySecretWrite` in
// `secrets.ts`, for one). Enumerating those names by hand is what let the drift in:
// three separate passes over this table each missed a different wrapper. So the set
// is computed transitively instead — see `resolveBoardAssertNames`.
const BOARD_ASSERT_ROOT = "assertBoard";
const AUTHZ_FILE = "authz.ts";

// `function name(` and `const name = (` declarations, used both to find wrappers and
// to resolve a route registered with a named handler.
const FUNCTION_DECLARATION_PATTERN = /(?:^|[\s;})])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
const ARROW_DECLARATION_PATTERN = /(?:^|[\s;})])(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;

function declarationsIn(masked: string) {
  const declarations: Array<{ name: string; index: number; isNamedFunction: boolean }> = [];
  for (const [pattern, isNamedFunction] of [
    [FUNCTION_DECLARATION_PATTERN, true],
    [ARROW_DECLARATION_PATTERN, false],
  ] as const) {
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      declarations.push({ name: match[1], index: match.index, isNamedFunction });
    }
  }
  return declarations;
}

// Matches a call to any known board assertion with `req` as its first argument.
// The trailing `[,)]` lets a wrapper take further arguments —
// `assertCompanySecretWrite(req, companyId)` asserts just as unconditionally as
// `assertBoard(req)`, and requiring a bare `(req);` is precisely what hid it.
function boardAssertCallPattern(names: ReadonlySet<string>) {
  const alternation = [...names].map((name) => name.replace(/[$]/g, "\\$")).join("|");
  return new RegExp(`^(?:${alternation})\\(\\s*req\\s*[,)]`);
}

/**
 * Offset of the opening brace of a `function name(...) { ... }` body. Found by
 * matching the parameter list's parentheses rather than by searching for `)\s*{`,
 * because a return-type annotation sits between the two — `function
 * requireBoardUserId(req, res): string | null {` in `sidebar-preferences.ts` is
 * exactly the shape that a `)\s*{` search misses, which hid four board-only routes.
 * Returns -1 when the return type itself is an object literal, so an unreadable
 * declaration is skipped rather than analyzed from the wrong brace.
 */
function namedFunctionBodyStart(source: string) {
  const open = source.indexOf("(");
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) {
      const afterParams = source.slice(i + 1);
      const body = afterParams.match(/^\s*(?::[^{;=]*)?\{/);
      return body ? i + 1 + body[0].length - 1 : -1;
    }
  }
  return -1;
}

/**
 * True when a board assertion runs on every path through this function body that can
 * reach a success response — the assertion is a statement of the body itself, not of
 * a branch. `try { ... }` is transparent because it does not make a statement
 * conditional; `catch`, `if`/`else` and every other block are not, and a braceless
 * `if (...) assertBoard(req);` does not count either.
 *
 * Two limits are deliberate rather than overlooked, because both were considered and
 * tightening either one costs more than it buys:
 *
 * - **An early `return` before the assertion does not disqualify it.** Several
 *   handlers open with `const x = await getAccessibleResource(...); if (!x) return;`
 *   and assert straight after. That branch has already written a 404, so it reaches
 *   no success response without a board check. Treating it as disqualifying would
 *   drop genuinely board-only routes — `GET /api/environments/{id}` and the
 *   `tool-connections` services routes among them — back out of this guard's reach,
 *   which is the drift it exists to catch. The scan cannot tell a 404 return from a
 *   200 return, so this is the one direction in which it could over-report; every
 *   entry it reports is confirmed against its handler before being added.
 * - **`try` stays transparent.** A `catch` that swallowed the assertion's `HttpError`
 *   and answered anyway would defeat it. None does — the error handlers here
 *   propagate `HttpError.status` — and eleven guarded routes assert inside a `try`,
 *   so treating `try` as opaque would blind the guard to all of them.
 *
 * Otherwise one-directional: a handler that gates on board access some other way (a
 * middleware, a runtime-dispatched helper) is simply not reported.
 */
function assertsBoardUnconditionally(
  handlerSource: string,
  assertNames: ReadonlySet<string>,
  isNamedFunction = false,
) {
  const bodyStart = isNamedFunction ? namedFunctionBodyStart(handlerSource) : handlerSource.search(/=>\s*\{/);
  if (bodyStart < 0) return false;
  const callPattern = boardAssertCallPattern(assertNames);
  const window = Math.max(...[...assertNames].map((name) => name.length)) + 16;
  const blocks: string[] = [];
  for (let i = handlerSource.indexOf("{", bodyStart); i < handlerSource.length; i++) {
    const char = handlerSource[i];
    if (char === "{") {
      blocks.push(blocks.length > 0 && /\btry$/.test(handlerSource.slice(0, i).trimEnd()) ? "try" : "block");
      continue;
    }
    if (char === "}") {
      blocks.pop();
      if (blocks.length === 0) return false;
      continue;
    }
    if (blocks.slice(1).some((kind) => kind !== "try")) continue;
    if (!/[A-Za-z_$]/.test(char)) continue;
    if (/[\w$.]/.test(handlerSource[i - 1] ?? " ")) continue; // mid-identifier, or a `.method(` call
    if (!callPattern.test(handlerSource.slice(i, i + window))) continue;
    // Reject a braceless `if (...) assertBoard(req);` / `else assertBoard(req);`.
    if (/\b(if|else)\s*(\([^()]*\))?\s*$/.test(handlerSource.slice(0, i).trimEnd())) continue;
    return true;
  }
  return false;
}

/**
 * The names that, called with `req`, guarantee a board actor — closed transitively
 * over `seed`. A declaration whose body unconditionally calls a known assertion is
 * itself an assertion, so the pass repeats until nothing new is found (a wrapper may
 * be declared above the wrapper it calls).
 */
function resolveBoardAssertNames(masked: string, seed: ReadonlySet<string>) {
  const names = new Set(seed);
  const declarations = declarationsIn(masked);
  for (;;) {
    const found = declarations.filter(
      (declaration) =>
        !names.has(declaration.name) &&
        assertsBoardUnconditionally(masked.slice(declaration.index), names, declaration.isNamedFunction),
    );
    if (found.length === 0) return names;
    for (const declaration of found) names.add(declaration.name);
  }
}

// A few routes pass a named handler rather than an inline arrow. Resolve the
// identifier against the same file and analyze the function it names.
function namedHandlerAssertsBoard(masked: string, registrationIndex: number, assertNames: ReadonlySet<string>) {
  const args = registrationArguments(masked, registrationIndex);
  if (args === null || args.includes("=>")) return false;
  const handlerName = args.split(",").pop()?.trim() ?? "";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(handlerName)) return false;
  const declaration = declarationsIn(masked).find((entry) => entry.name === handlerName);
  if (!declaration) return false;
  return assertsBoardUnconditionally(masked.slice(declaration.index), assertNames, declaration.isNamedFunction);
}

// The text between the parentheses of the `router.<method>(...)` call itself.
// Bounding the handler scan to this span rather than to the start of the *next*
// registration is what stops a neighbouring helper's `assertBoard(req)` from being
// attributed to a route that never runs it.
function registrationArguments(masked: string, registrationIndex: number) {
  const open = masked.indexOf("(", registrationIndex);
  if (open < 0) return null;
  let depth = 0;
  for (let close = open; close < masked.length; close++) {
    if (masked[close] === "(") depth++;
    else if (masked[close] === ")" && --depth === 0) return masked.slice(open + 1, close);
  }
  return null;
}

function loadActualRoutes() {
  const routes = new Set<string>();
  const boardGuardedRoutes = new Set<string>();
  const unknownRouteFiles: string[] = [];
  const unbalancedRouteFiles: string[] = [];

  // The shared assertions first: everything in `authz.ts` that bottoms out in
  // `assertBoard`. Route files then extend this with their own local wrappers.
  const sharedAssertNames = resolveBoardAssertNames(
    maskLiterals(fs.readFileSync(path.join(ROUTES_DIR, AUTHZ_FILE), "utf8")),
    new Set([BOARD_ASSERT_ROOT]),
  );

  for (const file of fs.readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith(".ts"))) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    // Board-guard detection reads block structure, so it needs the masked
    // source. Record files the masker cannot balance rather than scanning them
    // wrongly and silently under-reporting.
    const masked = maskLiterals(source);
    let braceBalance = 0;
    for (const char of masked) {
      if (char === "{") braceBalance++;
      else if (char === "}") braceBalance--;
    }
    if (braceBalance !== 0) unbalancedRouteFiles.push(file);

    const assertNames = resolveBoardAssertNames(masked, sharedAssertNames);

    const registrations = [...source.matchAll(ROUTE_LITERAL_PATTERN)];
    registrations.forEach((match) => {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const route = `${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`;
      routes.add(route);

      const handlerSource = registrationArguments(masked, match.index) ?? "";
      if (
        assertsBoardUnconditionally(handlerSource, assertNames) ||
        namedHandlerAssertsBoard(masked, match.index, assertNames)
      ) {
        boardGuardedRoutes.add(route);
      }
    });

    for (const { file: constantFile, marker, route } of constantPathRoutes) {
      if (file !== constantFile) continue;
      const at = source.indexOf(marker);
      if (at < 0) continue;
      routes.add(route);
      const handlerSource = registrationArguments(masked, at) ?? "";
      if (assertsBoardUnconditionally(handlerSource, assertNames)) boardGuardedRoutes.add(route);
    }
  }

  return {
    routes,
    boardGuardedRoutes,
    unknownRouteFiles: unknownRouteFiles.sort(),
    unbalancedRouteFiles: unbalancedRouteFiles.sort(),
  };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
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
    expect(res.body.paths["/mcp/gateways/{gatewayPublicId}"].post.security).toEqual([]);
    expect(res.body.paths["/api/mcp/gateways/{gatewayPublicId}"]).toBeUndefined();
    expect(res.body.paths["/api/companies"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(JSON.stringify(res.body.paths["/api/companies"].post.responses)).not.toContain("candidates");
    expect(res.body.paths["/api/companies/{companyId}/skills/scan-projects"].post.responses["200"].content[
      "application/json"
    ].schema).toMatchObject({
      type: "object",
      properties: {
        candidates: { type: "array" },
      },
      required: expect.arrayContaining(["candidates"]),
    });
    expect(res.body.paths["/api/agents/{id}/keys"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
    expect(res.body.paths["/api/companies/{companyId}/folders"].post.responses["201"]).toBeDefined();
    expect(
      Object.keys(
        res.body.paths["/api/issues/{id}/work-products/{workProductId}/review-document"].post.responses,
      ).sort(),
    ).toEqual(["200", "201", "401", "403", "404", "409", "413", "415", "422"]);
    expect(
      res.body.paths["/api/issues/{id}/interactions/{interactionId}/withdraw"].post.summary,
    ).toBe("Withdraw a pending issue thread interaction");
    const createInteraction = res.body.paths["/api/issues/{id}/interactions"].post;
    expect(createInteraction.description).toContain("defaults to canonical `anyone`");
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
    expect(res.body.paths["/api/companies/{companyId}/folders/items/move"].post.summary).toBe(
      "Move an item into or out of a folder",
    );
    const createQueue = res.body.paths["/api/companies/{companyId}/decision-queues"].post;
    expect(createQueue.security).toContainEqual({ AgentBearerAuth: [] });
    expect(createQueue.responses["200"]).toBeDefined();
    expect(createQueue.responses["201"]).toBeDefined();
    expect(createQueue.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        key: { type: "string", minLength: 1, maxLength: 80 },
        title: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["key", "title"],
    });
    const updateTriage = res.body.paths[
      "/api/companies/{companyId}/decision-triage/{sourceKind}/{sourceId}"
    ].put;
    expect(updateTriage.responses["422"]).toBeDefined();
    expect(updateTriage.requestBody.content["application/json"].schema.properties).toMatchObject({
      decideBy: { nullable: true },
      snoozedUntil: { type: "string", format: "date-time", nullable: true },
    });
    expect(JSON.stringify(res.body.paths["/api/tool-gateway/tools"].get)).not.toContain("sessionToken");
    expect(JSON.stringify(res.body.paths["/api/tool-gateway/tools/call"].post)).not.toContain("sessionToken");
  });

  it("covers the mounted server routes exactly", () => {
    const { routes: actualRoutes, unknownRouteFiles } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes].filter((route) => !specRoutes.has(route)).sort();
    const extraInSpec = [...specRoutes]
      .filter((route) => !actualRoutes.has(route) && !specOnlyContractFirstRoutes.has(route))
      .sort();

    expect({ unknownRouteFiles, missingInSpec, extraInSpec }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
    });
  });

  it("annotates every unconditionally board-guarded route as board-only", () => {
    const { boardGuardedRoutes, unbalancedRouteFiles } = loadActualRoutes();
    const { spec } = loadSpecRoutes();

    // The scan only means anything while it can still read the route files.
    expect(unbalancedRouteFiles).toEqual([]);
    expect([...boardGuardedRoutes]).toContain("POST /api/execution-workspaces/{id}/reconcile-branch");
    expect([...boardGuardedRoutes]).toContain("GET /api/tools/oauth/cloud-connector/callback");
    // `assertInstanceAdmin` is recognised too, and a multi-line registration is
    // still matched.
    expect([...boardGuardedRoutes]).toContain("PATCH /api/adapters/{type}");
    expect([...boardGuardedRoutes]).toContain("GET /api/heartbeat-runs/{runId}/provider-trace/download");
    // Negative controls: a board assertion buried in a branch does not count.
    // `POST /api/invites/{inviteId}/revoke` asserts instance admin only for
    // bootstrap-CEO invites, and `POST /api/agents/{id}/heartbeat/invoke`
    // explicitly admits an agent actor and asserts only when a provider trace is
    // requested. Both are genuinely `board_or_agent`.
    expect([...boardGuardedRoutes]).not.toContain("POST /api/invites/{inviteId}/revoke");
    expect([...boardGuardedRoutes]).not.toContain("POST /api/agents/{id}/heartbeat/invoke");

    const mislabeled = [...boardGuardedRoutes]
      .filter((route) => {
        const separator = route.indexOf(" ");
        const operation = spec.paths?.[route.slice(separator + 1)]?.[route.slice(0, separator).toLowerCase()];
        // A guarded route missing from the spec entirely is the coverage test's
        // failure to report, not this one's.
        if (!operation) return false;
        return operation["x-paperclip-authorization"]?.actor !== "board";
      })
      .sort();

    expect(mislabeled).toEqual([]);
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/plugins/install"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
    });
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["403"]).toBeDefined();
    expect(spec.paths["/api/instance/database-backups"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/invites/{token}/accept"].post.responses["202"]).toBeDefined();
    expect(spec.paths["/api/board-api-keys"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/import"].post.responses["202"]).toBeDefined();
    expect(spec.paths["/api/routines/{id}/run"].post.responses["422"]).toBeDefined();
  });

  it("publishes the Claude browser-code grammar and strict setup-token response shapes", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/setup-token-login-sessions";

    // The submitted browser code carries the bounded printable-ASCII grammar.
    const codeBody =
      spec.paths[`${base}/{sessionId}/code`].post.requestBody.content["application/json"].schema;
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
      start: spec.paths[base].post.responses["201"].content["application/json"].schema,
      status: spec.paths[`${base}/{sessionId}`].get.responses["200"].content["application/json"].schema,
      prompt: spec.paths[`${base}/{sessionId}/prompt`].get.responses["200"].content["application/json"].schema,
      code: spec.paths[`${base}/{sessionId}/code`].post.responses["200"].content["application/json"].schema,
    };
    const forbiddenProperties = ["token", "accountId", "leaseId"];
    for (const [name, schema] of Object.entries(responseSchemas)) {
      expect(schema.type, `${name} response is a typed object`).toBe("object");
      expect(schema.additionalProperties, `${name} response is strict`).toBe(false);
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(properties).length, `${name} response lists properties`).toBeGreaterThan(0);
      for (const forbidden of forbiddenProperties) {
        expect(properties[forbidden], `${name} response hides ${forbidden}`).toBeUndefined();
      }
      // No property name looks like a raw prompt secret or a token.
      for (const property of Object.keys(properties)) {
        expect(/token|secret|accountId|leaseId/i.test(property), `${name}.${property} is not secret-adjacent`).toBe(
          false,
        );
      }
    }

    // The status and code routes share the public response; it hides the prompt.
    expect(responseSchemas.status.properties).toEqual(responseSchemas.code.properties);
    expect((responseSchemas.status.properties as Record<string, unknown>).prompt).toBeUndefined();
    // The owner start response adds the panel mode and the one-time prompt.
    expect((responseSchemas.start.properties as Record<string, unknown>).panelMode).toBeDefined();
    expect((responseSchemas.start.properties as Record<string, unknown>).prompt).toBeDefined();
    // The prompt route returns the authorization URL and the optional transport
    // advisory. The advisory is present on a non-confidential transport, so the
    // client can show a non-blocking disclaimer.
    expect(Object.keys(responseSchemas.prompt.properties as Record<string, unknown>)).toEqual([
      "authorizationUrl",
      "transportAdvisory",
    ]);
  });

  it("documents the 404 non-member gate on the Claude setup-token cancel route", () => {
    const { spec } = loadSpecRoutes();
    const cancel =
      spec.paths["/api/companies/{companyId}/setup-token-login-sessions/{sessionId}/cancel"].post;
    // The 404 is reachable at run time. The company-access gate returns a fixed
    // 404 for a non-member before the cancel logic runs, so the spec declares
    // it. The idempotent cancel still returns 200 for an owner-scoped missing,
    // terminal, or foreign session id.
    const codes = Object.keys(cancel.responses).sort();
    expect(codes).toEqual(["200", "401", "403", "404"]);
  });
});
