import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const SCAN_ROOTS = ["server/src/routes", "server/src/services"];
const EXCLUDED_DIRECTORIES = new Set(["__tests__", "coverage", "dist", "node_modules"]);
const WRITE_OPERATIONS = new Set(["delete", "insert", "update"]);
const TABLE_EXPORTS = new Set(["issues", "issueComments"]);
const HELPER_PATH = "server/src/services/issue-versioning.ts";
const HELPER_EXPORTS = new Set(["runIssueMutation", "versionedIssuePatch"]);
const IDENTITY_FIELDS = [
  "path",
  "line",
  "receiver",
  "operation",
  "table",
  "tableToken",
];
const STABLE_IDENTITY_FIELDS = IDENTITY_FIELDS.filter((field) => field !== "line");

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function sortWrites(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.table.localeCompare(right.table) ||
    left.operation.localeCompare(right.operation) ||
    left.tableToken.localeCompare(right.tableToken) ||
    left.receiver.localeCompare(right.receiver)
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").toUpperCase();
}

function project(entry, fields) {
  return Object.fromEntries(fields.map((field) => [field, entry[field]]));
}

function identity(entry) {
  return JSON.stringify(project(entry, IDENTITY_FIELDS));
}

function stableIdentity(entry) {
  return JSON.stringify(project(entry, STABLE_IDENTITY_FIELDS));
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isConstDeclaration(declaration) {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function collectAssignments(sourceFile) {
  const assigned = new Set();
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = unwrap(node.left);
      if (ts.isIdentifier(target)) assigned.add(target.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return assigned;
}

function collectTableAliases(sourceFile) {
  const aliases = new Map();
  const declarations = [];

  function collect(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@paperclipai/db"
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const exported = specifier.propertyName?.text ?? specifier.name.text;
          if (TABLE_EXPORTS.has(exported)) aliases.set(specifier.name.text, exported);
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  const assigned = collectAssignments(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !isConstDeclaration(declaration) ||
        !declaration.initializer ||
        assigned.has(declaration.name.text) ||
        aliases.has(declaration.name.text)
      ) {
        continue;
      }
      const initializer = unwrap(declaration.initializer);
      if (!ts.isIdentifier(initializer)) continue;
      const table = aliases.get(initializer.text);
      if (!table) continue;
      aliases.set(declaration.name.text, table);
      changed = true;
    }
  }
  return aliases;
}

function staticOperation(callee) {
  const expression = unwrap(callee);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function isDynamicElementAccess(callee) {
  const expression = unwrap(callee);
  return (
    ts.isElementAccessExpression(expression) &&
    !(
      expression.argumentExpression &&
      (ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
    )
  );
}

function receiverText(callee, sourceFile) {
  const expression = unwrap(callee);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const receiver = unwrap(expression.expression);
    if (ts.isIdentifier(receiver)) return receiver.text;
    if (ts.isPropertyAccessExpression(receiver)) return receiver.name.text;
    return receiver.getText(sourceFile);
  }
  return expression.getText(sourceFile);
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText();
    }
    if (
      ts.isArrowFunction(current) &&
      (ts.isVariableDeclaration(current.parent) ||
        ts.isPropertyAssignment(current.parent))
    ) {
      return current.parent.name.getText();
    }
  }
  return "<module>";
}

function nearestTransactionCallback(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const call = current.parent;
    if (
      ts.isCallExpression(call) &&
      call.arguments.includes(current) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "transaction"
    ) {
      return current;
    }
    let expression = current;
    while (
      expression.parent &&
      (ts.isParenthesizedExpression(expression.parent) ||
        ts.isAsExpression(expression.parent) ||
        ts.isNonNullExpression(expression.parent)) &&
      expression.parent.expression === expression
    ) {
      expression = expression.parent;
    }
    if (
      expression.parent &&
      ts.isCallExpression(expression.parent) &&
      expression.parent.expression === expression
    ) {
      continue;
    }
    return null;
  }
  return null;
}

