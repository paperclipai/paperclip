import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPANY_IMPORT_TRANSFERS_ROUTE_PATH } from "@paperclipai/shared/company-import-transfer";
import { buildOpenApiSpec } from "../routes/openapi.js";

// The sibling openapi-routes.test.ts asserts the server→spec direction: every
// route literal mounted in server/src/routes must appear in the generated
// OpenAPI document. This file asserts the UI→spec direction: every API route
// the web client (ui/src/api/*.ts) references must resolve to an entry in the
// same generated spec. The UI hand-writes its fetch URL strings (relative to
// the client's "/api" base) independently of the server's route definitions,
// so without this check nothing catches UI↔server route drift — a UI path
// that no longer matches a mounted route only surfaces as a runtime 404.
//
// The scan is deliberately static and loud:
// - every api.get/post/put/patch/delete/postForm/putRaw/deleteWithBody call,
//   every direct fetch call, and every auth*() wrapper call in ui/src/api
//   (excluding *.test.ts and the shared transport client.ts) must resolve to
//   at least one concrete route pattern;
// - call sites the scanner cannot resolve statically fail the test by name
//   (file:line) instead of being skipped;
// - routes the UI references but the spec does not list fail the test unless
//   they appear in explicitUiRouteExclusions below, and every exclusion must
//   stay referenced (stale exclusions fail too, so the list cannot rot).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_API_DIR = path.resolve(__dirname, "../../../ui/src/api");

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

type RouteResolution =
  { cands: string[]; next: number } | { unresolved: string };

interface UiPathHelper {
  /** 0-based argument indexes whose values the template consumes. Arguments
   *  outside `needs` (opaque ids, selectors, query scopes) are never resolved,
   *  so helper calls can pass runtime values the scanner cannot name. */
  needs: number[];
  make: (args: Array<{ cands: string[] } | undefined>) => string[];
}

// Route-path constants imported by ui/src/api from shared packages, resolved
// to their literal values (same idea as routePathConstantSubstitutions in
// openapi-routes.test.ts).
const importedRoutePathConstants: Record<string, string> = {
  COMPANY_IMPORT_TRANSFERS_ROUTE_PATH,
};

// Known path-builder helpers used by ui/src/api call sites. Each entry cites
// the defining module; keeping the shapes here explicit means a helper whose
// real output drifts from this table shows up as a missingInSpec failure.
const uiPathHelpers: Record<string, UiPathHelper> = {
  // ui/src/api/agents.ts — `/agents/{id}${suffix}` (withCompanyScope only
  // appends a `?companyId=` query, which normalization strips).
  agentPath: { needs: [2], make: (a) => withSuffix("/agents/{param}", a[2]) },
  // ui/src/api/projects.ts — `/projects/{id}${suffix}`.
  projectPath: {
    needs: [2],
    make: (a) => withSuffix("/projects/{param}", a[2]),
  },
  // ui/src/api/summarySlots.ts — `/companies/{companyId}/summary-slots/{scopeKind}/{slotKey}${suffix}`.
  summarySlotPath: {
    needs: [1],
    make: (a) =>
      withSuffix("/companies/{param}/summary-slots/{param}/{param}", a[1]),
  },
  // ui/src/api/document-annotations.ts — one candidate per target kind.
  targetBasePath: {
    needs: [],
    make: () => [
      "/routines/{param}/description/annotations",
      "/cases/{param}/documents/{param}/annotations",
      "/issues/{param}/documents/{param}/annotations",
    ],
  },
  // ui/src/api/environments.ts — query-string builder.
  companyIdQuery: { needs: [], make: () => ["?companyId={param}"] },
  // Query-string builders across ui/src/api (all return `?…` or "").
  buildInviteListQuery: { needs: [], make: () => queryCandidates },
  buildArtifactsQuery: { needs: [], make: () => queryCandidates },
  toQuery: { needs: [], make: () => queryCandidates },
  dateParams: { needs: [], make: () => queryCandidates },
  dateParamsWithLimit: { needs: [], make: () => queryCandidates },
  listQuery: { needs: [], make: () => queryCandidates },
  query: { needs: [], make: () => queryCandidates },
  // ui/src/api/smokeLab.ts — `/companies/${companyId}/smoke-lab`.
  base: { needs: [], make: () => ["/companies/{param}/smoke-lab"] },
  // packages/shared/src/company-import-transfer.ts — paths relative to the
  // /companies mount the UI template literals already provide.
  companyImportTransferPath: {
    needs: [],
    make: () => ["/import/transfers/{param}"],
  },
  companyImportTransferPartPath: {
    needs: [],
    make: () => ["/import/transfers/{param}/parts/{param}"],
  },
  companyImportTransferPreviewPath: {
    needs: [],
    make: () => ["/import/transfers/{param}/preview"],
  },
  companyImportTransferApplyPath: {
    needs: [],
    make: () => ["/import/transfers/{param}/apply"],
  },
};

