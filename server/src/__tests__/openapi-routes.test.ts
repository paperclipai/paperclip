import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { COMPANY_IMPORT_TRANSFERS_ROUTE_PATH } from "@paperclipai/shared/company-import-transfer";
import { errorHandler } from "../middleware/index.js";
import { SPEC_OPERATION_TABLES, buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";

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
  "managed-agent-profiles.ts": "/api",
  "onboarding-seed.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
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
 * Masking rather than parsing. TypeScript 7 no longer exposes the syntactic
 * compiler API from its main entry (`ts.createSourceFile` and friends are gone;
 * the official lexer survives only under the explicitly-unstable
 * `typescript/unstable/ast/scanner` subpath, which a test should not couple to).
 * Vite's `parseAst` — a declared devDependency, and what this suite already runs
 * on — does parse annotated TypeScript with exact node offsets, and rebuilding
 * this scan on it would delete the lexer and the statement-position heuristics
 * below; that is the right follow-up if these helpers ever need to grow again.
 * For now the hand scan stays: its rules are individually pinned by tests and
 * were hardened against every shape the route tree actually contains. The trade
 * is covered rather than assumed: `loadActualRoutes` refuses to report any file
 * this masker cannot brace-balance, and the test asserts that list is empty, so
 * a masking bug fails the suite instead of silently shrinking what gets checked.
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
      // A property access spelled like a keyword — `q.in`, `p.of` — is a value,
      // not the keyword: check what precedes the word before trusting the list.
      if (k >= 0 && out[k] === ".") return false;
      return regexPrecedingKeywords.has(out.slice(k + 1, j + 1).join(""));
    }
    // A postfix `++`/`--` ends a value, so `n++ / 2` divides; reading it as a
    // regex would silently mask the rest of the line without unbalancing a brace.
    if ((out[j] === "+" || out[j] === "-") && out[j - 1] === out[j]) return false;
    // A closing quote ends a string value (`"100" / rate` divides) — quote
    // characters survive masking, so they are visible here. `}` is ambiguous
    // (object literal vs block end); treat it as ending a value too. No route
    // file opens a regex right after a block close, and misreading a real regex
    // as division leaves its text unmasked, which unbalances loudly.
    return !")]}\"'`".includes(out[j]);
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
// `assertInstanceAdmin` opens with `assertBoard` and then requires the admin flag,
// so the board closure absorbs it — a route guarded by it looks identical to an
// ordinary board route. That collapse is a drift class of its own: an operation
// moved from `INSTANCE_ADMIN_OPERATIONS` into `BOARD_ONLY_OPERATIONS` keeps
// `actor: "board"` and silently drops the admin restriction from the published
// contract. A second closure seeded here tracks the stricter tier separately.
const INSTANCE_ADMIN_ASSERT_ROOT = "assertInstanceAdmin";
const AUTHZ_FILE = "authz.ts";

// Guards that reject a non-board actor by inlining `req.actor.type !== "board"`
// instead of calling `assertBoard`, so the transitive closure cannot reach them.
// Each name is verified by reading its declaration: it throws for every non-board
// actor on every path. Keyed by file so a same-named helper elsewhere is not
// trusted by association. Every listed name must still exist as a declaration in
// its file — the scan collects the misses and the suite asserts none — so a
// rename cannot quietly turn an entry into a no-op.
const INLINE_BOARD_ASSERTIONS: Record<string, readonly string[]> = {};

// Same contract, stricter tier: each listed name additionally throws for every
// board actor that is not an instance admin (mirroring `assertInstanceAdmin`,
// which the environments helper inlines rather than calls). An entry here seeds
// the instance-admin closure and — since the stricter check implies the board
// one — the board closure too.
const INLINE_INSTANCE_ADMIN_ASSERTIONS: Record<string, readonly string[]> = {
  "environments.ts": ["assertCanAccessInstanceEnvironments"],
  "instance-settings.ts": ["assertCanManageInstanceSettings"],
};

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
// `_?req` because a handler that ignores its request except to assert names the
// parameter `_req` — `GET /api/adapters` is exactly that shape.
function boardAssertCallPattern(names: ReadonlySet<string>) {
  const alternation = [...names].map((name) => name.replace(/[$]/g, "\\$")).join("|");
  return new RegExp(`^(?:${alternation})\\(\\s*_?req\\s*[,)]`);
}