function isInsideRunIssueMutation(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const property = current.parent;
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText().replace(/^["']|["']$/g, "") === "mutate" &&
      ts.isObjectLiteralExpression(property.parent)
    ) {
      const call = property.parent.parent;
      const callee = ts.isCallExpression(call) ? unwrap(call.expression) : null;
      if (callee && ts.isIdentifier(callee) && callee.text === "runIssueMutation") {
        return true;
      }
    }
  }
  return false;
}

function versionedUpdateWrapper(node) {
  if (node.arguments.length === 0) return null;
  const setProperty = node.parent;
  if (
    !ts.isPropertyAccessExpression(setProperty) ||
    setProperty.expression !== node ||
    setProperty.name.text !== "set"
  ) {
    return null;
  }
  const setCall = setProperty.parent;
  if (!ts.isCallExpression(setCall) || setCall.arguments.length !== 1) return null;
  const patch = unwrap(setCall.arguments[0]);
  return (
    ts.isCallExpression(patch) &&
    ts.isIdentifier(patch.expression) &&
    patch.expression.text === "versionedIssuePatch"
  )
    ? "versionedIssuePatch"
    : null;
}

function tableReferences(expression, aliases) {
  const references = new Set();
  function visit(node) {
    const current = unwrap(node);
    if (ts.isIdentifier(current)) {
      const table = aliases.get(current.text);
      if (table) references.add(table);
      return;
    }
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return;
    ts.forEachChild(current, visit);
  }
  visit(expression);
  return references;
}

export function collectIssueWritesFromSource(filePath, source) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const aliases = collectTableAliases(sourceFile);
  const writes = [];

  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const operation = staticOperation(node.expression);
      const argument = unwrap(node.arguments[0]);
      const directTable = ts.isIdentifier(argument) ? aliases.get(argument.text) : null;
      const references = directTable ? new Set([directTable]) : tableReferences(argument, aliases);
      const isWrite = operation ? WRITE_OPERATIONS.has(operation) : isDynamicElementAccess(node.expression);

      if (references.size > 0 && isDynamicElementAccess(node.expression)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(`dynamic issue-table write operation in ${filePath}:${line + 1}`);
      }
      if (references.size > 0 && isWrite && !directTable) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(`unsafe issue-table expression in ${filePath}:${line + 1}`);
      }
      if (directTable && operation && WRITE_OPERATIONS.has(operation)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const entry = {
          path: normalizePath(filePath),
          line: line + 1,
          receiver: receiverText(node.expression, sourceFile),
          operation,
          table: directTable,
          tableToken: argument.text,
        };
        Object.defineProperty(entry, "versionedBy", {
          value: directTable === "issues" && operation === "update"
            ? versionedUpdateWrapper(node)
            : null,
          enumerable: false,
        });
        Object.defineProperties(entry, {
          functionName: {
            value: enclosingFunctionName(node),
            enumerable: false,
          },
          insideRunIssueMutation: {
            value: isInsideRunIssueMutation(node),
            enumerable: false,
          },
          transactionCallback: {
            value: nearestTransactionCallback(node),
            enumerable: false,
          },
        });
        writes.push(entry);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return writes.sort(sortWrites);
}

function listTypeScriptFiles(repoRoot) {
  const files = [];
  for (const relativeRoot of SCAN_ROOTS) {
    const root = path.join(repoRoot, ...relativeRoot.split("/"));
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
          pending.push(absolute);
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".d.ts")
        ) {
          files.push(absolute);
        }
      }
    }
  }
  return files.sort();
}

export function collectIssueWrites(repoRoot) {
  const writes = [];
  for (const absolute of listTypeScriptFiles(repoRoot)) {
    const relative = normalizePath(path.relative(repoRoot, absolute));
    writes.push(...collectIssueWritesFromSource(relative, fs.readFileSync(absolute, "utf8")));
  }
  return writes.sort(sortWrites);
}

export function canonicalObservedDigest(entries) {
  return sha256(JSON.stringify(canonicalize([...entries].sort(sortWrites))));
}