const queryCandidates = ["?{param}", ""];

// Calls whose result is a single opaque path segment (id encoding, string
// coercion for query strings).
const paramSegmentCalls = new Set([
  "encodeURIComponent",
  "encodeURI",
  "decodeURIComponent",
  "decodeURI",
  "String",
  "toString",
]);

// UI-referenced routes that intentionally do not exist in the generated spec.
// Keyed by the canonical `METHOD /path` form the scan produces. Every entry
// must stay referenced by the UI scan and stay absent from the spec, or the
// test fails with it as an unused exclusion — so this list cannot rot.
const explicitUiRouteExclusions = new Set<string>([
  // ui/src/api/auth.ts's authPost/authPatch transport wrappers take the
  // request path as a parameter, so the wrapper's own fetch resolves to
  // `/api/auth{param}`. The concrete routes they carry are captured by the
  // authPost("...") / authPatch("...") wrapper call sites, which the scan
  // resolves separately.
  "POST /api/auth{param}",
  "PATCH /api/auth{param}",
  // Email sign-in/sign-up/sign-out are served by the better-auth handler
  // mounted as a catch-all (app.all("/api/auth/{*authPath}")), not by routes
  // registered in the OpenAPI spec.
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-up/email",
  "POST /api/auth/sign-out",
  // ui/src/api/execution-workspaces.ts posts the concrete action value
  // "repair" where the spec models the parametrized route
  // /api/execution-workspaces/{id}/runtime-commands/{action}.
  "POST /api/execution-workspaces/{param}/runtime-commands/repair",
]);

function withSuffix(
  prefix: string,
  suffix: { cands: string[] } | undefined,
): string[] {
  return (suffix?.cands ?? [""]).map((s) => `${prefix}${s}`);
}

// ---------------------------------------------------------------------------
// Small string/template-aware source walkers. All indexes refer to the
// comment-stripped source (stripComments preserves offsets and line breaks,
// so positions and line numbers match the original file).

const isWs = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r";

function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i]!)) i++;
  return i;
}

/** Skip a template literal starting after its opening backtick. */
function skipTemplate(s: string, i: number): number {
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === "`") return i + 1;
    if (s[i] === "$" && s[i + 1] === "{") {
      i = findTopLevel(s, i + 2, "}") + 1;
      continue;
    }
    i++;
  }
  return i;
}

/** Index of the first top-level occurrence in `stops` at depth 0 within
 *  [start, end), or -1. Strings, template literals, and bracket nesting are
 *  skipped; `skip` lets a matched char be passed over (used to step over
 *  `?.` / `??` / `?:` while hunting a ternary `?`). */
function findTopLevel(
  s: string,
  start: number,
  stops: string,
  end: number = s.length,
  skip: ((idx: number) => boolean) | null = null,
): number {
  let i = start;
  let depth = 0;
  while (i < s.length) {
    if (depth === 0 && i >= end) return -1;
    const c = s[i]!;
    if (depth === 0 && skip && skip(i)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < s.length && s[i] !== c) i += s[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "`") {
      i = skipTemplate(s, i + 1);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0 && stops.includes(c)) return i;
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && stops.includes(c)) return i;
    i++;
  }
  return -1;
}