/**
 * Offset of the opening brace of a `function name(...) { ... }` body. Found by
 * matching the parameter list's parentheses rather than by searching for `)\s*{`,
 * because a return-type annotation sits between the two — `function
 * requireBoardUserId(req, res): string | null {` in `sidebar-preferences.ts` is
 * exactly the shape that a `)\s*{` search misses, which hid four board-only routes.
 */
function namedFunctionBodyStart(source: string) {
  const open = source.indexOf("(");
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return bodyBraceAfterParams(source, i + 1);
  }
  return -1;
}

/**
 * Index of the body's `{` after a parameter list, skipping a return-type
 * annotation. The type can itself contain braces — `: { ok: boolean }`,
 * `Promise<{ id: string }>` — so a `{` inside angle/paren nesting, or one whose
 * preceding character can only start a type construct (`:`, `|`, `&`, `,`), is
 * part of the type: its group is balanced over and the walk continues. `;` and
 * `=` end the declaration without a body (an overload signature, an alias), and
 * a function-type annotation's `=>` lands on the `=` case — both return -1, so
 * an unreadable declaration is skipped rather than analyzed from the wrong brace.
 */
function bodyBraceAfterParams(source: string, from: number) {
  let j = from;
  while (j < source.length && /\s/.test(source[j])) j++;
  if (source[j] === "{") return j;
  if (source[j] !== ":") return -1;
  let angles = 0;
  let parens = 0;
  let previous = ":";
  for (let i = j + 1; i < source.length; i++) {
    const char = source[i];
    if (/\s/.test(char)) continue;
    if (char === ";" || char === "=") return -1;
    if (char === "<") angles++;
    else if (char === ">") angles = Math.max(0, angles - 1);
    else if (char === "(") parens++;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === "{") {
      if (angles === 0 && parens === 0 && !":|&,<(".includes(previous)) return i;
      let braceDepth = 0;
      for (; i < source.length; i++) {
        if (source[i] === "{") braceDepth++;
        else if (source[i] === "}" && --braceDepth === 0) break;
      }
      previous = "}";
      continue;
    }
    previous = char;
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
  const bodyStart = isNamedFunction
    ? namedFunctionBodyStart(handlerSource)
    : nextTopLevelArrowBodyStart(handlerSource, 0);
  if (bodyStart < 0) return false;
  const callPattern = boardAssertCallPattern(assertNames);
  const blocks: string[] = [];
  for (let i = handlerSource.indexOf("{", bodyStart); i < handlerSource.length; i++) {
    const char = handlerSource[i];
    if (char === "{") {
      blocks.push(blocks.length > 0 && /\btry$/.test(handlerSource.slice(0, i).trimEnd()) ? "try" : "block");
      continue;
    }
    if (char === "}") {
      blocks.pop();
      if (blocks.length === 0) {
        // A function argument closed without asserting. In a registration span
        // that can be an inline middleware sitting before the real handler, and
        // every function argument runs unconditionally, so move on to the next
        // top-level arrow body instead of concluding the route is unguarded.
        const next = nextTopLevelArrowBodyStart(handlerSource, i + 1);
        if (next < 0) return false;
        i = next - 1; // the loop's increment lands on the body's `{`
      }
      continue;
    }
    if (blocks.slice(1).some((kind) => kind !== "try")) continue;
    if (!/[A-Za-z_$]/.test(char)) continue;
    if (/[\w$.]/.test(handlerSource[i - 1] ?? " ")) continue; // mid-identifier, or a `.method(` call
    // Unbounded slice: a windowed test misses a prettier-wrapped call whose
    // newline and indentation outrun the slack, and the anchored pattern fails
    // fast on a non-matching prefix anyway.
    if (!callPattern.test(handlerSource.slice(i))) continue;
    if (!isUnconditionalStatement(handlerSource, i)) continue;
    return true;
  }
  return false;
}