function catalogEntryDigest(entries) {
  const projection = entries.map((entry) =>
    canonicalize({
      id: entry.id,
      ...project(entry, IDENTITY_FIELDS),
      containingFunction: entry.containingFunction,
      sourceFileSha256: entry.sourceFileSha256,
    }),
  );
  return sha256(JSON.stringify(projection));
}

function validateCatalog(catalog) {
  const errors = [];
  if (catalog?.schemaVersion !== "paperclip_issue_version_write_catalog_v2") {
    errors.push("unsupported issue-version catalog schema");
    return errors;
  }
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  if (entries.length !== 78) errors.push(`catalog entry count is ${entries.length}, expected 78`);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    errors.push("catalog entry IDs are not unique");
  }
  if (
    catalog.baseline?.acceptedEntryDigestSha256 &&
    catalogEntryDigest(entries) !== catalog.baseline.acceptedEntryDigestSha256
  ) {
    errors.push("catalog accepted-entry digest differs");
  }
  return errors;
}

function exactCatalogEntry(entry, catalog) {
  return catalog.entries.find((candidate) => identity(candidate) === identity(entry)) ?? null;
}

function stableCatalogEntry(entry, catalog) {
  const preferredCommentExport =
    entry.table === "issueComments" &&
    (entry.insideRunIssueMutation || entry.functionName === "insertIssueComment")
      ? "runIssueMutation"
      : entry.table === "issueComments" && entry.transactionCallback
        ? "versionedIssuePatch"
        : null;
  let matches = preferredCommentExport
    ? catalog.entries.filter(
        (candidate) =>
          validResolution(candidate) &&
          candidate.path === entry.path &&
          candidate.table === entry.table &&
          candidate.operation === entry.operation &&
          candidate.resolution?.export === preferredCommentExport,
      )
    : catalog.entries.filter(
        (candidate) =>
          validResolution(candidate) &&
          stableIdentity(candidate) === stableIdentity(entry),
      );
  if (
    matches.length === 0 &&
    entry.table === "issueComments" &&
    (entry.insideRunIssueMutation || entry.functionName === "insertIssueComment")
  ) {
    matches = catalog.entries.filter(
      (candidate) =>
        validResolution(candidate) &&
        candidate.path === entry.path &&
        candidate.table === entry.table &&
        candidate.operation === entry.operation &&
        candidate.resolution?.export === "runIssueMutation",
    );
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null;

  const byDistance = matches
    .map((candidate) => ({
      candidate,
      distance: Math.abs(candidate.line - entry.line),
    }))
    .sort((left, right) => left.distance - right.distance);
  return byDistance[0].distance < byDistance[1].distance
    ? byDistance[0].candidate
    : null;
}

export function validateBaseline(observed, catalog) {
  const errors = validateCatalog(catalog);
  if (!Array.isArray(observed)) errors.push("observed writes must be an array");
  return { ok: errors.length === 0, errors };
}

function validResolution(entry) {
  if (entry.classification === "versioned") {
    return (
      entry.state === "versioned" &&
      entry.resolution?.kind === "versioned_helper" &&
      entry.resolution.path === HELPER_PATH &&
      HELPER_EXPORTS.has(entry.resolution.export)
    );
  }
  if (entry.classification === "issue_created_at_version_1") {
    return (
      entry.state === "verified_create" &&
      entry.resolution?.kind === "schema_default" &&
      entry.resolution.column === "issues.version" &&
      entry.resolution.value === 1
    );
  }
  if (entry.classification === "issue_deleted_same_transaction") {
    return (
      entry.state === "exempt" &&
      entry.resolution?.kind === "same_transaction_issue_delete" &&
      entry.resolution.path === entry.path
    );
  }
  return false;
}

function helperExports(repoRoot) {
  if (!repoRoot) return new Set();
  const helperPath = path.join(repoRoot, ...HELPER_PATH.split("/"));
  if (!fs.existsSync(helperPath)) return new Set();
  const sourceFile = ts.createSourceFile(
    helperPath,
    fs.readFileSync(helperPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set();
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          names.add(declaration.name.text);
        }
      }
    }
  }
  return names;
}