/** Replace line and block comments with whitespace of identical length. */
function stripComments(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const end = i;
      i++;
      while (i < s.length && s[i] !== c) i += s[i] === "\\" ? 2 : 1;
      out += s.slice(end, i + 1);
      i++;
      continue;
    }
    if (c === "`") {
      const end = i;
      i = skipTemplate(s, i + 1);
      out += s.slice(end, i);
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const end = i;
      while (i < s.length && s[i] !== "\n") i++;
      out += " ".repeat(i - end);
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = i;
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i = Math.min(i + 2, s.length);
      out += s.slice(end, i).replace(/[^\n]/g, " ");
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static path-expression resolution over one file's source.

interface UiApiFile {
  file: string;
  src: string;
}

function parseCallArgs(
  s: string,
  i: number,
): { regions: Array<{ start: number; end: number }>; next: number } {
  const regions: Array<{ start: number; end: number }> = [];
  for (;;) {
    const start = skipWs(s, i);
    const end = findTopLevel(s, start, ",)");
    if (end === -1) return { regions, next: s.length };
    regions.push({ start, end });
    i = end + 1;
    if (s[end] === ")") return { regions, next: end + 1 };
  }
}

function resolveExpr(
  file: UiApiFile,
  start: number,
  interp: boolean,
  end?: number,
): RouteResolution {
  const s = file.src;
  const limit = end ?? s.length;
  let i = skipWs(s, start);
  if (i >= limit) return { unresolved: "empty expression" };
  const c = s[i]!;

  let acc: RouteResolution;
  if (c === '"' || c === "'") {
    i++;
    let text = "";
    while (i < s.length && s[i] !== c) {
      if (s[i] === "\\") {
        text += s[i + 1]!;
        i += 2;
      } else text += s[i++]!;
    }
    acc = { cands: [text], next: i + 1 };
  } else if (c === "`") {
    acc = resolveTemplate(file, i + 1, limit);
  } else {
    // Ternary at top level: the scan needs both branch paths (each candidate
    // must independently resolve against the spec). `?.`/`??`/`?:` are not
    // ternary markers.
    const notTernary = (idx: number) =>
      s[idx + 1] === "." || s[idx + 1] === "?" || s[idx + 1] === ":";
    const q = findTopLevel(s, i, "?", limit, notTernary);
    if (q !== -1) {
      const colon = findTopLevel(s, q + 1, ":", limit);
      if (colon !== -1) {
        const t = resolveExpr(file, q + 1, interp, colon);
        const f = resolveExpr(file, colon + 1, interp, limit);
        if ("unresolved" in t && "unresolved" in f) acc = t;
        else if ("unresolved" in t) acc = f;
        else if ("unresolved" in f) acc = t;
        else acc = { cands: [...t.cands, ...f.cands], next: limit };
      } else {
        acc = resolvePrimary(file, i, interp, limit);
      }
    } else {
      acc = resolvePrimary(file, i, interp, limit);
    }
  }

  if ("unresolved" in acc) return acc;
  // `+` concatenation chain ("/companies/" + id + "/projects" + …).
  let next = skipWs(s, acc.next);
  while (next < limit && s[next] === "+" && s[next + 1] !== "+") {
    const op = resolveExpr(file, next + 1, interp, limit);
    if ("unresolved" in op) return op;
    acc = {
      cands: acc.cands.flatMap((x) => op.cands.map((y) => x + y)),
      next: op.next,
    };
    next = skipWs(s, op.next);
  }
  return acc;
}

function resolvePrimary(
  file: UiApiFile,
  start: number,
  interp: boolean,
  limit: number,
): RouteResolution {
  const s = file.src;
  let i = start;
  if (s[i] === "(") {
    const close = findTopLevel(s, i + 1, ")");
    const inner = resolveExpr(file, i + 1, interp, close);
    if ("unresolved" in inner) return inner;
    return { cands: inner.cands, next: close + 1 };
  }
  if (!/[A-Za-z_$]/.test(s[i]!)) {
    return { unresolved: `unexpected char ${JSON.stringify(s[i])}` };
  }
  let word = "";
  while (
    i < limit &&
    (/[A-Za-z0-9_$]/.test(s[i]!) ||
      s[i] === "." ||
      (s[i] === "?" && s[i + 1] === "."))
  ) {
    word += s[i]!;
    i++;
  }
  const after = skipWs(s, i);
  if (s[after] === "(" && after < limit) {
    const { regions, next } = parseCallArgs(s, after + 1);
    const callee = word.split(".").pop()!;
    if (paramSegmentCalls.has(callee)) return { cands: ["{param}"], next };
    const helper = uiPathHelpers[callee];
    if (helper) {
      const resolvedArgs = regions.map((r) =>
        r.end === r.start
          ? { cands: [""] }
          : resolveExpr(file, r.start, interp, r.end),
      );
      for (const need of helper.needs) {
        const ra = resolvedArgs[need];
        if (ra && "unresolved" in ra) {
          return {
            unresolved: `arg ${need + 1} of ${callee}: ${ra.unresolved}`,
          };
        }
      }
      return { cands: helper.make(resolvedArgs), next };
    }
    return { unresolved: `unknown call ${word}(…)` };
  }
  // Plain identifier or member chain.
  if (!word.includes(".")) {
    const constant = importedRoutePathConstants[word];
    if (constant !== undefined) return { cands: [constant], next: after };
    const local = resolveLocalConst(file, word, start, interp);
    if (local && !("unresolved" in local))
      return { cands: local.cands, next: after };
  }
  if (interp) return { cands: ["{param}"], next: after };
  return { unresolved: `identifier ${word}` };
}

/** Resolve `const NAME = <resolvable path expression>` declared before the
 *  call site (nearest preceding declaration wins — each api function
 *  declares its own locals before calling the client). */
function resolveLocalConst(
  file: UiApiFile,
  name: string,
  fromIdx: number,
  interp: boolean,
): RouteResolution | null {
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*=`, "g");
  let best = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file.src))) {
    if (m.index < fromIdx) best = m.index + m[0].length;
  }
  if (best === -1) return null;
  const resolved = resolveExpr(file, best, interp);
  if ("unresolved" in resolved) return null;
  return resolved;
}

/** Walk a template literal. Path text accumulates per branch; a literal `?` or
 *  an interpolation resolving to query text (`?…` / `&…`) marks everything
 *  after it as query, which normalization drops. Interpolations resolving to
 *  path segments (nested helpers, ternaries) expand into extra branches, so
 *  every candidate the UI could hit is checked against the spec. */
function resolveTemplate(
  file: UiApiFile,
  start: number,
  limit: number,
): RouteResolution {
  const s = file.src;
  let i = start;
  let branches: Array<{ text: string; query: boolean }> = [
    { text: "", query: false },
  ];
  let failed: RouteResolution | null = null;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") {
      for (const b of branches) if (!b.query) b.text += s[i + 1]!;
      i += 2;
      continue;
    }
    if (c === "`") {
      return failed ?? { cands: branches.map((b) => b.text), next: i + 1 };
    }
    if (c === "$" && s[i + 1] === "{") {
      const end = findTopLevel(s, i + 2, "}");
      if (branches.some((b) => !b.query)) {
        const r = resolveExpr(file, i + 2, true, end);
        if ("unresolved" in r) {
          failed = { unresolved: `interpolation: ${r.unresolved}` };
        } else {
          const next: typeof branches = [];
          for (const b of branches) {
            for (const cand of r.cands) {
              if (cand === "") next.push(b);
              else if (cand.startsWith("?") || cand.startsWith("&"))
                next.push({ text: b.text, query: true });
              else next.push({ text: b.text + cand, query: b.query });
            }
          }
          branches = next;
        }
      }
      i = end + 1;
      continue;
    }
    if (c === "?") for (const b of branches) b.query = true;
    else for (const b of branches) if (!b.query) b.text += c;
    i++;
  }
  return failed ?? { cands: branches.map((b) => b.text), next: i };
}