/**
 * True when the call starting at `at` is executed unconditionally — a statement of
 * its own, or the initializer of a plain `const`/`let` declarator. Anything guarded
 * by an operator is not: `x && assertBoard(req)`, `flag ? assertBoard(req) : null`
 * and `if (needsBoard(req)) assertBoard(req)` all reach the assertion only sometimes.
 *
 * Reading the preceding token rather than pattern-matching the text before it: the
 * earlier `\b(if|else)\s*(\([^()]*\))?\s*$` test could not see a condition containing
 * its own parentheses, so `if (needsBoard(req)) assertBoard(req)` read as
 * unconditional.
 */
function isUnconditionalStatement(source: string, at: number) {
  let j = at - 1;
  const skipWhitespace = () => {
    while (j >= 0 && /\s/.test(source[j])) j--;
  };
  skipWhitespace();
  if (j >= 4 && source.slice(j - 4, j + 1) === "await") {
    j -= 5;
    skipWhitespace();
  }
  if (j < 0) return true;
  // `return assertBoard(req);` executes exactly as unconditionally as a bare
  // statement — several wrappers end with it — but only when the `return` is
  // itself a statement: `if (x) return assertBoard(req);` stays conditional.
  if (j >= 5 && source.slice(j - 5, j + 1) === "return" && !/[\w$]/.test(source[j - 6] ?? " ")) {
    j -= 6;
    skipWhitespace();
    if (j < 0) return true;
    return source[j] === ";" || source[j] === "{" || source[j] === "}";
  }
  const previous = source[j];
  if (previous === ";" || previous === "{" || previous === "}") return true;
  // `const userId = boardUserId(req);` asserts just as unconditionally, but only
  // when the `=` is a declarator's, not part of `==`, `=>`, `+=` or a guarded
  // assignment such as `ok && (x = f(req))`.
  if (previous !== "=") return false;
  if (j > 0 && "=!<>+-*/%&|^".includes(source[j - 1])) return false;
  if (source[j + 1] === ">") return false;
  let start = j - 1;
  while (start >= 0 && !";{}".includes(source[start])) start--;
  const target = source.slice(start + 1, j);
  // A braceless `else y = assertBoard(req)` reaches the back-scan with a clean
  // target (the `if` block's `}` stops it before the condition's parens), so
  // control-flow keywords in the target disqualify it explicitly. A `)` in the
  // target means the statement hangs off a paren header — the back-scan stops at
  // a three-clause `for` header's last `;`, leaving ` i++) x ` as the target.
  return !/[()?]|&&|\|\||\b(?:else|case|default|do)\b/.test(target);
}

/**
 * The names that, called with `req`, guarantee a board actor — closed transitively
 * over `seed`. A declaration whose body unconditionally calls a known assertion is
 * itself an assertion, so the pass repeats until nothing new is found (a wrapper may
 * be declared above the wrapper it calls).
 *
 * Each declaration is analyzed over its own body only. Slicing to end-of-file instead
 * lets a declaration without a brace body — `const filters = (req) => ({ ... })` —
 * borrow the next unrelated `=> {` further down and inherit its assertion, which
 * quietly seeded the set with names like `body`, `path` and `payload`.
 */
function resolveBoardAssertNames(masked: string, seed: ReadonlySet<string>) {
  const names = new Set(seed);
  const declarations = declarationsIn(masked)
    .map((declaration) => ({ ...declaration, body: declarationBody(masked, declaration) }))
    .filter((declaration): declaration is typeof declaration & { body: string } => declaration.body !== null);
  for (;;) {
    const found = declarations.filter(
      (declaration) =>
        !names.has(declaration.name) &&
        assertsBoardUnconditionally(declaration.body, names, declaration.isNamedFunction),
    );
    if (found.length === 0) return names;
    for (const declaration of found) names.add(declaration.name);
  }
}

/**
 * The declaration's own text, from its start through the closing brace of its body.
 * Null when it has no brace body (a concise arrow, an overload signature), so an
 * unanalyzable declaration is skipped rather than reading someone else's body.
 */
function declarationBody(masked: string, declaration: { index: number; isNamedFunction: boolean }) {
  const source = masked.slice(declaration.index);
  const bodyStart = declaration.isNamedFunction ? namedFunctionBodyStart(source) : arrowFunctionBodyStart(source);
  if (bodyStart < 0) return null;
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(0, i + 1);
  }
  return null;
}

