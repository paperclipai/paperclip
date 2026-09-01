import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MUSE_ASSET_VERSION, MUSE_PUBLIC_ROUTES } from "@paperclipai/shared";
import { COMPANY_IMPORT_TRANSFERS_ROUTE_PATH } from "@paperclipai/shared/company-import-transfer";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";
import { mcpDiscoveryDocuments } from "../services/public-mcp/discovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "cases.ts": "/api",
  "case-handoffs.ts": "/api",
  "workflows.ts": "/api",
  "smoke-lab.ts": "/api",
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agents.ts": "/api",
  "agent-project-access.ts": "/api",
  "agent-permission-grants.ts": "/api",
  "agent-interaction-permissions.ts": "/api",
  "agent-commentary.ts": "/api",
  "agent-chat-messages.ts": "/api",
  "agent-avatars.ts": "/api",
  "agent-profile-avatar.ts": "/api",
  "announcements.ts": "/api",
  "ai-connections.ts": "/api",
  "decision-models.ts": "/api",
  "agent-observability.ts": "/api",
  "fast-responses.ts": "/api",
  "prompt-injection-prevention.ts": "/api",
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
  "connection-event-wake.ts": "/",
  "ephemeral-enrollment.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "dot-runner.ts": "/api",
  "muse.ts": "/api",
  "muse-qualification.ts": "/api",
  "grok-bot.ts": "/api",
  "decision-queues.ts": "/api",
  "decisions.ts": "/api",
  "decision-training.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "task-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "folders.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "ready.ts": "/api/ready",
  "liveness.ts": "/api/liveness",
  "inbox-agent-policy.ts": "/api",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "llms.ts": "/api",
  "link-previews.ts": "/api",
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
  "workspace-preferences.ts": "/api",
};