// ---------------------------------------------------------------------------
// Call-site scanning.

const API_METHOD_BY_CLIENT_METHOD: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  postForm: "POST",
  putRaw: "PUT",
  deleteWithBody: "DELETE",
};

function canonicalRoute(method: string, pathPattern: string): string {
  let p = pathPattern.split("?")[0]!.replace(/\/+/g, "/");
  if (!p.startsWith("/api")) p = `/api${p}`;
  return `${method} ${p.replace(/\{[^{}]*\}/g, "{param}")}`;
}

interface UiApiScan {
  /** canonical "METHOD /path" -> first provenance "file:line" */
  uiRoutes: Map<string, string>;
  unresolvedSites: string[];
}

function scanUiApiRoutes(): UiApiScan {
  const uiRoutes = new Map<string, string>();
  const unresolvedSites: string[] = [];

  const files = fs
    .readdirSync(UI_API_DIR)
    .filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "client.ts",
    )
    .sort();

  for (const file of files) {
    const entry: UiApiFile = {
      file,
      src: stripComments(fs.readFileSync(path.join(UI_API_DIR, file), "utf8")),
    };
    const lineAt = (idx: number) => entry.src.slice(0, idx).split("\n").length;

    const record = (
      method: string,
      resolution: RouteResolution,
      site: string,
    ) => {
      if ("unresolved" in resolution) {
        unresolvedSites.push(`${site} ${method} — ${resolution.unresolved}`);
        return;
      }
      for (const cand of resolution.cands) {
        const route = canonicalRoute(method, cand);
        if (!uiRoutes.has(route)) uiRoutes.set(route, site);
      }
    };

    // client.ts transport: api.get/post/… paths are relative to BASE "/api".
    const apiCall =
      /(?<![.\w])api\.(get|post|put|patch|delete|postForm|putRaw|deleteWithBody)(?:<[^()]*>)?\(/g;
    for (const m of entry.src.matchAll(apiCall)) {
      const method = API_METHOD_BY_CLIENT_METHOD[m[1]!]!;
      const argStart = skipWs(entry.src, m.index + m[0].length);
      const argEnd = findTopLevel(entry.src, argStart, ",)");
      record(
        method,
        resolveExpr(entry, argStart, false, argEnd),
        `${file}:${lineAt(m.index)}`,
      );
    }

    // Direct fetch calls carry the full "/api/…" path and an optional
    // `method:` in the init object (GET by default).
    const fetchCall = /(?<![.\w])fetch\(/g;
    for (const m of entry.src.matchAll(fetchCall)) {
      const argStart = skipWs(entry.src, m.index + m[0].length);
      const argEnd = findTopLevel(entry.src, argStart, ",)");
      const callEnd = findTopLevel(entry.src, m.index + m[0].length, ")");
      const initMethod = entry.src
        .slice(m.index, callEnd)
        .match(/method:\s*"([A-Z]+)"/);
      const method = initMethod ? initMethod[1]! : "GET";
      record(
        method,
        resolveExpr(entry, argStart, false, argEnd),
        `${file}:${lineAt(m.index)}`,
      );
    }

    // auth.ts's authPost/authPatch wrappers prepend "/api/auth" to their
    // first argument; the wrapper definitions are transports, not call sites
    // (the `(?<!function )` guard skips the declarations).
    const authWrapperCall =
      /(?<!function )\bauth(Get|Post|Patch|Put|Delete)\(/g;
    const authMethod: Record<string, string> = {
      Get: "GET",
      Post: "POST",
      Patch: "PATCH",
      Put: "PUT",
      Delete: "DELETE",
    };
    for (const m of entry.src.matchAll(authWrapperCall)) {
      const argStart = skipWs(entry.src, m.index + m[0].length);
      const argEnd = findTopLevel(entry.src, argStart, ",)");
      const resolved = resolveExpr(entry, argStart, false, argEnd);
      const site = `${file}:${lineAt(m.index)}`;
      if ("unresolved" in resolved) {
        unresolvedSites.push(`${site} auth${m[1]} — ${resolved.unresolved}`);
        continue;
      }
      for (const cand of resolved.cands) {
        const route = canonicalRoute(authMethod[m[1]!]!, `/api/auth${cand}`);
        if (!uiRoutes.has(route)) uiRoutes.set(route, site);
      }
    }
  }

  return { uiRoutes, unresolvedSites };
}

function loadCanonicalSpecRoutes(): Set<string> {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();
  for (const [routePath, pathItem] of Object.entries<Record<string, unknown>>(
    spec.paths ?? {},
  )) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(
          `${method.toUpperCase()} ${routePath.replace(/\{[^{}]*\}/g, "{param}")}`,
        );
      }
    }
  }
  return routes;
}

describe("ui openapi routes", () => {
  it("resolves every UI api client route against the generated OpenAPI spec", () => {
    const { uiRoutes, unresolvedSites } = scanUiApiRoutes();
    const specRoutes = loadCanonicalSpecRoutes();

    const missingInSpec = [...uiRoutes.entries()]
      .filter(
        ([route]) =>
          !specRoutes.has(route) && !explicitUiRouteExclusions.has(route),
      )
      .map(([route, site]) => `${route} (ui/src/api/${site})`)
      .sort();

    // Exclusions are only valid while the UI still references the route and
    // the spec still omits it; otherwise the entry is dead weight and fails.
    const unusedExclusions = [...explicitUiRouteExclusions]
      .filter(
        (exclusion) => !(uiRoutes.has(exclusion) && !specRoutes.has(exclusion)),
      )
      .sort();

    expect({ unresolvedSites, missingInSpec, unusedExclusions }).toEqual({
      unresolvedSites: [],
      missingInSpec: [],
      unusedExclusions: [],
    });
  });
});