/**
 * Index of the `{` opening the next function body that is an argument at the top
 * level of `source` from `from`. An arrow nested inside another argument's
 * parentheses or object literal — a middleware factory's options callback, say —
 * is conditional machinery, not a function argument, and scanning it would let
 * `limiter({ onLimit: (req) => { assertBoard(req); } })` mark a route as
 * board-guarded. A concise arrow (no brace body) is walked past.
 */
function nextTopLevelArrowBodyStart(source: string, from: number) {
  let parens = 0;
  let braces = 0;
  for (let i = from; i < source.length; i++) {
    const char = source[i];
    if (char === "(") parens++;
    else if (char === ")") parens--;
    else if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "=" && source[i + 1] === ">" && parens === 0 && braces === 0) {
      const body = source.slice(i + 2).match(/^\s*\{/);
      if (body) return i + 2 + body[0].length - 1;
      i++;
    }
  }
  return -1;
}

// Offset of the brace opening a `const name = (...) => { ... }` body, requiring the
// arrow to belong to this declaration's own parameter list.
function arrowFunctionBodyStart(source: string) {
  const open = source.indexOf("(");
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) {
      const body = source.slice(i + 1).match(/^\s*(?::[^{;=]*)?=>\s*\{/);
      return body ? i + 1 + body[0].length - 1 : -1;
    }
  }
  return -1;
}

// A few routes pass a named handler rather than an inline arrow. Resolve the
// identifier against the same file and analyze the function it names.
function namedHandlerAssertsBoard(masked: string, registrationIndex: number, assertNames: ReadonlySet<string>) {
  const args = registrationArguments(masked, registrationIndex);
  if (args === null) return false;
  // The handler is the last non-empty comma segment (a prettier trailing comma
  // leaves an empty one). An arrow elsewhere in the arguments — an inline
  // middleware before a named handler — is fine: any fragment of it fails the
  // identifier test below, so only a clean trailing identifier is resolved.
  const handlerName =
    args
      .split(",")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .pop() ?? "";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(handlerName)) return false;
  const declaration = declarationsIn(masked).find((entry) => entry.name === handlerName);
  if (!declaration) return false;
  // The declaration's own body only — an unbounded slice reintroduces the
  // borrow-the-next-body spillover that `resolveBoardAssertNames` bounds against.
  const body = declarationBody(masked, declaration);
  if (body === null) return false;
  return assertsBoardUnconditionally(body, assertNames, declaration.isNamedFunction);
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

// The one place both registration loops decide a route is guarded: an inline
// (or middleware-preceded) function argument asserting, or a named handler
// whose declaration asserts. Shared so the two loops cannot drift apart —
// the constant-path loop once silently lacked the named-handler arm.
function routeIsBoardGuarded(masked: string, registrationIndex: number, assertNames: ReadonlySet<string>) {
  return (
    assertsBoardUnconditionally(registrationArguments(masked, registrationIndex) ?? "", assertNames) ||
    namedHandlerAssertsBoard(masked, registrationIndex, assertNames)
  );
}

function braceBalanceOf(masked: string) {
  let balance = 0;
  for (const char of masked) {
    if (char === "{") balance++;
    else if (char === "}") balance--;
  }
  return balance;
}

// Memoized: the scan is deterministic over the on-disk sources and three tests
// consume it; re-running it doubles the suite's runtime for identical results.
let cachedActualRoutes: ReturnType<typeof computeActualRoutes> | undefined;
function loadActualRoutes() {
  return (cachedActualRoutes ??= computeActualRoutes());
}