const ROUTE_LITERAL_PATTERN =
  /router\.(get|head|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTE_ARRAY_PATTERN = /router\.(get|head|post|put|patch|delete)\(\s*\[([^\]]+)\]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|head|post|put|patch|delete)\(/;
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
  // Exact Cloud-control signed action; ordinary board/agent credentials cannot invoke it.
  "POST /api/instance/connector-events/wake",
  "POST /api/instance/ephemeral-enrollment/prepare",
  // Muse uses its closed, versioned receiver protocol and dedicated credentials,
  // documented in doc/muse-personal-agent.md and the shared protocol contract.
  // Board connection/qualification management remains in this OpenAPI document.
  ...MUSE_PUBLIC_ROUTES.map(route => `${route.method} ${route.path}`),
  // Inspection uses its own versioned Cloud-permit/managed-run protocol,
  // documented in CUSTOMER-SUCCESS-INSPECTION.md and the shared contract.
  // Ordinary board sessions and agent API keys cannot invoke these endpoints.
  "GET /api/customer-success/v1/run-authority",
  "POST /api/customer-success/v1/read",
  // OAuth discovery and protocol endpoints have their own metadata contract;
  // browser connection-management operations remain documented in the board API.
  // Markdown rendering of the separately documented assistant setup page.
  "GET /api/mcp/setup.md",
  "GET /.well-known/oauth-protected-resource",
  "GET /.well-known/oauth-protected-resource/mcp/paperclip",
  "GET /.well-known/oauth-protected-resource/mcp/runner",
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
  if (file === "connection-event-wake.ts") return routePath;
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
  if ((file === "companies.ts" || file === "health.ts" || file === "liveness.ts" || file === "ready.ts") && routePath === "/") {
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
  const excludedRoutes = new Set<string>();
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
      const operation = `${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`;
      if (explicitOpenApiOperationCoverageExclusions.has(operation)) {
        excludedRoutes.add(operation);
        return;
      }
      routes.add(operation);

      const handlerSource = registrationArguments(masked, match.index) ?? "";
      if (
        assertsBoardUnconditionally(handlerSource, assertNames) ||
        namedHandlerAssertsBoard(masked, match.index, assertNames)
      ) {
        boardGuardedRoutes.add(operation);
      }
    });

    for (const match of source.matchAll(ROUTE_ARRAY_PATTERN)) {
      for (const literal of match[2].matchAll(/["'`]([^"'`]+)["'`]/g)) {
        const operation = `${match[1].toUpperCase()} ${normalizeExpressPath(resolveMountedPath(file, prefix, literal[1]))}`;
        if (explicitOpenApiOperationCoverageExclusions.has(operation)) excludedRoutes.add(operation);
        else routes.add(operation);
      }
    }

    if (file === "public-mcp.ts") {
      // The shared gateway mounts these protocol paths for each OAuth resource.
      if (source.includes("mcpDiscoveryDocuments({") && source.includes("router.get(entry.path,")) {
        for (const entry of mcpDiscoveryDocuments({ origin: "https://example.test",
          authorizationOrigin: "https://example.test", profiles: ["personal-mcp", "dot-mcp"] })) {
          const operation = `GET ${entry.path}`;
          if (explicitOpenApiOperationCoverageExclusions.has(operation)) excludedRoutes.add(operation);
          else routes.add(operation);
        }
      }
      for (const match of source.matchAll(/router\.(get|post)\(oauthPath \+ "([^"]+)"/g)) {
        for (const oauthPath of ["/mcp/oauth", "/mcp/runner/oauth"]) {
          const operation = `${match[1].toUpperCase()} ${oauthPath}${match[2]}`;
          if (explicitOpenApiOperationCoverageExclusions.has(operation)) excludedRoutes.add(operation);
          else routes.add(operation);
        }
      }
    }
    const variablePaths = file === "dot-runner.ts" ? ["path", "invitePath"]
      : file === "grok-bot.ts" ? ["path"]
      : file === "muse.ts" ? ["path", "invite"]
      : file === "muse-qualification.ts" ? ["path"] : [];
    for (const name of variablePaths) {
      const basePath = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
      if (!basePath) throw new Error(`${file} ${name} route prefix is missing`);
      const methods = new RegExp(`router\\.(get|post|put|delete)\\(\\s*${name}(?:\\s*\\+\\s*"([^"]+)")?\\s*,`, "g");
      for (const match of source.matchAll(methods)) {
        routes.add(`${match[1].toUpperCase()} ${normalizeExpressPath(prefix + basePath + (match[2] ?? ""))}`);
      }
    }
    if (file === "muse.ts" && /for\s*\(const route of MUSE_PUBLIC_ROUTES\)/.test(source)) {
      for (const route of MUSE_PUBLIC_ROUTES) excludedRoutes.add(`${route.method} ${route.path}`);
    }

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
    excludedRoutes,
    boardGuardedRoutes,
    unknownRouteFiles: unknownRouteFiles.sort(),
    unbalancedRouteFiles: unbalancedRouteFiles.sort(),
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
  it("tells agents managed-agent profiles are created with the CLI, not a web page", () => {
    const route = buildOpenApiSpec().paths["/api/companies/{companyId}/managed-agent-profiles"];
    for (const operation of [route.get, route.post]) {
      expect(operation.description).toContain("Board only");
      expect(operation.description).toContain("There is no web page");
    }
    expect(route.post.description).toContain("paperclipai managed-agent setup --company-id <companyId>");
    expect(route.post.description).toContain("--acknowledge-retention");
  });

  it("documents the agent Mine inbox read as a person's inbox that requires their user id", () => {
    const operation = buildOpenApiSpec().paths["/api/agents/me/inbox/mine"].get;
    expect(operation.summary).not.toMatch(/current agent/i);
    expect(operation.description).toContain("/<prefix>/inbox/mine");
    expect(operation.description).toContain("not your own work queue");
    const userId = operation.parameters.find((parameter: { name: string; in: string }) => parameter.name === "userId" && parameter.in === "query");
    expect(userId).toMatchObject({ required: true });
  });

  it("documents the export include body so agents can request projects and skills", () => {
    const spec = buildOpenApiSpec();
    for (const path of ["/api/companies/{companyId}/exports", "/api/companies/{companyId}/exports/preview"]) {
      const operation = spec.paths[path].post;
      const body = operation.requestBody.content["application/json"].schema;
      expect(body.properties.include.properties).toMatchObject({ projects: expect.anything(), skills: expect.anything() });
      expect(operation.description).toMatch(/include\.projects/);
    }
  });
  it("documents the safe company import body so agents can preview and resolve agent name conflicts", () => {
    const spec = buildOpenApiSpec();
    for (const path of ["/api/companies/{companyId}/imports/preview", "/api/companies/{companyId}/imports/apply"]) {
      const operation = spec.paths[path].post;
      const body = operation.requestBody.content["application/json"].schema;
      expect(body.required).toEqual(expect.arrayContaining(["source", "target"]));
      expect(body.properties).toMatchObject({ collisionStrategy: expect.anything(), nameOverrides: expect.anything(), include: expect.anything() });
      expect(operation.description).toMatch(/replace/);
    }
  });
  it("documents generic webhook provenance headers and accepted responses without a provider-specific endpoint", () => {
    const spec = buildOpenApiSpec();
    const operation = spec.paths["/api/routine-triggers/public/{publicId}/fire"].post;
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "header", name: "X-Paperclip-Source-Run-Token", required: false }),
      expect.objectContaining({ in: "header", name: "X-Paperclip-Idempotency-Scope", required: false }),
    ]));
    for (const status of ["202", "400", "401", "404", "409", "415", "422"]) expect(operation.responses).toHaveProperty(status);
    expect(operation.requestBody.content).toHaveProperty("application/json");
    expect(spec.paths).not.toHaveProperty("/api/routine-triggers/public/{publicId}/sentry-run-failures");
  });
  it.each(["summary", "tasks"])("documents the board-only compact attention %s contract", projection => {
    const spec = buildOpenApiSpec() as any;
    const operation = spec.paths[`/api/companies/{companyId}/attention/${projection}`].get;
    expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(operation.parameters.filter((parameter: { in: string }) => parameter.in === "query")).toEqual([]);
    const response = operation.responses["200"].content["application/json"].schema;
    expect(response.properties.totalCount).toMatchObject({ type: "integer", minimum: 0 });
    expect(response.properties.generatedAt).toMatchObject({ format: "date-time" });
    expect(response.properties.items).toBeUndefined();
    expect(response.properties.nextCursor).toBeUndefined();
    if (projection === "tasks") expect(response.properties.taskIds).toMatchObject({ type: "array", items: { type: "string", format: "uuid" } });
    for (const code of ["200", "401", "403"]) expect(operation.responses[code]).toBeDefined();
  });

  it("documents the owned pending-question read as canonical attention items without client scope overrides", () => {
    const spec = buildOpenApiSpec() as any;
    const operation = spec.paths["/api/issues/{id}/pending-questions"].get;
    expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(operation.parameters.filter((parameter: { in: string }) => parameter.in === "query")).toEqual([]);
    const response = operation.responses["200"].content["application/json"].schema;
    expect(response).toMatchObject({ type: "array", items: { type: "object", properties: {
      sourceKind: { enum: ["issue_thread_interaction"] },
      detail: { properties: { kind: { enum: ["questions"] } } },
    } } });
    for (const code of ["200", "400", "401", "403", "404"]) expect(operation.responses[code]).toBeDefined();
  });

  it("documents task-tree controls as board-only and names the human page", () => {
    const spec = buildOpenApiSpec() as any;
    const boardSecurity = [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }];
    for (const [path, method] of [
      ["/api/issues/{id}/tree-control/state", "get"],
      ["/api/issues/{id}/tree-control/preview", "post"],
      ["/api/issues/{id}/tree-holds", "get"],
      ["/api/issues/{id}/tree-holds", "post"],
      ["/api/issues/{id}/tree-holds/{holdId}", "get"],
      ["/api/issues/{id}/tree-holds/{holdId}/release", "post"],
    ] as const) {
      const operation = spec.paths[path][method];
      expect(operation.security).toEqual(boardSecurity);
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    }
    const create = spec.paths["/api/issues/{id}/tree-holds"].post.description as string;
    expect(create).toContain("Pause subtree");
    expect(create).toContain("/{prefix}/issues/{identifier}");
  });

  it("publishes grant-gated access operations as board_or_agent and keeps member edits board-only", () => {
    const spec = buildOpenApiSpec() as any;
    for (const [path, method, grant] of [
      ["/api/companies/{companyId}/invites", "post", "users:invite"],
      ["/api/companies/{companyId}/invites", "get", "users:invite"],
      ["/api/companies/{companyId}/join-requests", "get", "joins:approve"],
      ["/api/companies/{companyId}/join-requests/{requestId}/approve", "post", "joins:approve"],
      ["/api/companies/{companyId}/join-requests/{requestId}/reject", "post", "joins:approve"],
      ["/api/companies/{companyId}/members", "get", "users:manage_permissions"],
    ] as const) {
      const operation = spec.paths[path][method];
      expect(operation["x-paperclip-authorization"], `${method} ${path}`).toEqual({ actor: "board_or_agent" });
      expect(operation.description).toContain(grant);
    }
    expect(spec.paths["/api/companies/{companyId}/invites"].post.description).toContain("inviteUrl");
    for (const path of [
      "/api/companies/{companyId}/members/{memberId}/permissions",
      "/api/companies/{companyId}/members/{memberId}/role-and-grants",
    ]) {
      expect(spec.paths[path].patch["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(spec.paths[path].patch.description).toContain("/<prefix>/company/settings/members");
    }
    expect(spec.paths["/api/companies/{companyId}/members"].get.description).toContain("/<prefix>/company/settings/members");
  });

  it("documents owned conversation reads and exact revision access separately", () => {
    const spec = buildOpenApiSpec() as any;
    const boardSecurity = [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }];
    for (const path of [
      "/api/issues/{id}/decision-receipts",
      "/api/issues/{id}/chat-handoffs",
      "/api/companies/{companyId}/attention/history",
    ]) {
      const operation = spec.paths[path].get;
      expect(operation.security).toEqual(boardSecurity);
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      const query = Object.fromEntries(operation.parameters
        .filter((parameter: { in: string }) => parameter.in === "query")
        .map((parameter: { name: string; schema: unknown }) => [parameter.name, parameter.schema]));
      expect(query.cursor).toMatchObject({ type: "string", maxLength: 1000 });
      expect(query.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
      if (path.endsWith("/history")) {
        expect(query.search).toMatchObject({ maxLength: 200 });
        expect(query.outcome).toMatchObject({ maxLength: 40 });
        expect(query.agentId).toMatchObject({ format: "uuid" });
        expect(query.projectId).toMatchObject({ format: "uuid" });
        expect(query.sort).toMatchObject({ enum: ["newest", "oldest"] });
        expect(query.since).toMatchObject({ format: "date-time" });
      } else {
        expect(Object.keys(query).sort()).toEqual(["cursor", "limit"]);
        expect(operation.responses["404"]).toBeDefined();
      }
      for (const code of ["200", "400", "401", "403"]) {
        expect(operation.responses[code]).toBeDefined();
      }
    }

    const revision = spec.paths["/api/issues/{id}/documents/{key}/revisions/{revisionId}"].get;
    expect(revision.security).toEqual([...boardSecurity, { AgentBearerAuth: [] }]);
    const params = Object.fromEntries(revision.parameters.map(
      (parameter: { name: string; schema: unknown }) => [parameter.name, parameter.schema],
    ));
    expect(params.key).toMatchObject({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9_-]*$" });
    expect(params.revisionId).toMatchObject({ type: "string", format: "uuid" });
    for (const code of ["200", "400", "401", "403", "404"]) {
      expect(revision.responses[code]).toBeDefined();
    }
  });

  it("removes Pipelines discovery while retaining Cases and Routines", () => {
    const spec = buildOpenApiSpec() as any;
    const paths = Object.keys(spec.paths);
    expect(paths.filter((path) => /pipelines|review-cases|case-events/.test(path))).toEqual([]);
    // Standalone handoffs also use caseId; that parameter name no longer
    // identifies a removed Pipeline operation. Retain only their live paths.
    expect(paths.filter((path) => path.startsWith("/api/cases/{caseId}")).sort()).toEqual([
      "/api/cases/{caseId}/handoffs",
      "/api/cases/{caseId}/handoffs/{handoffId}/cancel",
      "/api/cases/{caseId}/handoffs/{handoffId}/retry",
    ]);
    expect(spec.paths["/api/companies/{companyId}/cases"].post).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/case-handoffs"].post).toBeDefined();
    expect(spec.paths["/api/cases/{id}"].get).toBeDefined();
    expect(spec.paths["/api/routines/{id}/run"].post).toBeDefined();
  });

  it("documents anonymous liveness separately from database readiness", () => {
    const spec = buildOpenApiSpec() as any;
    for (const method of ["get", "head"]) {
      const operation = spec.paths["/api/liveness"][method];
      expect(operation.security).toEqual([]);
      expect(operation.responses[503]).toBeDefined();
    }
    expect(Object.keys(spec.paths["/api/liveness"].get.responses[200].content["application/json"].schema.properties))
      .toEqual(["status", "commit"]);
    expect(spec.paths["/api/health"].get.responses[503]).toBeDefined();
  });
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

  it("documents strict run-attributed feedback and board-or-agent commentary reads", () => {
    const { spec } = loadSpecRoutes();
    const path = spec.paths["/api/companies/{companyId}/agent-commentary"];
    expect(Object.keys(path)).toEqual(["get", "post"]);
    const detail = spec.paths["/api/companies/{companyId}/agent-commentary/{id}"].get;
    for (const read of [path.get, detail]) {
      expect(read.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }, { AgentBearerAuth: [] }]);
      expect(read.responses["403"]).toBeDefined();
      expect(read.responses["404"]).toBeDefined();
    }
    expect(path.get.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(
      expect.arrayContaining(["agentId", "kind", "q", "limit", "offset"]),
    );
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

  it("documents delegated pool management with revision-checked deletion", () => {
    const { spec } = loadSpecRoutes();
    const pools = spec.paths["/api/companies/{companyId}/ai-connection-pools"];
    const remove = spec.paths["/api/companies/{companyId}/ai-connection-pools/{poolId}"].delete;
    const inspection = spec.paths["/api/companies/{companyId}/ai-connection-pools/{poolId}/inspection"].get;
    for (const operation of [pools.get, pools.post, remove, inspection]) {
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }, { AgentBearerAuth: [] }]);
    }
    expect(remove.requestBody.required).toBe(true);
    expect(remove.requestBody.content["application/json"].schema).toMatchObject({
      required: ["expectedRevision"], additionalProperties: false,
      properties: { expectedRevision: { type: "integer", minimum: 0, exclusiveMinimum: true } },
    });
    expect(Object.keys(remove.responses)).toEqual(expect.arrayContaining(["200", "400", "401", "403", "404", "409"]));
  });

  it("documents masked board-only agent export settings and revision-checked writes", () => {
    const { spec } = loadSpecRoutes();
    const settings = spec.paths["/api/companies/{companyId}/observability"];
    const test = spec.paths["/api/companies/{companyId}/observability/test"].post;
    for (const operation of [settings.get, settings.put, settings.delete, test]) {
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    expect(settings.delete.requestBody.content["application/json"].schema).toMatchObject({ required: ["expectedRevision"], additionalProperties: false });
    expect(test.responses["409"]).toBeDefined();
    expect(JSON.stringify(settings.get.responses)).not.toMatch(/credentialsSecretId|ciphertext|apiKey/);
    expect(test.responses["200"].content["application/json"].schema.properties.source).toMatchObject({ enum: ["control_plane"] });
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

  it("tells agents that Agent Chat is always on instead of advertising a retired toggle", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const experimental = res.body.paths["/api/instance/settings/experimental"];
    for (const operation of [experimental.get, experimental.patch]) {
      expect(operation.description).toContain("Agent Chat is always on");
      expect(operation.description).toContain("enableAgentChat is a retired compatibility key");
      expect(operation.description).toContain("tell them it is already on");
    }
  });

  it("tells agents that archiving keeps a status card and where a person restores it", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const patch = res.body.paths["/api/status-cards/{id}"].patch;
    expect(patch.description).toContain("it is not deleted");
    expect(patch.description).toContain("give them the returned href as a Markdown link");
    expect(patch.description).toContain("Restoring (archived: false) starts a fresh full summary");
  });

  it("tells agents that creating or refreshing a status card only queues the summarizer, so they reply now with its link", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const create = res.body.paths["/api/companies/{companyId}/status-cards"].post;
    expect(create.description).toContain("The response is returned before any summary exists");
    expect(create.description).toContain("reply now with the returned href as a Markdown link");
    const refresh = res.body.paths["/api/status-cards/{id}/refresh"].post;
    expect(refresh.description).toContain("Queues a refresh; it does not return a new summary");
    expect(refresh.description).toContain("Do not sleep or poll for it: reply now that the refresh is queued, with the returned card.href");
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
  it("advertises the guarded prepared-task promotion contract to API clients", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const patch = res.body.paths["/api/issues/{id}"].patch;
    expect(patch.requestBody.content["application/json"].schema.properties.expectedStatusVersion)
      .toMatchObject({ type: "integer", minimum: 0 });
    expect(patch.responses["409"]).toBeDefined();
    expect(patch.description).toContain("send exactly status=todo and expectedStatusVersion");
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

  it("publishes delegated chat configuration and human-only confirmation boundaries", () => {
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

    const humanOnly = new Set([
      "/api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay",
      "/api/chat-endpoints/{endpointId}/publications/{publicationId}/replay",
      "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications",
      "/api/chat-endpoints/{endpointId}/github/identity", "/api/chat-identity-links/preview", "/api/chat-identity-links/confirm",
      "/api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve", "/api/chat-endpoints/{endpointId}/actions/{actionId}/resolve",
    ]);
    for (const [method, routePath] of operations) {
      const operation = spec.paths[routePath]?.[method];
      expect(
        operation,
        `${method.toUpperCase()} ${routePath} is documented`,
      ).toBeDefined();
      expect(
        operation.security,
        `${method.toUpperCase()} ${routePath} retains its actor boundary`,
      ).toEqual(humanOnly.has(routePath) ? boardSecurity : [...boardSecurity, { AgentBearerAuth: [] }]);
      expect(operation["x-paperclip-authorization"]).toEqual({
        actor: humanOnly.has(routePath) ? "board" : "board_or_agent",
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
    const setupResponse = setup.responses["200"].content["application/json"].schema;
    expect((setupResponse.oneOf ?? setupResponse.anyOf)[1].properties.requiredUserAction.properties.kind.enum).toEqual(["enter_credentials"]);
    expect(setup.description).toContain("without changing credentials");
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
    const secretHandoff = setupSecret.responses["200"].content["application/json"].schema;
    expect(secretHandoff.properties.requiredUserAction.properties.kind.enum).toEqual(["enter_credentials"]);
    expect(secretHandoff.properties).not.toHaveProperty("webhookSecret");
    expect(setupSecret.description).toContain("without rotating or reading");
    expect(
      setupSecret.responses["201"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["webhookSecret", "credentialRotationId"],
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

  it("documents board-only prompt injection settings and fixed-sample testing", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/prompt-injection-prevention";
    for (const [method, suffix] of [["get", ""], ["put", ""], ["get", "/models"], ["post", "/test"]]) {
      expect(spec.paths[base + suffix][method]["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(spec.paths[base + suffix][method].security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    expect(spec.paths[base].put.requestBody.content["application/json"].schema).toMatchObject({
      additionalProperties: false, required: ["enabled", "connectionId", "grantId", "model"],
    });
    expect(spec.paths[base + "/test"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object", additionalProperties: false, properties: {},
    });
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

  it("documents agent permission grants as Board-only with a strict request", () => {
    const operation = loadSpecRoutes().spec.paths["/api/agents/{id}/permission-grants"].patch;
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(operation.requestBody.content["application/json"].schema).toMatchObject({
      additionalProperties: false, required: ["permissionKey", "enabled"],
      properties: { enabled: { type: "boolean" }, permissionKey: { enum: expect.arrayContaining(["commentary:view"]) } },
    });
  });

  it("documents additive project access as board-only with a strict request", () => {
    const { spec } = loadSpecRoutes();
    const path = spec.paths["/api/agents/{id}/project-access"];
    for (const operation of [path.get, path.post]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
      expect(operation.responses["200"].content["application/json"].schema.required).toEqual(["projectIds", "canManage"]);
    }
    expect(path.post.requestBody.content["application/json"].schema).toMatchObject({
      additionalProperties: false, required: ["projectIds"],
      properties: { projectIds: { type: "array", items: { type: "string", format: "uuid" } } },
    });
    expect(path.post.responses["409"]).toBeDefined();
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

  it("documents Muse operator management separately from receiver credentials", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/agents/{agentId}/muse-binding";
    const operations = [
      ["get", "/api/companies/{companyId}/muse-invitations"],
      ["post", "/api/companies/{companyId}/muse-invitations"],
      ["get", base], ["post", base], ["post", `${base}/verify`],
      ["post", `${base}/revoke`], ["post", `${base}/attest-stop`],
      ["post", `${base}/attest-detector-cleanup`],
      ["get", `${base}/qualification`], ["post", `${base}/qualification`], ["delete", `${base}/qualification`],
    ];
    for (const [method, routePath] of operations) {
      const operation = spec.paths[routePath][method];
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
      expect(operation.responses["403"]).toBeDefined();
    }
    expect(spec.paths[base].post.responses["201"]).toBeDefined();
    expect(spec.paths[base].post.responses["201"].content["application/json"].schema.properties.assetVersion.enum).toEqual([MUSE_ASSET_VERSION]);
    expect(spec.paths[`${base}/revoke`].post.responses["204"]).toBeDefined();
    expect(spec.paths[`${base}/qualification`].delete.responses["204"]).toBeDefined();
    expect(spec.paths[`${base}/qualification`].get.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "bindingId", in: "query", required: true }),
      expect.objectContaining({ name: "qualificationId", in: "query", required: true }),
    ]));
    for (const route of MUSE_PUBLIC_ROUTES) expect(spec.paths[route.path]).toBeUndefined();
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

  it("documents project environment compatibility and creation selection", () => {
    const { spec } = loadSpecRoutes();
    const operation = spec.paths["/api/companies/{companyId}/project-environments"].get;
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    expect(operation.responses["403"]).toBeDefined();
    expect(operation.responses["200"].content["application/json"].schema.properties).toHaveProperty("defaultEnvironmentId");
    const creation = spec.paths["/api/companies/{companyId}/projects"].post;
    expect(creation.requestBody.content["application/json"].schema.properties.environmentId).toMatchObject({ type: "string", format: "uuid" });
    expect(creation.requestBody.content["application/json"].schema.properties.expectedStorageProviderPluginId).toMatchObject({ type: "string", nullable: true });
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

  it("documents delegated GitHub setup with human identity confirmation and compatible owner-aware registration", () => {
    const { spec } = loadSpecRoutes();
    for (const [suffix, method] of [["draft", "put"], ["setup", "post"], ["identity/start", "post"], ["identity/confirm", "post"]]) {
      const operation = spec.paths[`/api/chat-endpoints/{endpointId}/github/${suffix}`][method];
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: suffix === "identity/confirm" ? "board" : "board_or_agent" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }, ...(suffix === "identity/confirm" ? [] : [{ AgentBearerAuth: [] }])]);
    }
    const registration = spec.paths["/api/chat-endpoints/{endpointId}/github/registration"].post;
    const input = registration.requestBody.content["application/json"].schema;
    expect(input.properties.ownerType.enum).toEqual(["personal", "organization"]);
    expect(input.required).not.toContain("ownerType");
    const response = registration.responses["200"].content["application/json"].schema;
    expect(response.oneOf ?? response.anyOf).toHaveLength(2);
    const appImport = spec.paths["/api/chat-endpoints/{endpointId}/github/app"].post;
    expect(appImport.description).toContain("Only a human session");
    const appImportResponse = appImport.responses["200"].content["application/json"].schema;
    expect(appImportResponse.oneOf ?? appImportResponse.anyOf).toHaveLength(2);
  });

  it("documents GitHub recovery, draft receipts, paged repositories and old review lookups", () => {
    const { spec } = loadSpecRoutes();
    const root = "/api/chat-endpoints/{endpointId}/github/";
    const setup = spec.paths[root + "setup"].post.responses["200"].content["application/json"].schema;
    expect(setup.properties.restartableRegistrationId.format).toBe("uuid");
    const restart = spec.paths[root + "registration/restart"].post;
    expect(restart["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    const restartInput = restart.requestBody.content["application/json"].schema;
    expect(restartInput.required).toEqual(expect.arrayContaining(["registrationId", "appNotCreated"]));
    expect(restartInput.properties.appNotCreated.enum ?? [restartInput.properties.appNotCreated.const]).toEqual([true]);
    const receipt = spec.paths[root + "draft"].put.responses["200"].content["application/json"].schema;
    expect(receipt.required).toEqual(["saved"]);
    expect(receipt.properties).not.toHaveProperty("state");
    const appInput = spec.paths[root + "app"].post.requestBody.content["application/json"].schema;
    const app = (appInput.oneOf ?? appInput.anyOf).find((variant: { properties?: { appId?: unknown } }) => variant.properties?.appId);
    expect(app.properties.clientId).toBeDefined();
    expect(app.properties.clientSecret).toBeDefined();
    expect(app.required).not.toContain("clientId");
    const page = spec.paths[root + "repositories"].get;
    expect(page.parameters.map((param: { name: string }) => param.name)).toEqual(expect.arrayContaining(["endpointId", "offset", "limit", "search"]));
    expect(page.responses["200"].content["application/json"].schema.properties).toHaveProperty("totalCount");
    expect(spec.paths[root + "repositories/access"].put["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    const review = spec.paths[root + "reviews/{reviewId}"].get;
    expect(review.parameters.map((param: { name: string }) => param.name)).toEqual(["endpointId", "reviewId"]);
    expect(review.responses["404"]).toBeDefined();
  });

  // The route-level test above can only fail when a real handler drifts. These
  // pin the scan's own rules, so a regression in the detector shows up as this
  // test failing rather than as the guard quietly reporting nothing.
  it("resolves board assertions transitively and scopes them to the right handler", () => {
    const closure = (source: string) =>
      resolveBoardAssertNames(maskLiterals(source), new Set([BOARD_ASSERT_ROOT]));

    // Two hops, declared in the order that needs a second pass: `outer` calls
    // `inner` before `inner` is known to assert.
    const chained = closure(`
      function outer(req: Request, companyId: string) { inner(req, companyId); }
      function inner(req: Request, companyId: string) { assertBoard(req); other(req); }
    `);
    expect([...chained].sort()).toEqual(["assertBoard", "inner", "outer"]);

    // A return-type annotation between the parameter list and the body.
    expect([...closure("function gate(req: Request, res: Response): string | null { assertBoard(req); }")])
      .toContain("gate");

    // Conditional assertions do not make a wrapper an assertion.
    expect([...closure("function maybe(req: Request) { if (req.actor.type === 'board') assertBoard(req); }")])
      .not.toContain("maybe");
    expect([...closure("function branch(req: Request) { if (x) { assertBoard(req); } }")])
      .not.toContain("branch");

    const names = new Set([BOARD_ASSERT_ROOT]);

    // A wrapper call must pass `req` first; a same-named call on something else
    // is not an assertion.
    expect(assertsBoardUnconditionally("(req, res) => { assertBoard(req, extra); }", names)).toBe(true);
    expect(assertsBoardUnconditionally("(req, res) => { assertBoard(other); }", names)).toBe(false);
    expect(assertsBoardUnconditionally("(req, res) => { svc.assertBoard(req); }", names)).toBe(false);

    // The neighbouring-helper mis-attribution: bounding the scan to the
    // registration's own arguments is what keeps `helper`'s assertion out of a
    // route that only calls `namedHandler`.
    const source = maskLiterals(`
      router.get("/thing", namedHandler);
      function helper(req: Request) { assertBoard(req); }
      function namedHandler(req: Request, res: Response) { res.json({}); }
    `);
    const registration = source.indexOf("router.get");
    expect(registrationArguments(source, registration)?.trim().endsWith("namedHandler")).toBe(true);
    expect(assertsBoardUnconditionally(registrationArguments(source, registration) ?? "", names)).toBe(false);
    expect(namedHandlerAssertsBoard(source, registration, names)).toBe(false);
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
    // Wrapper-guarded routes: none of these names the assertion directly, and each
    // is a shape an earlier version of this scan walked straight past.
    // `assertCompanySecretWrite(req, companyId)` — a wrapper taking further arguments.
    expect([...boardGuardedRoutes]).toContain("POST /api/companies/{companyId}/secrets");
    // `requireBoardUserId(req, res): string | null` — a return-type annotation between
    // the parameter list and the body.
    expect([...boardGuardedRoutes]).toContain("GET /api/sidebar-preferences/me");
    // `assertBoardPermission(...)` reached inside the handler's `try`.
    expect([...boardGuardedRoutes]).toContain("POST /api/tool-gateway/runtime-slots/{slotId}/stop");
    // `activeToolMembership` -> `assertToolConnectionConfigureAccess`: two hops from
    // `assertBoard`, so a one-level lookup is not enough.
    expect([...boardGuardedRoutes]).toContain("GET /api/tool-connections/{connectionId}/services");
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
    const activeSchema = spec.paths[`${base}/active`].get.responses["200"].content["application/json"].schema;
    expect(activeSchema.properties.agentId).toMatchObject({ type: "string", format: "uuid" });
    expect(activeSchema.required ?? []).not.toContain("agentId");
    expect((responseSchemas.status.properties as Record<string, unknown>).agentId).toBeUndefined();
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


it("documents explicit owner removals in the timeline response event enum", () => {
  const spec = buildOpenApiSpec() as any;
  const schema = spec.paths["/api/companies/{companyId}/timeline"].get.responses["200"].content["application/json"].schema;
  expect(schema.properties.events.items.properties.kind.enum).toEqual([
    "created", "commented", "approved", "delegated", "assigned", "unassigned",
  ]);
});

it("documents canonical saved-resource links in catalog team install responses", () => {
  const operation = buildOpenApiSpec().paths["/api/companies/{companyId}/teams/catalog/{catalogId}/install"].post;
  expect(operation.description).toContain("resourceLinks");
  const schema = operation.responses[201].content["application/json"].schema;
  expect(schema.required).toContain("resourceLinks");
  expect(schema.properties.resourceLinks.items.properties.kind.enum).toEqual(["agent", "project", "routine"]);
  expect(schema.properties.resourceLinks.items.required).toEqual(["kind", "id", "name", "href"]);
});