export function validateStrict(observed, catalog, { table = null, repoRoot = null } = {}) {
  const errors = validateCatalog(catalog);
  const exports = helperExports(repoRoot);
  for (const entry of catalog.entries) {
    if (table && entry.table !== table) continue;
    if (!validResolution(entry)) {
      errors.push(`unresolved catalog entry: ${entry.id}`);
    } else if (
      entry.classification === "versioned" &&
      repoRoot &&
      !exports.has(entry.resolution.export)
    ) {
      errors.push(`missing helper export ${entry.resolution.export}: ${entry.id}`);
    }
  }

  for (const entry of observed) {
    if (table && entry.table !== table) continue;
    if (entry.path === HELPER_PATH && entry.table === "issues" && entry.operation === "update") {
      continue;
    }
    const catalogEntry = exactCatalogEntry(entry, catalog) ?? stableCatalogEntry(entry, catalog);
    if (!catalogEntry) {
      errors.push(`unapproved raw write: ${identity(entry)}`);
      continue;
    }
    if (catalogEntry.classification === "versioned") {
      if (entry.table === "issues") {
        if (
          entry.operation !== "update" ||
          entry.versionedBy !== catalogEntry.resolution?.export
        ) {
          errors.push(`raw write outside issue-version helper: ${catalogEntry.id}`);
        }
      } else if (entry.table === "issueComments") {
        const resolutionExport = catalogEntry.resolution?.export;
        if (resolutionExport === "runIssueMutation") {
          if (
            !entry.insideRunIssueMutation &&
            !(
              entry.path === "server/src/services/issues.ts" &&
              entry.functionName === "insertIssueComment"
            )
          ) {
            errors.push(`comment write is outside runIssueMutation: ${catalogEntry.id}`);
          }
        } else if (resolutionExport === "versionedIssuePatch") {
          const hasPairedParentUpdate = entry.transactionCallback && observed.some(
            (candidate) =>
              candidate.table === "issues" &&
              candidate.operation === "update" &&
              candidate.versionedBy === "versionedIssuePatch" &&
              candidate.transactionCallback === entry.transactionCallback,
          );
          if (!hasPairedParentUpdate) {
            errors.push(`comment write lacks same-transaction parent version: ${catalogEntry.id}`);
          }
        } else {
          errors.push(`unsupported comment write resolution: ${catalogEntry.id}`);
        }
      }
    } else if (
      catalogEntry.classification !== "issue_created_at_version_1" &&
      catalogEntry.classification !== "issue_deleted_same_transaction"
    ) {
      errors.push(`raw write outside issue-version helper: ${catalogEntry.id}`);
    } else if (!validResolution(catalogEntry)) {
      errors.push(`unresolved raw write: ${catalogEntry.id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function catalogPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "issue-version-write-catalog.json");
}

function parseArgs(args) {
  const options = { mode: null, table: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--verify-baseline" || argument === "--strict") {
      if (options.mode) throw new Error("Use exactly one mode");
      options.mode = argument;
    } else if (argument === "--table") {
      options.table = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.mode) throw new Error("Use --verify-baseline or --strict");
  if (options.table && !TABLE_EXPORTS.has(options.table)) {
    throw new Error("--table accepted values: issues, issueComments");
  }
  if (options.table && options.mode !== "--strict") {
    throw new Error("--table is only valid with --strict");
  }
  return options;
}

function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const catalog = JSON.parse(fs.readFileSync(catalogPath(), "utf8"));
  const observed = collectIssueWrites(repoRoot);
  const result = validateStrict(observed, catalog, {
    table: options.mode === "--strict" ? options.table : null,
    repoRoot,
  });
  console.log(
    JSON.stringify({
      issueWrites: observed.filter((entry) => entry.table === "issues").length,
      commentWrites: observed.filter((entry) => entry.table === "issueComments").length,
      totalWrites: observed.length,
      observedDigestSha256: canonicalObservedDigest(observed),
    }),
  );
  if (!result.ok) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