function computeActualRoutes() {
  const routes = new Set<string>();
  const boardGuardedRoutes = new Set<string>();
  const instanceAdminGuardedRoutes = new Set<string>();
  const unknownRouteFiles: string[] = [];
  const unbalancedRouteFiles: string[] = [];
  const missingInlineAssertions: string[] = [];

  // The shared assertions first: everything in `authz.ts` that bottoms out in
  // `assertBoard`. Route files then extend this with their own local wrappers.
  // `authz.ts` has no `apiPrefixes` entry, so it never passes through the loop's
  // brace-balance check below — but every route file's assertion set is seeded from
  // it, and losing `assertBoardOrgAccess` alone would drop 25 routes from coverage
  // with every pinned expectation still green. Balance it explicitly.
  const maskedAuthz = maskLiterals(fs.readFileSync(path.join(ROUTES_DIR, AUTHZ_FILE), "utf8"));
  if (braceBalanceOf(maskedAuthz) !== 0) unbalancedRouteFiles.push(AUTHZ_FILE);
  const sharedAssertNames = resolveBoardAssertNames(maskedAuthz, new Set([BOARD_ASSERT_ROOT]));
  const sharedInstanceAdminNames = resolveBoardAssertNames(maskedAuthz, new Set([INSTANCE_ADMIN_ASSERT_ROOT]));

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
    if (braceBalanceOf(masked) !== 0) unbalancedRouteFiles.push(file);

    const inlineInstanceAdminAssertions = INLINE_INSTANCE_ADMIN_ASSERTIONS[file] ?? [];
    const inlineAssertions = [...(INLINE_BOARD_ASSERTIONS[file] ?? []), ...inlineInstanceAdminAssertions];
    if (inlineAssertions.length > 0) {
      const declared = new Set(declarationsIn(masked).map((declaration) => declaration.name));
      for (const name of inlineAssertions) {
        if (!declared.has(name)) missingInlineAssertions.push(`${file}: ${name}`);
      }
    }
    const assertNames = resolveBoardAssertNames(masked, new Set([...sharedAssertNames, ...inlineAssertions]));
    const instanceAdminAssertNames = resolveBoardAssertNames(
      masked,
      new Set([...sharedInstanceAdminNames, ...inlineInstanceAdminAssertions]),
    );

    const classify = (route: string, at: number) => {
      routes.add(route);
      if (routeIsBoardGuarded(masked, at, assertNames)) boardGuardedRoutes.add(route);
      if (routeIsBoardGuarded(masked, at, instanceAdminAssertNames)) instanceAdminGuardedRoutes.add(route);
    };

    const registrations = [...source.matchAll(ROUTE_LITERAL_PATTERN)];
    registrations.forEach((match) => {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      classify(`${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`, match.index);
    });

    for (const { file: constantFile, marker, route } of constantPathRoutes) {
      if (file !== constantFile) continue;
      // Search the masked source: a comment mentioning the marker is blanked
      // there, so the offset can only anchor on the real registration.
      const at = masked.indexOf(marker);
      if (at < 0) continue;
      classify(route, at);
    }
  }

  return {
    routes,
    boardGuardedRoutes,
    instanceAdminGuardedRoutes,
    unknownRouteFiles: unknownRouteFiles.sort(),
    unbalancedRouteFiles: unbalancedRouteFiles.sort(),
    missingInlineAssertions: missingInlineAssertions.sort(),
  };
}

// Memoized for the same reason as the route scan: building the document is
// deterministic and several tests consume it.
let cachedSpecRoutes: ReturnType<typeof computeSpecRoutes> | undefined;
function loadSpecRoutes() {
  return (cachedSpecRoutes ??= computeSpecRoutes());
}

function computeSpecRoutes() {
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

    // A return-type annotation between the parameter list and the body — plain,
    // object-literal, and generic-wrapped: the type's own braces are balanced
    // over rather than mistaken for the body.
    expect([...closure("function gate(req: Request, res: Response): string | null { assertBoard(req); }")])
      .toContain("gate");
    expect([...closure("function typed(req: Request): { ok: boolean } { assertBoard(req); }")])
      .toContain("typed");
    expect([...closure("async function generic(req: Request): Promise<{ id: string }> { assertBoard(req); }")])
      .toContain("generic");

    // Conditional assertions do not make a wrapper an assertion. The braceless
    // cases matter most: a condition containing its own parentheses, and the
    // operator forms, all reach the assertion only sometimes.
    expect([...closure("function maybe(req: Request) { if (req.actor.type === 'board') assertBoard(req); }")])
      .not.toContain("maybe");
    expect([...closure("function branch(req: Request) { if (x) { assertBoard(req); } }")])
      .not.toContain("branch");
    expect([...closure("function nested(req: Request) { if (needsBoard(req)) assertBoard(req); }")])
      .not.toContain("nested");
    expect([...closure("function andForm(req: Request) { x && assertBoard(req); }")]).not.toContain("andForm");
    expect([...closure("function ternary(req: Request) { flag ? assertBoard(req) : null; }")])
      .not.toContain("ternary");
    // A braceless-else assignment: the back-scan stops at the if-block's `}`,
    // so the `else` keyword itself must disqualify the declarator form.
    expect([...closure("function elseAssign(req: Request) { if (x) { serve(); } else y = assertBoard(req); }")])
      .not.toContain("elseAssign");
    // ...but a plain declarator initializer is unconditional.
    expect([...closure("function viaConst(req: Request) { const id = assertBoard(req); return id; }")])
      .toContain("viaConst");
    expect([...closure("async function viaAwait(req: Request) { const id = await assertBoard(req); return id; }")])
      .toContain("viaAwait");
    // A return-position assertion executes exactly as unconditionally as a bare
    // statement — but not when the `return` itself hangs off a braceless `if`.
    expect([...closure("function viaReturn(req: Request) { return assertBoard(req); }")])
      .toContain("viaReturn");
    expect([...closure("function condReturn(req: Request) { if (x) return assertBoard(req); }")])
      .not.toContain("condReturn");
    // Divisions must not be read as regex literals — the masker would silently
    // blank the assertion sharing the line: after a postfix increment, after a
    // closing string quote, and after a property access spelled like a
    // regex-preceding keyword.
    expect([...closure("function afterDivision(req: Request) { n++; const a = n++ / 2; assertBoard(req); }")])
      .toContain("afterDivision");
    expect([...closure('function divAfterString(req: Request) { const n = "100" / rate; assertBoard(req); }')])
      .toContain("divAfterString");
    expect([...closure("function propKeyword(req: Request) { const half = q.in / 2; assertBoard(req); }")])
      .toContain("propKeyword");
    // A three-clause `for` header can run its body zero times; an assignment
    // hanging off it is conditional.
    expect([...closure("function forHeader(req: Request) { for (let i = 0; i < n; i++) x = assertBoard(req); }")])
      .not.toContain("forHeader");
    // A prettier-wrapped call — newline and deep indentation between `(` and the
    // argument — is still the same unconditional call.
    expect([...closure("function wrapped(req: Request) { assertBoard(\n              req,\n            ); }")])
      .toContain("wrapped");

    // A declaration with no brace body must not borrow the next one's. Without
    // bounding each declaration to its own body, `concise` inherits `real`'s
    // assertion and the closure fills up with names like `body` and `payload`.
    const spillover = closure(`
      const concise = (req: Request) => ({ id: req.params.id });
      const real = (req: Request) => { assertBoard(req); };
    `);
    expect([...spillover]).toContain("real");
    expect([...spillover]).not.toContain("concise");

    const names = new Set([BOARD_ASSERT_ROOT]);

    // A wrapper call must pass `req` first; a same-named call on something else
    // is not an assertion. `_req` is the same parameter under the
    // unused-elsewhere naming convention.
    expect(assertsBoardUnconditionally("(req, res) => { assertBoard(req, extra); }", names)).toBe(true);
    expect(assertsBoardUnconditionally("(_req, res) => { assertBoard(_req); }", names)).toBe(true);
    expect(assertsBoardUnconditionally("(req, res) => { assertBoard(other); }", names)).toBe(false);
    expect(assertsBoardUnconditionally("(req, res) => { svc.assertBoard(req); }", names)).toBe(false);

    // An inline middleware before the real handler: every function argument runs
    // unconditionally, so an assertion in any of them guards the route — and its
    // absence from all of them does not become a false positive.
    expect(
      assertsBoardUnconditionally(
        '"/x", (req, res, next) => { next(); }, (req, res) => { assertBoard(req); res.json({}); }',
        names,
      ),
    ).toBe(true);
    expect(
      assertsBoardUnconditionally(
        '"/x", (req, res, next) => { next(); }, (req, res) => { res.json({}); }',
        names,
      ),
    ).toBe(false);
    // An arrow nested inside another argument's object literal is a conditional
    // callback, not a function argument — its assertion must not count.
    expect(
      assertsBoardUnconditionally(
        '"/x", limiter({ onLimit: (req, res) => { assertBoard(req); } }), realHandler',
        names,
      ),
    ).toBe(false);

    // A prettier-wrapped named-handler registration carries a trailing comma;
    // the handler is still resolved and its body still analyzed.
    const wrapped = maskLiterals(`
      router.get(
        "/wrapped",
        wrappedHandler,
      );
      function wrappedHandler(req: Request, res: Response) { assertBoard(req); res.json({}); }
    `);
    expect(namedHandlerAssertsBoard(wrapped, wrapped.indexOf("router.get"), names)).toBe(true);

    // An inline arrow middleware before a named handler must not stop the named
    // handler from being resolved — and an arrow in final position still fails
    // the identifier test rather than being mistaken for a name.
    const arrowThenNamed = maskLiterals(`
      router.get("/x", (req, res, next) => { next(); }, namedAfterArrow);
      function namedAfterArrow(req: Request, res: Response) { assertBoard(req); res.json({}); }
    `);
    expect(namedHandlerAssertsBoard(arrowThenNamed, arrowThenNamed.indexOf("router.get"), names)).toBe(true);

    // The neighbouring-helper mis-attribution. `/thing` runs `namedHandler`, which
    // asserts nothing; the arrow-bodied `helper` below it does assert. Scanning from
    // the registration to the *next* registration swallows `helper` and reports the
    // route as board-guarded, so the span is bounded to the registration's own
    // arguments instead.
    const source = maskLiterals(`
      router.get("/thing", namedHandler);
      const helper = (req: Request) => { assertBoard(req); };
      function namedHandler(req: Request, res: Response) { res.json({}); }
    `);
    const registration = source.indexOf("router.get");
    expect(registrationArguments(source, registration)?.trim().endsWith("namedHandler")).toBe(true);
    // The unbounded span is precisely what the bounded one must not behave like.
    expect(assertsBoardUnconditionally(source.slice(registration), names)).toBe(true);
    expect(assertsBoardUnconditionally(registrationArguments(source, registration) ?? "", names)).toBe(false);
    expect(namedHandlerAssertsBoard(source, registration, names)).toBe(false);
  });

  it("annotates every unconditionally board-guarded route as board-only", () => {
    const { boardGuardedRoutes, unbalancedRouteFiles, missingInlineAssertions } = loadActualRoutes();
    const { spec } = loadSpecRoutes();

    // The scan only means anything while it can still read the route files.
    expect(unbalancedRouteFiles).toEqual([]);
    // ...and while every hand-vouched inline assertion still exists — a renamed
    // helper must fail here, not quietly turn its ledger entry into a no-op.
    expect(missingInlineAssertions).toEqual([]);
    // A floor on the guarded set: the mislabel check below is a subset check, so
    // a scan regression that silently dropped dozens of routes would pass it on
    // the smaller set. Legitimate churn can lower this deliberately; a mass drop
    // cannot pass it accidentally.
    expect(boardGuardedRoutes.size).toBeGreaterThanOrEqual(240);
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
    // `assertBoardOrgAccess(_req)` — the parameter named under the unused
    // convention, which a literal-`req` pattern walked straight past.
    expect([...boardGuardedRoutes]).toContain("GET /api/adapters");
    // `assertCanAccessInstanceEnvironments` inlines its board check instead of
    // calling `assertBoard`, so it is seeded via INLINE_BOARD_ASSERTIONS.
    expect([...boardGuardedRoutes]).toContain("PATCH /api/environments/{id}");
    // An inline `validate(...)` middleware sits before the asserting handler.
    expect([...boardGuardedRoutes]).toContain("POST /api/companies/{companyId}/environments");
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

  // The stricter tier of the same drift class: `assertInstanceAdmin` opens with
  // `assertBoard`, so to the check above an instance-admin route is just a board
  // route — `actor: "board"` satisfies it whether or not `instanceAdmin: true`
  // survived. An operation moved from `INSTANCE_ADMIN_OPERATIONS` into
  // `BOARD_ONLY_OPERATIONS` would drop the admin restriction from the published
  // contract without failing anything. This test tracks the instance-admin
  // closure separately and pins the annotation itself.
  it("annotates every unconditionally instance-admin-guarded route as instance-admin", () => {
    const { boardGuardedRoutes, instanceAdminGuardedRoutes } = loadActualRoutes();
    const { spec } = loadSpecRoutes();

    // The stricter closure can only see a subset of the board closure — every
    // instance-admin assertion is also a board assertion. A route in one set but
    // not the other is a scan defect, not a finding about the route.
    expect([...instanceAdminGuardedRoutes].filter((route) => !boardGuardedRoutes.has(route))).toEqual([]);

    // Direct `assertInstanceAdmin` callers, and the environments family reached
    // only through the inline `assertCanAccessInstanceEnvironments` seed.
    expect([...instanceAdminGuardedRoutes]).toContain("PATCH /api/adapters/{type}");
    expect([...instanceAdminGuardedRoutes]).toContain("PATCH /api/environments/{id}");
    // Negative controls: an ordinary board route stays out of the stricter set,
    // and a conditional instance-admin check (bootstrap-CEO invites only) does
    // not promote a `board_or_agent` route into it.
    expect([...instanceAdminGuardedRoutes]).not.toContain("POST /api/execution-workspaces/{id}/reconcile-branch");
    expect([...instanceAdminGuardedRoutes]).not.toContain("POST /api/invites/{inviteId}/revoke");

    const mislabeled = [...instanceAdminGuardedRoutes]
      .filter((route) => {
        const separator = route.indexOf(" ");
        const operation = spec.paths?.[route.slice(separator + 1)]?.[route.slice(0, separator).toLowerCase()];
        // A guarded route missing from the spec entirely is the coverage test's
        // failure to report, not this one's.
        if (!operation) return false;
        return operation["x-paperclip-authorization"]?.instanceAdmin !== true;
      })
      .sort();

    expect(mislabeled).toEqual([]);

    // The same floor rationale as the board set: the mislabel check is a subset
    // check, so a scan regression that emptied this set would pass it trivially.
    expect(instanceAdminGuardedRoutes.size).toBeGreaterThanOrEqual(40);
  });

  // The other direction of table rot: the guard above fires when a guarded
  // handler is missing from the table, but nothing else notices a table entry
  // that stops matching a served operation — `resolveOperationAuthLevel` falls
  // through to `authenticated` for unmatched auth keys, and the status
  // overrides simply no-op — so a route rename or a typo silently changes the
  // published contract.
  it("keeps every operation-table entry matched to a served operation", () => {
    const { routes: specRoutes } = loadSpecRoutes();

    const stale = Object.entries(SPEC_OPERATION_TABLES)
      .flatMap(([table, operations]) =>
        [...operations].filter((operation) => !specRoutes.has(operation)).map((operation) => `${table}: ${operation}`),
      )
      .sort();

    expect(stale).toEqual([]);

    // An operation in two auth tables is one entry shadowing the other by
    // precedence order: the loser is dead, and deleting the winner during a
    // cleanup would silently change the published level. (`created`/`accepted`
    // are status tables and legitimately overlap the auth tables.)
    const authTables = ["public", "runtimeTools", "board", "instanceAdmin"] as const;
    const seen = new Map<string, string>();
    const shadowed: string[] = [];
    for (const table of authTables) {
      for (const operation of SPEC_OPERATION_TABLES[table]) {
        const holder = seen.get(operation);
        if (holder) shadowed.push(`${operation} (${holder} + ${table})`);
        else seen.set(operation, table);
      }
    }
    expect(shadowed.sort()).toEqual([]);
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
    // The adapter login-session create route's board guard is callback-shaped
    // (the start spine awaits `deriveOwner` -> `assertCanManageAdapterLogin` ->
    // `assertBoard`), so the drift scan cannot see it; its table entry is
    // maintained by hand and pinned here so removing it fails loudly.
    expect(
      spec.paths["/api/companies/{companyId}/adapters/{type}/login-sessions"].post["x-paperclip-authorization"],
    ).toEqual({ actor: "board" });
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["403"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/managed-agent-profiles"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/companies/{companyId}/remote-agent-profiles"].get.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    const remoteAgentProfileBody =
      spec.paths["/api/companies/{companyId}/remote-agent-profiles"].post.requestBody.content[
        "application/json"
      ].schema;
    expect(remoteAgentProfileBody.properties.service).toMatchObject({
      type: "string",
      enum: ["aws_bedrock_agentcore_harness"],
    });
    expect(remoteAgentProfileBody.properties.credentialSecretId).toBeUndefined();
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
