import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const SCAN_ROOTS = [
  "server/src/routes",
  "server/src/services",
  "cli/src/commands",
  "packages/db/src",
];
const EXCLUDED_DIRECTORIES = new Set(["__tests__", "coverage", "dist", "node_modules"]);
const WRITE_OPERATIONS = new Set(["delete", "insert", "update"]);
const TABLE_EXPORTS = new Set(["issues", "issueComments"]);
const TABLE_IMPORT_MODULES = new Set([
  "@paperclipai/db",
  "./schema/index.js",
  "./schema/issues.js",
  "./schema/issue_comments.js",
]);
const HELPER_PATHS = new Map([
  ["runIssueMutation", new Set(["server/src/services/issue-versioning.ts"])],
  [
    "versionedIssuePatch",
    new Set([
      "server/src/services/issue-versioning.ts",
      "packages/db/src/issue-versioning.ts",
    ]),
  ],
]);
const INTERNAL_HELPER_PATHS = new Set(
  [...HELPER_PATHS.values()].flatMap((paths) => [...paths]),
);
const HELPER_EXPORTS = new Set(["runIssueMutation", "versionedIssuePatch"]);
const TRUSTED_HELPER_SPECS = [
  {
    path: "packages/db/src/issue-versioning.ts",
    export: "versionedIssuePatch",
    kind: "implementation",
  },
  {
    path: "server/src/services/issue-versioning.ts",
    export: "versionedIssuePatch",
    kind: "reexport",
    module: "@paperclipai/db",
  },
  {
    path: "server/src/services/issue-versioning.ts",
    export: "runIssueMutation",
    kind: "implementation",
  },
];
const IDENTITY_FIELDS = [
  "path",
  "line",
  "receiver",
  "operation",
  "table",
  "tableToken",
];
const STABLE_IDENTITY_FIELDS = IDENTITY_FIELDS.filter((field) => field !== "line");
const NON_GOVERNED_IMPORT = Object.freeze({ kind: "non_governed" });
const UNRESOLVED_IMPORT = Object.freeze({ kind: "unresolved" });

function tableImport(table) {
  return { kind: "table", table };
}

function namespaceImport(resolveExport) {
  return { kind: "namespace", resolveExport };
}

function helperImport(helper, helperPath) {
  return { kind: "helper", helper, helperPath };
}

function directImportResolution(moduleSpecifier, exportName) {
  if (TABLE_IMPORT_MODULES.has(moduleSpecifier) && TABLE_EXPORTS.has(exportName)) {
    return tableImport(exportName);
  }
  if (moduleSpecifier === "@paperclipai/db" && exportName === "versionedIssuePatch") {
    return helperImport(exportName, "packages/db/src/issue-versioning.ts");
  }
  return NON_GOVERNED_IMPORT;
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function resolveTypeScriptModule(repoRoot, importerPath, moduleSpecifier) {
  const importer = path.join(repoRoot, ...normalizePath(importerPath).split("/"));
  const unresolved = path.resolve(path.dirname(importer), moduleSpecifier);
  const extension = path.extname(unresolved);
  const withoutExtension = extension ? unresolved.slice(0, -extension.length) : unresolved;
  const candidates = extension
    ? [`${withoutExtension}.ts`, `${withoutExtension}.tsx`]
    : [`${unresolved}.ts`, `${unresolved}.tsx`, path.join(unresolved, "index.ts")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function createTableImportResolver(repoRoot) {
  const cache = new Map();

  function resolve(importerPath, moduleSpecifier, exportName, resolving = new Set()) {
    if (TABLE_IMPORT_MODULES.has(moduleSpecifier)) {
      return directImportResolution(moduleSpecifier, exportName);
    }
    if (!moduleSpecifier.startsWith(".")) return NON_GOVERNED_IMPORT;

    const absolute = resolveTypeScriptModule(repoRoot, importerPath, moduleSpecifier);
    if (!absolute) return UNRESOLVED_IMPORT;
    const targetPath = normalizePath(path.relative(repoRoot, absolute));
    const cacheKey = `${targetPath}\0${exportName}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (resolving.has(cacheKey)) return UNRESOLVED_IMPORT;
    resolving.add(cacheKey);

    const sourceFile = ts.createSourceFile(
      targetPath,
      fs.readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const importedBindings = new Map();
    const importedNamespaces = new Map();
    const localBindings = new Map();
    const assigned = collectAssignments(sourceFile);

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const specifier of bindings.elements) {
            importedBindings.set(specifier.name.text, {
              moduleSpecifier: statement.moduleSpecifier.text,
              exportName: specifier.propertyName?.text ?? specifier.name.text,
            });
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          importedNamespaces.set(bindings.name.text, statement.moduleSpecifier.text);
        }
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            isConstDeclaration(declaration) &&
            declaration.initializer &&
            !assigned.has(declaration.name.text)
          ) {
            localBindings.set(declaration.name.text, declaration.initializer);
          }
        }
      }
    }

    function resolveBinding(bindingName, bindingStack = new Set()) {
      if (bindingStack.has(bindingName)) return UNRESOLVED_IMPORT;
      bindingStack.add(bindingName);

      const imported = importedBindings.get(bindingName);
      if (imported) {
        const result = resolve(
          targetPath,
          imported.moduleSpecifier,
          imported.exportName,
          resolving,
        );
        bindingStack.delete(bindingName);
        return result;
      }
      const namespaceModule = importedNamespaces.get(bindingName);
      if (namespaceModule) {
        bindingStack.delete(bindingName);
        return namespaceImport((nestedExport, nestedResolving = new Set()) =>
          resolve(targetPath, namespaceModule, nestedExport, nestedResolving));
      }
      const localInitializer = localBindings.get(bindingName);
      if (localInitializer) {
        const result = resolveExpression(localInitializer, bindingStack);
        bindingStack.delete(bindingName);
        return result;
      }
      bindingStack.delete(bindingName);
      return UNRESOLVED_IMPORT;
    }

    function resolveExpression(expression, bindingStack = new Set()) {
      const current = unwrap(expression);
      if (ts.isIdentifier(current)) {
        return resolveBinding(current.text, bindingStack);
      }
      if (ts.isPropertyAccessExpression(current)) {
        const base = resolveExpression(current.expression, bindingStack);
        if (base.kind === "namespace") {
          return base.resolveExport(current.name.text, resolving);
        }
        return base.kind === "unresolved" ? base : NON_GOVERNED_IMPORT;
      }
      if (
        ts.isElementAccessExpression(current) &&
        current.argumentExpression &&
        (ts.isStringLiteral(current.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
      ) {
        const base = resolveExpression(current.expression, bindingStack);
        if (base.kind === "namespace") {
          return base.resolveExport(current.argumentExpression.text, resolving);
        }
        return base.kind === "unresolved" ? base : NON_GOVERNED_IMPORT;
      }
      return UNRESOLVED_IMPORT;
    }

    let result = UNRESOLVED_IMPORT;
    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement)) {
        const moduleName = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
        if (!statement.exportClause && moduleName) {
          const candidate = resolve(targetPath, moduleName, exportName, resolving);
          if (candidate.kind === "table" || candidate.kind === "namespace") {
            result = candidate;
            break;
          }
          if (candidate.kind === "non_governed") result = candidate;
        } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const specifier = statement.exportClause.elements.find(
            (candidate) => candidate.name.text === exportName,
          );
          if (specifier) {
            if (HELPER_PATHS.get(exportName)?.has(targetPath)) {
              result = helperImport(exportName, targetPath);
              break;
            }
            const sourceName = specifier.propertyName?.text ?? specifier.name.text;
            result = moduleName
              ? resolve(targetPath, moduleName, sourceName, resolving)
              : resolveBinding(sourceName);
            break;
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
        if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const declaration = statement.declarationList.declarations.find(
          (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === exportName,
        );
        if (declaration?.initializer) {
          result = resolveExpression(declaration.initializer);
          break;
        }
      } else if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === exportName
      ) {
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
        if (
          modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
          HELPER_PATHS.get(exportName)?.has(targetPath)
        ) {
          result = helperImport(exportName, targetPath);
          break;
        }
        if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          result = NON_GOVERNED_IMPORT;
          break;
        }
      }
    }

    resolving.delete(cacheKey);
    cache.set(cacheKey, result);
    return result;
  }

  return resolve;
}

function createSourceModuleResolver(repoRoot) {
  return (importerPath, moduleSpecifier) => {
    if (!moduleSpecifier.startsWith(".")) return null;
    const absolute = resolveTypeScriptModule(repoRoot, importerPath, moduleSpecifier);
    if (!absolute) return null;
    const relative = normalizePath(path.relative(repoRoot, absolute));
    if (
      path.isAbsolute(relative) ||
      relative.startsWith("../") ||
      !SCAN_ROOTS.some((root) => relative === root || relative.startsWith(`${root}/`))
    ) {
      return null;
    }
    return {
      path: relative,
      source: fs.readFileSync(absolute, "utf8"),
    };
  };
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

export function canonicalSourceText(value) {
  return value.replace(/\r\n?/g, "\n");
}

export function canonicalSourceSha256(value) {
  return sha256(canonicalSourceText(value));
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

function compoundTableAliasEvidence(
  expression,
  aliases,
  namespaces,
  helperAliases,
  unresolvedAliases,
  lexicalBindings,
) {
  const current = unwrap(expression);
  const branches = ts.isConditionalExpression(current)
    ? [current.whenTrue, current.whenFalse]
    : (
    ts.isBinaryExpression(current) &&
    (current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      current.operatorToken.kind === ts.SyntaxKind.CommaToken)
      ? [current.left, current.right]
      : null
    );
  if (branches) {
    const evidence = { tables: new Set(), unresolved: false };
    for (const branch of branches) {
      const nested = compoundTableAliasEvidence(
        branch,
        aliases,
        namespaces,
        helperAliases,
        unresolvedAliases,
        lexicalBindings,
      );
      for (const table of nested.tables) evidence.tables.add(table);
      evidence.unresolved ||= nested.unresolved;
    }
    return evidence;
  }
  if (
    ts.isArrayLiteralExpression(current) ||
    ts.isObjectLiteralExpression(current) ||
    ts.isFunctionLike(current)
  ) {
    const evidence = { tables: new Set(), unresolved: false };
    const children = [];
    if (ts.isArrayLiteralExpression(current)) {
      children.push(...current.elements);
    } else if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isPropertyAssignment(property)) {
          children.push(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          children.push(property.name);
          if (property.objectAssignmentInitializer) {
            children.push(property.objectAssignmentInitializer);
          }
        } else if (ts.isSpreadAssignment(property)) {
          children.push(property.expression);
        } else if (ts.isMethodDeclaration(property)) {
          children.push(property);
        } else if (
          (ts.isGetAccessorDeclaration(property) ||
            ts.isSetAccessorDeclaration(property)) &&
          property.body
        ) {
          children.push(property);
        }
      }
    } else if (current.body && !ts.isBlock(current.body)) {
      children.push(current.body);
    } else if (current.body) {
      function collectReturns(node) {
        if (node !== current && ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression) {
          children.push(node.expression);
          return;
        }
        ts.forEachChild(node, collectReturns);
      }
      collectReturns(current.body);
    }
    for (const child of children) {
      const nested = compoundTableAliasEvidence(
        child,
        aliases,
        namespaces,
        helperAliases,
        unresolvedAliases,
        lexicalBindings,
      );
      for (const table of nested.tables) evidence.tables.add(table);
      evidence.unresolved ||= nested.unresolved;
    }
    return evidence;
  }
  const resolution = resolveTableReference(
    current,
    aliases,
    namespaces,
    unresolvedAliases,
    helperAliases,
    lexicalBindings,
  );
  return {
    tables:
      resolution.kind === "table"
        ? new Set([resolution.table])
        : new Set(),
    unresolved: resolution.kind === "unresolved",
  };
}

function isConstDeclaration(declaration) {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function createLexicalBindings(sourceFile) {
  const declarationsByName = new Map();
  const resolutions = new Map();

  function nearestScope(node, blockScoped) {
    for (let current = node.parent; current; current = current.parent) {
      if (
        blockScoped &&
        (ts.isBlock(current) ||
          ts.isCaseBlock(current) ||
          ts.isForStatement(current) ||
          ts.isForInStatement(current) ||
          ts.isForOfStatement(current))
      ) {
        return current;
      }
      if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current;
    }
    return sourceFile;
  }

  function addIdentifier(identifier, scope) {
    const declarations = declarationsByName.get(identifier.text) ?? [];
    declarations.push({ identifier, scope });
    declarationsByName.set(identifier.text, declarations);
  }

  function addBindingName(name, scope) {
    if (ts.isIdentifier(name)) {
      addIdentifier(name, scope);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addBindingName(element.name, scope);
    }
  }

  function collect(node) {
    if (ts.isImportClause(node) && node.name) {
      addIdentifier(node.name, sourceFile);
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      addIdentifier(node.name, sourceFile);
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isCatchClause(node.parent)) {
        addBindingName(node.name, node.parent.block);
        ts.forEachChild(node, collect);
        return;
      }
      const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : null;
      const blockScoped =
        declarationList !== null &&
        (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      addBindingName(node.name, nearestScope(node, blockScoped));
    } else if (ts.isParameter(node)) {
      addBindingName(node.name, nearestScope(node, false));
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addIdentifier(node.name, nearestScope(node, true));
    } else if (ts.isFunctionExpression(node) && node.name) {
      addIdentifier(node.name, node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addIdentifier(node.name, nearestScope(node, true));
    } else if (ts.isClassExpression(node) && node.name) {
      addIdentifier(node.name, node);
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  function declarationFor(identifier) {
    const candidates = declarationsByName.get(identifier.text) ?? [];
    let selected = null;
    let ambiguous = false;
    for (const candidate of candidates) {
      if (
        identifier.pos < candidate.scope.pos ||
        identifier.end > candidate.scope.end
      ) {
        continue;
      }
      const span = candidate.scope.end - candidate.scope.pos;
      if (!selected || span < selected.span) {
        selected = { ...candidate, span };
        ambiguous = false;
      } else if (span === selected.span && candidate.identifier !== selected.identifier) {
        ambiguous = true;
      }
    }
    return ambiguous ? null : selected?.identifier ?? null;
  }

  return { declarationFor, resolutions };
}

function assignmentTargetIdentifiers(target) {
  const identifiers = [];

  function collect(node) {
    const current = unwrap(node);
    if (ts.isIdentifier(current)) {
      identifiers.push(current);
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (ts.isOmittedExpression(element)) continue;
        collect(ts.isSpreadElement(element) ? element.expression : element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isPropertyAssignment(property)) {
          collect(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          collect(property.name);
        } else if (ts.isSpreadAssignment(property)) {
          collect(property.expression);
        }
      }
      return;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      collect(current.left);
    }
  }

  collect(target);
  return identifiers;
}

function assignmentStorageTargets(target) {
  const targets = [];

  function collect(node) {
    const current = unwrap(node);
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      targets.push(current);
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (ts.isOmittedExpression(element)) continue;
        collect(ts.isSpreadElement(element) ? element.expression : element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isPropertyAssignment(property)) {
          collect(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          collect(property.name);
        } else if (ts.isSpreadAssignment(property)) {
          collect(property.expression);
        }
      }
      return;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      collect(current.left);
    }
  }

  collect(target);
  return targets;
}

function immutableStorageKey(expression, lexicalBindings) {
  const current = unwrap(expression);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current) ||
    ts.isNumericLiteral(current)
  ) {
    return current.text;
  }
  if (!ts.isIdentifier(current)) return null;
  const binding = lexicalBindings?.declarationFor(current);
  const declaration = binding?.parent;
  if (
    !binding ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.name !== binding ||
    !isConstDeclaration(declaration) ||
    lexicalBindings?.assigned?.has(binding) ||
    !declaration.initializer
  ) {
    return null;
  }
  const initializer = unwrap(declaration.initializer);
  return (
    ts.isStringLiteral(initializer) ||
    ts.isNoSubstitutionTemplateLiteral(initializer) ||
    ts.isNumericLiteral(initializer)
  )
    ? initializer.text
    : null;
}

function storageExpressionPath(expression, lexicalBindings, resolving = new Set()) {
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) {
    const binding = lexicalBindings?.declarationFor(current);
    if (!binding) return { root: `unbound:${current.text}`, segments: [] };
    if (resolving.has(binding)) return null;
    const declaration = binding.parent;
    if (ts.isVariableDeclaration(declaration) && declaration.name === binding) {
      if (
        !isConstDeclaration(declaration) ||
        lexicalBindings?.assigned?.has(binding)
      ) {
        return null;
      }
      const initializer = declaration.initializer && unwrap(declaration.initializer);
      if (
        initializer &&
        (
          ts.isIdentifier(initializer) ||
          ts.isPropertyAccessExpression(initializer) ||
          ts.isElementAccessExpression(initializer)
        )
      ) {
        resolving.add(binding);
        const alias = storageExpressionPath(initializer, lexicalBindings, resolving);
        resolving.delete(binding);
        if (alias) return alias;
        return null;
      }
    }
    return { root: `binding:${binding.pos}:${binding.end}`, segments: [] };
  }
  if (current.kind === ts.SyntaxKind.ThisKeyword) {
    return { root: "this", segments: [] };
  }
  if (ts.isPropertyAccessExpression(current)) {
    const receiver = storageExpressionPath(
      current.expression,
      lexicalBindings,
      resolving,
    );
    return receiver
      ? { root: receiver.root, segments: [...receiver.segments, current.name.text] }
      : null;
  }
  if (ts.isElementAccessExpression(current)) {
    const receiver = storageExpressionPath(
      current.expression,
      lexicalBindings,
      resolving,
    );
    if (!receiver) return null;
    const key = current.argumentExpression
      ? immutableStorageKey(current.argumentExpression, lexicalBindings)
      : null;
    return {
      root: receiver.root,
      segments: [...receiver.segments, key ?? null],
    };
  }
  return null;
}

function storageExpressionKey(expression, lexicalBindings) {
  const storagePath = storageExpressionPath(expression, lexicalBindings);
  return storagePath
    ? JSON.stringify([storagePath.root, ...storagePath.segments])
    : null;
}

function staticStorageTarget(expression, lexicalBindings) {
  const current = unwrap(expression);
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
    return null;
  }
  return storageExpressionKey(current, lexicalBindings);
}

function governedStorageResolution(expression, lexicalBindings) {
  const current = unwrap(expression);
  const exact = staticStorageTarget(current, lexicalBindings);
  const stored = exact && lexicalBindings?.governedStorage?.get(exact);
  if (stored) return stored;
  const candidate = storageExpressionPath(current, lexicalBindings);
  if (candidate) {
    for (const [key, resolution] of lexicalBindings?.governedStorage ?? []) {
      const [root, ...segments] = JSON.parse(key);
      if (
        root === candidate.root &&
        segments.includes(null) &&
        segments.length <= candidate.segments.length &&
        segments.every((segment, index) =>
          segment === null || segment === candidate.segments[index])
      ) {
        return resolution;
      }
    }
  }
  return lexicalBindings?.unknownGovernedStorage ?? null;
}

function collectAssignments(sourceFile, lexicalBindings = null) {
  const assigned = new Set();
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      for (const target of assignmentTargetIdentifiers(node.left)) {
        assigned.add(lexicalBindings?.declarationFor(target) ?? target.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return assigned;
}

function collectTableAliases(sourceFile, filePath, resolveNamedImport = null) {
  const aliases = new Map();
  const namespaces = new Map();
  const helperAliases = new Map();
  const unresolvedAliases = new Map();
  const declarations = [];
  const functionAliases = [];
  const assignments = [];
  const localFunctions = new Map();
  const calls = [];
  const lexicalBindings = createLexicalBindings(sourceFile);
  lexicalBindings.governedStorage = new Map();
  lexicalBindings.unknownGovernedStorage = null;

  function registerLocalImport(
    localName,
    resolution,
    errorMessage,
    bindingIdentifier = null,
  ) {
    const storedResolution = resolution.kind === "unresolved"
      ? { ...resolution, message: resolution.message ?? errorMessage }
      : resolution;
    if (
      !["table", "namespace", "helper", "unresolved"].includes(storedResolution.kind)
    ) {
      return false;
    }
    let changed = false;
    if (bindingIdentifier && !lexicalBindings.resolutions.has(bindingIdentifier)) {
      lexicalBindings.resolutions.set(bindingIdentifier, storedResolution);
      changed = true;
    }
    if (resolution.kind === "table") {
      if (!aliases.has(localName)) {
        aliases.set(localName, resolution.table);
        changed = true;
      }
    } else if (resolution.kind === "namespace") {
      if (!namespaces.has(localName)) {
        namespaces.set(localName, resolution);
        changed = true;
      }
    } else if (resolution.kind === "helper") {
      if (!helperAliases.has(localName)) {
        helperAliases.set(localName, resolution);
        changed = true;
      }
    } else if (resolution.kind === "unresolved") {
      if (!unresolvedAliases.has(localName)) {
        unresolvedAliases.set(localName, storedResolution.message);
        changed = true;
      }
    }
    return changed;
  }

  function markUnsafeBinding(bindingIdentifier, localName) {
    const message = `unsafe issue-table alias ${localName} in ${filePath}`;
    const existing = lexicalBindings.resolutions.get(bindingIdentifier);
    if (existing?.kind === "unresolved" && existing.message === message) return false;
    lexicalBindings.resolutions.set(bindingIdentifier, {
      ...UNRESOLVED_IMPORT,
      message,
    });
    if (!unresolvedAliases.has(localName)) unresolvedAliases.set(localName, message);
    return true;
  }

  function sameResolution(left, right) {
    if (left === right) return true;
    if (left.kind !== right.kind) return false;
    if (left.kind === "table") return left.table === right.table;
    if (left.kind === "helper") {
      return left.helper === right.helper && left.helperPath === right.helperPath;
    }
    if (left.kind === "unresolved") return left.message === right.message;
    return false;
  }

  function registerParameterResolution(bindingIdentifier, resolution) {
    if (resolution.kind === "non_governed") return false;
    const existing = lexicalBindings.resolutions.get(bindingIdentifier);
    if (!existing) {
      return registerLocalImport(
        bindingIdentifier.text,
        resolution,
        resolution.message ??
          `cannot resolve issue-table argument for parameter ${bindingIdentifier.text}`,
        bindingIdentifier,
      );
    }
    if (sameResolution(existing, resolution)) return false;
    return markUnsafeBinding(bindingIdentifier, bindingIdentifier.text);
  }

  function bindingIdentifiers(name) {
    if (ts.isIdentifier(name)) return [name];
    const identifiers = [];
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        identifiers.push(...bindingIdentifiers(element.name));
      }
    }
    return identifiers;
  }

  function collect(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (TABLE_IMPORT_MODULES.has(moduleSpecifier)) {
          registerLocalImport(
            bindings.name.text,
            namespaceImport((exported) =>
              directImportResolution(moduleSpecifier, exported)),
            `cannot resolve issue-table namespace import from ${moduleSpecifier}`,
            bindings.name,
          );
        } else if (resolveNamedImport && moduleSpecifier.startsWith(".")) {
          registerLocalImport(
            bindings.name.text,
            namespaceImport((exported) => {
              const resolution = resolveNamedImport(filePath, moduleSpecifier, exported);
              if (resolution.kind === "unresolved") {
                return {
                  ...resolution,
                  message:
                    `cannot resolve local issue-table namespace import ${exported} ` +
                    `from ${moduleSpecifier} in ${filePath}`,
                };
              }
              return resolution;
            }),
            `cannot resolve local issue-table namespace import from ${moduleSpecifier}`,
            bindings.name,
          );
        }
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const exported = specifier.propertyName?.text ?? specifier.name.text;
          if (TABLE_IMPORT_MODULES.has(moduleSpecifier)) {
            registerLocalImport(
              specifier.name.text,
              directImportResolution(moduleSpecifier, exported),
              `cannot resolve issue-table import ${exported} from ${moduleSpecifier}`,
              specifier.name,
            );
            continue;
          }
          if (!resolveNamedImport || !moduleSpecifier.startsWith(".")) continue;
          registerLocalImport(
            specifier.name.text,
            resolveNamedImport(filePath, moduleSpecifier, exported),
            `cannot resolve local issue-table import ${exported} from ${moduleSpecifier} in ${filePath}`,
            specifier.name,
          );
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      const initializer = node.initializer ? unwrap(node.initializer) : null;
      if (
        ts.isIdentifier(node.name) &&
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ) {
        localFunctions.set(node.name, initializer);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functionAliases.push(node);
      localFunctions.set(node.name, node);
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      assignments.push(node);
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);
  lexicalBindings.localFunctions = localFunctions;

  const localParameterBindings = new Set(
    [...localFunctions.values()].flatMap((localFunction) =>
      localFunction.parameters.flatMap((parameter) =>
        bindingIdentifiers(parameter.name))),
  );
  const writeTargetParameterBindings = new Set();
  for (const call of calls) {
    const operation = staticOperation(call.expression);
    if (!operation || !WRITE_OPERATIONS.has(operation) || call.arguments.length === 0) {
      continue;
    }
    const target = unwrap(call.arguments[0]);
    if (!ts.isIdentifier(target)) continue;
    const binding = lexicalBindings.declarationFor(target);
    if (binding && localParameterBindings.has(binding)) {
      writeTargetParameterBindings.add(binding);
    }
  }

  let forwardingChanged = true;
  while (forwardingChanged) {
    forwardingChanged = false;
    for (const call of calls) {
      const callee = unwrap(call.expression);
      if (!ts.isIdentifier(callee)) continue;
      const functionBinding = lexicalBindings.declarationFor(callee);
      const localFunction = functionBinding ? localFunctions.get(functionBinding) : null;
      if (!localFunction) continue;
      for (
        let index = 0;
        index < localFunction.parameters.length && index < call.arguments.length;
        index += 1
      ) {
        const parameter = localFunction.parameters[index];
        if (
          !bindingIdentifiers(parameter.name).some((binding) =>
            writeTargetParameterBindings.has(binding))
        ) {
          continue;
        }
        const argument = unwrap(call.arguments[index]);
        if (!ts.isIdentifier(argument)) continue;
        const argumentBinding = lexicalBindings.declarationFor(argument);
        if (
          argumentBinding &&
          localParameterBindings.has(argumentBinding) &&
          !writeTargetParameterBindings.has(argumentBinding)
        ) {
          writeTargetParameterBindings.add(argumentBinding);
          forwardingChanged = true;
        }
      }
    }
  }

  const assigned = collectAssignments(sourceFile, lexicalBindings);
  lexicalBindings.assigned = assigned;
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      if (!isConstDeclaration(declaration) || assigned.has(declaration.name)) {
        if (
          ts.isIdentifier(declaration.name)
        ) {
          const evidence = compoundTableAliasEvidence(
            declaration.initializer,
            aliases,
            namespaces,
            helperAliases,
            unresolvedAliases,
            lexicalBindings,
          );
          if (evidence.tables.size > 0 || evidence.unresolved) {
            changed =
              markUnsafeBinding(declaration.name, declaration.name.text) || changed;
          }
        }
        continue;
      }
      if (
        ts.isIdentifier(declaration.name) &&
        lexicalBindings.resolutions.has(declaration.name)
      ) {
        continue;
      }
      if (ts.isObjectBindingPattern(declaration.name)) {
        const base = resolveTableReference(
          declaration.initializer,
          aliases,
          namespaces,
          unresolvedAliases,
          helperAliases,
          lexicalBindings,
        );
        for (const element of declaration.name.elements) {
          if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
          const propertyName = element.propertyName
            ? ts.isIdentifier(element.propertyName) ||
              ts.isStringLiteral(element.propertyName) ||
              ts.isNumericLiteral(element.propertyName)
              ? element.propertyName.text
              : null
            : element.name.text;
          const resolution = base.kind === "namespace" && propertyName
            ? base.resolveExport(propertyName)
            : base.kind === "unresolved"
              ? base
              : NON_GOVERNED_IMPORT;
          if (
            registerLocalImport(
              element.name.text,
              resolution,
              resolution.message ??
                `cannot resolve local issue-table import ${propertyName ?? element.name.text}`,
              element.name,
            )
          ) {
            changed = true;
          }
        }
        continue;
      }
      if (ts.isArrayBindingPattern(declaration.name)) {
        const evidence = compoundTableAliasEvidence(
          declaration.initializer,
          aliases,
          namespaces,
          helperAliases,
          unresolvedAliases,
          lexicalBindings,
        );
        if (evidence.tables.size > 0 || evidence.unresolved) {
          for (const element of declaration.name.elements) {
            if (
              ts.isBindingElement(element) &&
              ts.isIdentifier(element.name) &&
              !lexicalBindings.resolutions.has(element.name)
            ) {
              changed = markUnsafeBinding(element.name, element.name.text) || changed;
            }
          }
        }
        continue;
      }
      if (!ts.isIdentifier(declaration.name)) continue;
      const resolution = resolveTableReference(
        declaration.initializer,
        aliases,
        namespaces,
        unresolvedAliases,
        helperAliases,
        lexicalBindings,
      );
      if (resolution.kind === "unresolved" && resolution.unsafeGovernedMember) {
        changed = markUnsafeBinding(declaration.name, declaration.name.text) || changed;
        continue;
      }
      if (resolution.kind === "non_governed") {
        const evidence = compoundTableAliasEvidence(
          declaration.initializer,
          aliases,
          namespaces,
          helperAliases,
          unresolvedAliases,
          lexicalBindings,
        );
        if (evidence.tables.size > 0 || evidence.unresolved) {
          changed =
            markUnsafeBinding(declaration.name, declaration.name.text) || changed;
          continue;
        }
      }
      if (
        registerLocalImport(
          declaration.name.text,
          resolution,
          resolution.message ?? `cannot resolve local issue-table import ${declaration.name.text}`,
          declaration.name,
        )
      ) {
        changed = true;
      }
    }
    for (const declaration of functionAliases) {
      if (lexicalBindings.resolutions.has(declaration.name)) continue;
      const returns = directFunctionReturns(declaration);
      if (returns.length === 1) {
        const returnResolution = resolveTableReference(
          returns[0],
          aliases,
          namespaces,
          unresolvedAliases,
          helperAliases,
          lexicalBindings,
        );
        if (returnResolution.kind === "unresolved" && returnResolution.message) {
          changed =
            registerLocalImport(
              declaration.name.text,
              returnResolution,
              returnResolution.message,
              declaration.name,
            ) || changed;
          continue;
        }
      }
      const evidence = compoundTableAliasEvidence(
        declaration,
        aliases,
        namespaces,
        helperAliases,
        unresolvedAliases,
        lexicalBindings,
      );
      if (evidence.tables.size > 0 || evidence.unresolved) {
        changed = markUnsafeBinding(declaration.name, declaration.name.text) || changed;
      }
    }
    for (const assignment of assignments) {
      const assignmentTarget = unwrap(assignment.left);
      if (ts.isObjectLiteralExpression(assignmentTarget)) {
        const base = resolveTableReference(
          assignment.right,
          aliases,
          namespaces,
          unresolvedAliases,
          helperAliases,
          lexicalBindings,
        );
        if (base.kind === "namespace" || base.kind === "unresolved") {
          for (const property of assignmentTarget.properties) {
            if (ts.isPropertyAssignment(property)) {
              const targets = assignmentTargetIdentifiers(property.initializer);
              const propertyName =
                !ts.isComputedPropertyName(property.name) &&
                (ts.isIdentifier(property.name) ||
                  ts.isStringLiteral(property.name) ||
                  ts.isNumericLiteral(property.name))
                  ? property.name.text
                  : null;
              for (const target of targets) {
                const binding = lexicalBindings.declarationFor(target);
                if (!binding) continue;
                if (propertyName && base.kind === "namespace") {
                  const resolution = base.resolveExport(propertyName);
                  changed =
                    registerLocalImport(
                      target.text,
                      resolution,
                      resolution.message ??
                        `cannot resolve local issue-table import ${propertyName}`,
                      binding,
                    ) || changed;
                } else {
                  changed = markUnsafeBinding(binding, target.text) || changed;
                }
              }
            } else if (ts.isSpreadAssignment(property)) {
              for (const target of assignmentTargetIdentifiers(property.expression)) {
                const binding = lexicalBindings.declarationFor(target);
                if (binding) changed = markUnsafeBinding(binding, target.text) || changed;
              }
            }
          }
          continue;
        }
      }
      const evidence = compoundTableAliasEvidence(
        assignment.right,
        aliases,
        namespaces,
        helperAliases,
        unresolvedAliases,
        lexicalBindings,
      );
      if (evidence.tables.size > 0 || evidence.unresolved) {
        const storageTargets = assignmentStorageTargets(assignment.left);
        for (const target of storageTargets) {
          const storageTarget = staticStorageTarget(target, lexicalBindings);
          if (storageTarget && !lexicalBindings.governedStorage.has(storageTarget)) {
            lexicalBindings.governedStorage.set(storageTarget, {
              ...UNRESOLVED_IMPORT,
              message: `unsafe issue-table alias ${target.getText(sourceFile)} in ${filePath}`,
            });
            changed = true;
          } else if (!storageTarget && !lexicalBindings.unknownGovernedStorage) {
            lexicalBindings.unknownGovernedStorage = {
              ...UNRESOLVED_IMPORT,
              message: `unsafe issue-table alias ${target.getText(sourceFile)} in ${filePath}`,
            };
            changed = true;
          }
        }
        const identifierTargets = assignmentTargetIdentifiers(assignment.left);
        for (const target of identifierTargets) {
          const binding = lexicalBindings.declarationFor(target);
          if (binding) {
            changed = markUnsafeBinding(binding, target.text) || changed;
          }
        }
        if (
          storageTargets.length === 0 &&
          identifierTargets.length === 0 &&
          !lexicalBindings.unknownGovernedStorage
        ) {
          lexicalBindings.unknownGovernedStorage = {
            ...UNRESOLVED_IMPORT,
            message: `unsafe issue-table alias ${assignment.left.getText(sourceFile)} in ${filePath}`,
          };
          changed = true;
        }
      }
    }
    for (const call of calls) {
      const callee = unwrap(call.expression);
      if (!ts.isIdentifier(callee)) continue;
      const functionBinding = lexicalBindings.declarationFor(callee);
      const localFunction = functionBinding
        ? localFunctions.get(functionBinding)
        : null;
      if (!localFunction) continue;
      for (
        let index = 0;
        index < localFunction.parameters.length && index < call.arguments.length;
        index += 1
      ) {
        const parameter = localFunction.parameters[index];
        const argument = call.arguments[index];
        const parameterBindings = bindingIdentifiers(parameter.name).filter((binding) =>
          writeTargetParameterBindings.has(binding));
        if (parameterBindings.length === 0) continue;
        if (ts.isIdentifier(parameter.name)) {
          const resolution = resolveTableReference(
            argument,
            aliases,
            namespaces,
            unresolvedAliases,
            helperAliases,
            lexicalBindings,
          );
          if (resolution.kind !== "non_governed") {
            changed =
              registerParameterResolution(parameter.name, resolution) || changed;
            continue;
          }
        }
        const evidence = compoundTableAliasEvidence(
          argument,
          aliases,
          namespaces,
          helperAliases,
          unresolvedAliases,
          lexicalBindings,
        );
        if (evidence.tables.size > 0 || evidence.unresolved) {
          for (const parameterBinding of parameterBindings) {
            changed =
              markUnsafeBinding(parameterBinding, parameterBinding.text) || changed;
          }
        }
      }
    }
  }
  lexicalBindings.operationAliases = new Map();
  for (const declaration of declarations) {
    if (
      ts.isIdentifier(declaration.name) &&
      isConstDeclaration(declaration) &&
      declaration.initializer &&
      !assigned.has(declaration.name)
    ) {
      const initializer = unwrap(declaration.initializer);
      if (
        ts.isStringLiteral(initializer) ||
        ts.isNoSubstitutionTemplateLiteral(initializer)
      ) {
        lexicalBindings.operationAliases.set(declaration.name, initializer.text);
      }
    }
  }
  return {
    aliases,
    namespaces,
    helperAliases,
    unresolvedAliases,
    lexicalBindings,
    assigned,
  };
}

function resolveTableReference(
  expression,
  aliases,
  namespaces,
  unresolvedAliases,
  helperAliases,
  lexicalBindings,
) {
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) {
    const binding = lexicalBindings?.declarationFor(current);
    if (binding) {
      return lexicalBindings.resolutions.get(binding) ?? NON_GOVERNED_IMPORT;
    }
    const table = aliases.get(current.text);
    if (table) return tableImport(table);
    const namespace = namespaces.get(current.text);
    if (namespace) return namespace;
    const helper = helperAliases.get(current.text);
    if (helper) return helper;
    const message = unresolvedAliases.get(current.text);
    return message ? { ...UNRESOLVED_IMPORT, message } : NON_GOVERNED_IMPORT;
  }
  if (ts.isPropertyAccessExpression(current)) {
    const stored = governedStorageResolution(current, lexicalBindings);
    if (stored) return stored;
    const localMember = resolveLocalFactoryMember(
      current,
      aliases,
      namespaces,
      unresolvedAliases,
      helperAliases,
      lexicalBindings,
    );
    if (localMember) return localMember;
    const base = resolveTableReference(
      current.expression,
      aliases,
      namespaces,
      unresolvedAliases,
      helperAliases,
      lexicalBindings,
    );
    if (base.kind === "namespace") {
      const resolution = base.resolveExport(current.name.text);
      return resolution.kind === "unresolved" && !resolution.message
        ? {
            ...resolution,
            message: `cannot resolve local issue-table namespace import ${current.name.text}`,
          }
        : resolution;
    }
    return base.kind === "unresolved" ? base : NON_GOVERNED_IMPORT;
  }
  if (ts.isElementAccessExpression(current)) {
    const stored = governedStorageResolution(current, lexicalBindings);
    if (stored) return stored;
    const base = resolveTableReference(
      current.expression,
      aliases,
      namespaces,
      unresolvedAliases,
      helperAliases,
      lexicalBindings,
    );
    if (base.kind === "unresolved") return base;
    if (base.kind !== "namespace") return NON_GOVERNED_IMPORT;
    if (
      !current.argumentExpression ||
      !(
        ts.isStringLiteral(current.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)
      )
    ) {
      return {
        ...UNRESOLVED_IMPORT,
        message: "cannot resolve dynamic local issue-table namespace import",
      };
    }
    const resolution = base.resolveExport(current.argumentExpression.text);
    return resolution.kind === "unresolved" && !resolution.message
      ? {
          ...resolution,
          message:
            `cannot resolve local issue-table namespace import ` +
            `${current.argumentExpression.text}`,
        }
      : resolution;
  }
  if (ts.isCallExpression(current)) {
    const callee = resolveTableReference(
      current.expression,
      aliases,
      namespaces,
      unresolvedAliases,
      helperAliases,
      lexicalBindings,
    );
    if (callee.kind === "unresolved") return callee;
    const localFunction = exactLocalFunction(current.expression, lexicalBindings);
    if (localFunction) {
      lexicalBindings.resolvingFunctions ??= new Set();
      if (lexicalBindings.resolvingFunctions.has(localFunction)) {
        return NON_GOVERNED_IMPORT;
      }
      lexicalBindings.resolvingFunctions.add(localFunction);
      const returns = directFunctionReturns(localFunction);
      if (returns.length !== 1) {
        lexicalBindings.resolvingFunctions.delete(localFunction);
        return NON_GOVERNED_IMPORT;
      }
      const resolution = resolveTableReference(
        returns[0],
        aliases,
        namespaces,
        unresolvedAliases,
        helperAliases,
        lexicalBindings,
      );
      lexicalBindings.resolvingFunctions.delete(localFunction);
      return resolution;
    }
  }
  return NON_GOVERNED_IMPORT;
}

function directFunctionReturns(functionLike) {
  if (!functionLike.body) return [];
  if (!ts.isBlock(functionLike.body)) return [functionLike.body];
  const returns = [];
  function visit(node) {
    if (node !== functionLike.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(functionLike.body);
  return returns;
}

function exactCallbackReturnExpression(callback) {
  if (!callback?.body) return null;
  if (!ts.isBlock(callback.body)) return callback.body;
  if (
    callback.body.statements.length !== 1 ||
    !ts.isReturnStatement(callback.body.statements[0]) ||
    !callback.body.statements[0].expression
  ) {
    return null;
  }
  return callback.body.statements[0].expression;
}

function exactCallbackParameter(callback) {
  if (
    callback.parameters.length !== 1 ||
    !ts.isIdentifier(callback.parameters[0].name) ||
    callback.parameters[0].dotDotDotToken ||
    callback.parameters[0].initializer ||
    callback.parameters[0].questionToken
  ) {
    return null;
  }
  return callback.parameters[0].name;
}

function exactLocalFunction(callee, lexicalBindings) {
  const current = unwrap(callee);
  if (!ts.isIdentifier(current)) return null;
  const binding = lexicalBindings?.declarationFor(current);
  return binding ? lexicalBindings.localFunctions?.get(binding) ?? null : null;
}

function resolveLocalFactoryMember(
  member,
  aliases,
  namespaces,
  unresolvedAliases,
  helperAliases,
  lexicalBindings,
) {
  const call = unwrap(member.expression);
  if (!ts.isCallExpression(call)) return null;
  const factory = exactLocalFunction(call.expression, lexicalBindings);
  if (!factory) return null;
  const returns = directFunctionReturns(factory);
  if (returns.length !== 1) return null;
  const returned = unwrap(returns[0]);
  if (!ts.isObjectLiteralExpression(returned)) return null;
  let governed = false;
  for (const property of returned.properties) {
    if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) {
      governed = true;
      continue;
    }
    const propertyName =
      ts.isIdentifier(property.name) ||
      ts.isStringLiteral(property.name) ||
      ts.isNumericLiteral(property.name)
        ? property.name.text
        : null;
    let value = null;
    if (ts.isPropertyAssignment(property)) value = property.initializer;
    else if (ts.isShorthandPropertyAssignment(property)) value = property.name;
    if (!value) continue;
    const resolution = resolveTableReference(
      value,
      aliases,
      namespaces,
      unresolvedAliases,
      helperAliases,
      lexicalBindings,
    );
    governed ||= resolution.kind === "table" || resolution.kind === "unresolved";
    if (propertyName === member.name.text) return resolution;
  }
  return governed ? { ...UNRESOLVED_IMPORT, unsafeGovernedMember: true } : null;
}

function staticOperation(callee, lexicalBindings = null, assigned = new Set()) {
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
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isIdentifier(expression.argumentExpression)
  ) {
    const binding = lexicalBindings?.declarationFor(expression.argumentExpression);
    const operation = binding
      ? lexicalBindings?.operationAliases?.get(binding)
      : null;
    if (operation) return operation;
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

function isInsideRunIssueMutation(
  node,
  aliases,
  namespaces,
  helperAliases,
  unresolvedAliases,
  lexicalBindings,
) {
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
      const helper = callee
        ? resolveTableReference(
            callee,
            aliases,
            namespaces,
            unresolvedAliases,
            helperAliases,
            lexicalBindings,
          )
        : NON_GOVERNED_IMPORT;
      if (helper.kind === "helper" && helper.helper === "runIssueMutation") {
        return true;
      }
    }
  }
  return false;
}

function versionedUpdateWrapper(
  node,
  aliases,
  namespaces,
  helperAliases,
  unresolvedAliases,
  lexicalBindings,
) {
  return versionedUpdateHelperResolution(
    node,
    aliases,
    namespaces,
    helperAliases,
    unresolvedAliases,
    lexicalBindings,
  )?.helper ?? null;
}

function versionedUpdateHelperResolution(
  node,
  aliases,
  namespaces,
  helperAliases,
  unresolvedAliases,
  lexicalBindings,
) {
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
  const helper = ts.isCallExpression(patch)
    ? resolveTableReference(
        patch.expression,
        aliases,
        namespaces,
        unresolvedAliases,
        helperAliases,
        lexicalBindings,
      )
    : NON_GOVERNED_IMPORT;
  return (
    ts.isCallExpression(patch) &&
    helper.kind === "helper" &&
    helper.helper === "versionedIssuePatch"
  )
    ? helper
    : null;
}

function directTableReference(
  expression,
  aliases,
  namespaces,
  helperAliases,
  unresolvedAliases,
  lexicalBindings,
  failOnUnresolved = false,
) {
  const current = unwrap(expression);
  let resolution = resolveTableReference(
    current,
    aliases,
    namespaces,
    unresolvedAliases,
    helperAliases,
    lexicalBindings,
  );
  if (
    resolution.kind === "non_governed" &&
    failOnUnresolved &&
    ts.isCallExpression(current)
  ) {
    const callee = resolveTableReference(
      current.expression,
      aliases,
      namespaces,
      unresolvedAliases,
      helperAliases,
      lexicalBindings,
    );
    if (callee.kind === "unresolved") resolution = callee;
  }
  if (resolution.kind === "unresolved" && failOnUnresolved) {
    throw new Error(
      resolution.message ?? "cannot resolve local issue-table import used by a write",
    );
  }
  return resolution.kind === "table" ? resolution.table : null;
}

function tableReferences(
  expression,
  aliases,
  namespaces,
  helperAliases,
  unresolvedAliases,
  lexicalBindings,
) {
  const references = new Set();
  function visit(node) {
    const current = unwrap(node);
    const resolution = resolveTableReference(
      current,
      aliases,
      namespaces,
      unresolvedAliases,
      helperAliases,
      lexicalBindings,
    );
    if (
      resolution.kind === "unresolved" &&
      resolution.message?.startsWith("unsafe issue-table alias ")
    ) {
      throw new Error(resolution.message);
    }
    if (resolution.kind === "table") {
      references.add(resolution.table);
      return;
    }
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return;
    ts.forEachChild(current, visit);
  }
  visit(expression);
  return references;
}

export const SYNTHETIC_THIS_INSPECTION_UNRESOLVED =
  "SYNTHETIC_THIS_INSPECTION_UNRESOLVED";

export function nodeKey(filePath, node) {
  return `${normalizePath(filePath)}#${node.pos}:${node.end}`;
}

export function symbolKey(filePath, declaration) {
  return nodeKey(filePath, declaration);
}

export function isTrustedHelperPair(pair) {
  return (
    pair?.helperExport === "runIssueMutation" &&
    pair.helperPath === "server/src/services/issue-versioning.ts"
  ) || (
    pair?.helperExport === "versionedIssuePatch" &&
    (
      pair.helperPath === "server/src/services/issue-versioning.ts" ||
      pair.helperPath === "packages/db/src/issue-versioning.ts"
    )
  );
}

export function resolveExecutableFunctionLike(declaration) {
  if (!declaration) return null;
  if (
    (ts.isFunctionDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    declaration.body &&
    declaration.parameters
  ) {
    return declaration;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    isConstDeclaration(declaration) &&
    declaration.initializer
  ) {
    const initializer = unwrap(declaration.initializer);
    return (
      (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) &&
        initializer.body &&
        initializer.parameters
    )
      ? initializer
      : null;
  }
  if (
    ts.isPropertyAssignment(declaration) &&
    !ts.isComputedPropertyName(declaration.name)
  ) {
    const initializer = unwrap(declaration.initializer);
    return (
      (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) &&
        initializer.body &&
        initializer.parameters
    )
      ? initializer
      : null;
  }
  return null;
}

export function hasSyntheticThisParameter(functionLike) {
  if (
    !functionLike ||
    !functionLike.parameters ||
    typeof ts.getThisParameter !== "function" ||
    typeof ts.parameterIsThisKeyword !== "function"
  ) {
    return SYNTHETIC_THIS_INSPECTION_UNRESOLVED;
  }
  try {
    const canonical = ts.getThisParameter(functionLike);
    const parameters = [...functionLike.parameters];
    const results = parameters.map((parameter) => ts.parameterIsThisKeyword(parameter));
    if (
      results.length !== parameters.length ||
      results.some((result) => typeof result !== "boolean")
    ) {
      return SYNTHETIC_THIS_INSPECTION_UNRESOLVED;
    }
    const listHasThis = results.some(Boolean);
    const canonicalHasThis = canonical !== undefined;
    if (canonicalHasThis !== listHasThis) {
      return SYNTHETIC_THIS_INSPECTION_UNRESOLVED;
    }
    if (canonicalHasThis) {
      const index = parameters.indexOf(canonical);
      if (index < 0 || results[index] !== true) {
        return SYNTHETIC_THIS_INSPECTION_UNRESOLVED;
      }
    }
    return canonicalHasThis || listHasThis;
  } catch {
    return SYNTHETIC_THIS_INSPECTION_UNRESOLVED;
  }
}

function functionDeclarationNode(functionLike) {
  if (
    (ts.isFunctionExpression(functionLike) || ts.isArrowFunction(functionLike)) &&
    (
      ts.isVariableDeclaration(functionLike.parent) ||
      ts.isPropertyAssignment(functionLike.parent)
    )
  ) {
    return functionLike.parent;
  }
  return functionLike;
}

function literalName(node) {
  if (!node) return null;
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function functionDisplayName(functionLike) {
  if (
    (ts.isFunctionDeclaration(functionLike) ||
      ts.isFunctionExpression(functionLike) ||
      ts.isMethodDeclaration(functionLike)) &&
    functionLike.name
  ) {
    return literalName(functionLike.name) ?? `<function@${functionLike.pos}>`;
  }
  const declaration = functionDeclarationNode(functionLike);
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration)) &&
    declaration.name
  ) {
    return literalName(declaration.name) ?? `<function@${functionLike.pos}>`;
  }
  return `<function@${functionLike.pos}>`;
}

function createFunctionRegistry(sourceFile, filePath, lexicalBindings) {
  const records = [];
  const byExecutable = new Map();
  const byBinding = new Map();
  const objectMembers = new Map();

  function register(functionLike) {
    if (!functionLike.body || byExecutable.has(functionLike)) return;
    const declaration = functionDeclarationNode(functionLike);
    const record = {
      name: functionDisplayName(functionLike),
      symbolKey: symbolKey(filePath, declaration),
      classification: "READ_ONLY",
      localDependencies: [],
      directReadRoots: [],
      terminalAwaits: [],
      evidence: [],
      captureFacts: {
        nestedFunctionLikes: [],
        capabilityCaptures: [],
      },
      normalExit: true,
    };
    Object.defineProperties(record, {
      _node: { value: functionLike },
      _declaration: { value: declaration },
      _dependencies: { value: [], writable: true },
      _known: { value: [], writable: true },
      _unknown: { value: [], writable: true },
      _parameter: { value: null, writable: true },
      _parameterInitializerIndex: { value: null, writable: true },
      _lexicalBindings: { value: lexicalBindings },
      _assigned: {
        value: lexicalBindings.assigned ?? new Set(),
        writable: true,
      },
    });
    records.push(record);
    byExecutable.set(functionLike, record);
    if (
      ts.isFunctionDeclaration(functionLike) &&
      functionLike.name
    ) {
      byBinding.set(functionLike.name, record);
    } else if (
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name)
    ) {
      byBinding.set(declaration.name, record);
    }
  }

  function collect(node) {
    if (ts.isFunctionLike(node)) register(node);
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  for (const record of records) {
    const declaration = record._declaration;
    if (
      (ts.isMethodDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
      declaration.parent &&
      ts.isObjectLiteralExpression(declaration.parent)
    ) {
      const object = declaration.parent;
      const variable = object.parent;
      if (
        ts.isVariableDeclaration(variable) &&
        ts.isIdentifier(variable.name) &&
        isConstDeclaration(variable)
      ) {
        if (!objectMembers.has(variable.name)) objectMembers.set(variable.name, new Map());
        objectMembers.get(variable.name).set(record.name, record);
      }
    }
  }

  function resolveIdentifier(identifier) {
    const binding = lexicalBindings.declarationFor(identifier);
    return binding ? byBinding.get(binding) ?? null : null;
  }

  function returnedObject(record) {
    const returns = directFunctionReturns(record._node);
    if (returns.length !== 1) return null;
    const returned = unwrap(returns[0]);
    return ts.isObjectLiteralExpression(returned) ? returned : null;
  }

  function memberRecordFromObject(object, memberName) {
    for (const property of object.properties) {
      if (
        ts.isComputedPropertyName(property.name) ||
        literalName(property.name) !== memberName
      ) {
        continue;
      }
      if (ts.isMethodDeclaration(property)) return byExecutable.get(property) ?? null;
      if (ts.isPropertyAssignment(property)) {
        const initializer = unwrap(property.initializer);
        if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
          return byExecutable.get(initializer) ?? null;
        }
      }
    }
    return null;
  }

  function resolveCallee(expression) {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) return resolveIdentifier(current);
    if (
      ts.isPropertyAccessExpression(current) &&
      !current.questionDotToken
    ) {
      const memberName = current.name.text;
      const receiver = unwrap(current.expression);
      if (ts.isIdentifier(receiver)) {
        const binding = lexicalBindings.declarationFor(receiver);
        const member = binding ? objectMembers.get(binding)?.get(memberName) : null;
        if (member) return member;
      }
      if (ts.isCallExpression(receiver)) {
        const factory = resolveCallee(receiver.expression);
        const object = factory ? returnedObject(factory) : null;
        if (object) return memberRecordFromObject(object, memberName);
      }
    }
    return null;
  }

  return {
    records,
    byExecutable,
    byBinding,
    resolveIdentifier,
    resolveCallee,
    returnedObject,
    memberRecordFromObject,
  };
}

function isDeclarationIdentifier(identifier) {
  const parent = identifier.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isFunctionExpression(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassExpression(parent) && parent.name === identifier) ||
    (ts.isImportSpecifier(parent) && parent.name === identifier) ||
    (ts.isNamespaceImport(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.name === identifier) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (
      (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
      parent.name === identifier
    ) ||
    ts.isTypeNode(parent)
  );
}

function exactBindingIdentifier(expression, binding, lexicalBindings) {
  const current = unwrap(expression);
  return (
    ts.isIdentifier(current) &&
    lexicalBindings.declarationFor(current) === binding
  );
}

function immutableAliasBindings(functionLike, transactionBinding, lexicalBindings, assigned) {
  const aliases = new Set([transactionBinding]);
  let changed = true;
  while (changed) {
    changed = false;
    function visit(node) {
      if (node !== functionLike && ts.isFunctionLike(node)) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        isConstDeclaration(node) &&
        node.initializer &&
        !assigned.has(node.name)
      ) {
        const initializer = unwrap(node.initializer);
        if (
          ts.isIdentifier(initializer) &&
          aliases.has(lexicalBindings.declarationFor(initializer)) &&
          !aliases.has(node.name)
        ) {
          aliases.add(node.name);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(functionLike.body);
  }
  return aliases;
}

function capabilityIdentifiers(expression, bindings, lexicalBindings, consumed = null) {
  const identifiers = [];
  function visit(node) {
    if (ts.isIdentifier(node)) {
      const binding = lexicalBindings.declarationFor(node);
      if (
        bindings.has(binding) &&
        !isDeclarationIdentifier(node) &&
        (!consumed || !consumed.has(node))
      ) {
        identifiers.push(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return identifiers;
}

function markCapabilityConsumed(expression, bindings, lexicalBindings, consumed) {
  for (const identifier of capabilityIdentifiers(expression, bindings, lexicalBindings)) {
    consumed.add(identifier);
  }
}

function explicitUndefinedArgument(expression, lexicalBindings) {
  const current = unwrap(expression);
  return (
    ts.isIdentifier(current) &&
    current.text === "undefined" &&
    !lexicalBindings.declarationFor(current)
  );
}

function staticallyNonUndefinedPureExpression(
  expression,
  capabilityBindings,
  lexicalBindings,
  assigned = new Set(),
  seenBindings = new Set(),
  allowPriorConstruction = false,
) {
  const current = unwrap(expression);
  if (
    capabilityIdentifiers(current, capabilityBindings, lexicalBindings).length > 0
  ) {
    return false;
  }
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current) ||
    ts.isNumericLiteral(current) ||
    ts.isBigIntLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.every(
      (element) =>
        !ts.isOmittedExpression(element) &&
        !ts.isSpreadElement(element) &&
        staticallyNonUndefinedPureExpression(
          element,
          capabilityBindings,
          lexicalBindings,
          assigned,
          seenBindings,
          allowPriorConstruction,
        ),
    );
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        staticallyNonUndefinedPureExpression(
          property.initializer,
          capabilityBindings,
          lexicalBindings,
          assigned,
          seenBindings,
          allowPriorConstruction,
        ),
    );
  }
  if (ts.isIdentifier(current)) {
    const binding = lexicalBindings.declarationFor(current);
    const declaration = binding?.parent;
    if (
      !binding ||
      seenBindings.has(binding) ||
      assigned.has(binding) ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.name !== binding ||
      !isConstDeclaration(declaration) ||
      !declaration.initializer
    ) {
      return false;
    }
    return staticallyNonUndefinedPureExpression(
      declaration.initializer,
      capabilityBindings,
      lexicalBindings,
      assigned,
      new Set(seenBindings).add(binding),
      true,
    );
  }
  if (
    allowPriorConstruction &&
    ts.isNewExpression(current) &&
    capabilityIdentifiers(current, capabilityBindings, lexicalBindings).length === 0
  ) {
    return true;
  }
  return false;
}

function parameterInitializerExecutionPlan(
  call,
  executable,
  capabilityBindings,
  lexicalBindings,
  {
    exactCapabilityArgumentIndexes = new Set(),
    assigned = new Set(),
  } = {},
) {
  if (
    !executable ||
    hasSyntheticThisParameter(executable) !== false ||
    call.questionDotToken ||
    call.arguments.some((argument) => ts.isSpreadElement(argument)) ||
    call.arguments.length > executable.parameters.length
  ) {
    return null;
  }
  const activeInitializerIndexes = new Set();
  const ordinaryParameterIndexes = new Set();
  for (let index = 0; index < executable.parameters.length; index += 1) {
    const parameter = executable.parameters[index];
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.dotDotDotToken ||
      parameter.questionToken
    ) {
      return null;
    }
    if (index >= call.arguments.length) {
      if (!parameter.initializer) return null;
      activeInitializerIndexes.add(index);
      continue;
    }
    const argument = call.arguments[index];
    const currentArgument = unwrap(argument);
    if (
      exactCapabilityArgumentIndexes.has(index) &&
      ts.isIdentifier(currentArgument) &&
      capabilityBindings.has(lexicalBindings.declarationFor(currentArgument))
    ) {
      continue;
    }
    if (!parameter.initializer) {
      if (
        staticallyNonUndefinedPureExpression(
          argument,
          capabilityBindings,
          lexicalBindings,
          assigned,
        )
      ) {
        ordinaryParameterIndexes.add(index);
      }
      continue;
    }
    if (explicitUndefinedArgument(argument, lexicalBindings)) {
      activeInitializerIndexes.add(index);
      continue;
    }
    if (
      !staticallyNonUndefinedPureExpression(
        argument,
        capabilityBindings,
        lexicalBindings,
        assigned,
      )
    ) {
      return null;
    }
    ordinaryParameterIndexes.add(index);
  }
  Object.defineProperty(activeInitializerIndexes, "_ordinaryParameterIndexes", {
    value: ordinaryParameterIndexes,
  });
  return activeInitializerIndexes;
}

function initializerFactIsActive(fact, activeInitializerIndexes) {
  const index = fact?._parameterInitializerIndex;
  return (
    index === undefined ||
    activeInitializerIndexes === null ||
    activeInitializerIndexes.has(index)
  );
}

function classifyFunctionInvocation(
  record,
  activeInitializerIndexes = null,
  memo = new Map(),
  visiting = new Set(),
) {
  const activeKey = activeInitializerIndexes === null
    ? "*"
    : [...activeInitializerIndexes].sort((left, right) => left - right).join(",");
  const key = `${record.symbolKey}|${activeKey}`;
  if (memo.has(key)) return memo.get(key);
  if (visiting.has(key)) return "UNKNOWN";
  visiting.add(key);
  const dependencies = record._dependencies
    .filter((dependency) =>
      initializerFactIsActive(dependency, activeInitializerIndexes))
    .map((dependency) =>
      classifyFunctionInvocation(
        dependency._callee,
        dependency._calleeActiveInitializerIndexes ?? null,
        memo,
        visiting,
      ));
  const known = record._known.some((fact) =>
    initializerFactIsActive(fact, activeInitializerIndexes));
  const unknown = record._unknown.some((fact) =>
    initializerFactIsActive(fact, activeInitializerIndexes));
  const activeInitializersPure =
    activeInitializerIndexes === null ||
    activeParameterInitializersArePure(
      record._node,
      activeInitializerIndexes,
      record._lexicalBindings,
      record._assigned,
    );
  const classification =
    known || dependencies.includes("MAY_WRITE_OR_CONTROL")
      ? "MAY_WRITE_OR_CONTROL"
      : !activeInitializersPure || unknown || dependencies.includes("UNKNOWN")
        ? "UNKNOWN"
        : "READ_ONLY";
  visiting.delete(key);
  memo.set(key, classification);
  return classification;
}

function initializerHasPotentialEffect(node) {
  const current = unwrap(node);
  if (
    ts.isFunctionLike(current) ||
    ts.isCallExpression(current) ||
    ts.isNewExpression(current) ||
    ts.isTaggedTemplateExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isYieldExpression(current) ||
    ts.isDeleteExpression(current) ||
    ts.isSpreadElement(current) ||
    ts.isSpreadAssignment(current) ||
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      current.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) ||
    (
      (ts.isPrefixUnaryExpression(current) ||
        ts.isPostfixUnaryExpression(current)) &&
      (
        current.operator === ts.SyntaxKind.PlusPlusToken ||
        current.operator === ts.SyntaxKind.MinusMinusToken
      )
    )
  ) {
    return true;
  }
  let potential = false;
  ts.forEachChild(current, (child) => {
    if (!potential && initializerHasPotentialEffect(child)) potential = true;
  });
  return potential;
}

function activeParameterInitializersArePure(
  executable,
  activeInitializerIndexes,
  lexicalBindings,
  assigned = new Set(),
) {
  if (!executable || !activeInitializerIndexes || !lexicalBindings) return false;
  const ordinaryParameterIndexes = new Set(
    activeInitializerIndexes._ordinaryParameterIndexes ?? [],
  );
  const parameters = [...executable.parameters];

  function pure(expression, parameterIndex, seenBindings = new Set()) {
    const current = unwrap(expression);
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isNumericLiteral(current) ||
      ts.isBigIntLiteral(current) ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      current.kind === ts.SyntaxKind.NullKeyword
    ) {
      return true;
    }
    if (ts.isArrayLiteralExpression(current)) {
      return current.elements.every(
        (element) =>
          !ts.isOmittedExpression(element) &&
          !ts.isSpreadElement(element) &&
          pure(element, parameterIndex, seenBindings),
      );
    }
    if (ts.isObjectLiteralExpression(current)) {
      return current.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          pure(property.initializer, parameterIndex, seenBindings),
      );
    }
    if (!ts.isIdentifier(current)) return false;
    const binding = lexicalBindings.declarationFor(current);
    if (!binding || seenBindings.has(binding) || assigned.has(binding)) return false;
    const earlierParameterIndex = parameters.findIndex(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name === binding,
    );
    if (earlierParameterIndex >= 0) {
      return (
        earlierParameterIndex < parameterIndex &&
        ordinaryParameterIndexes.has(earlierParameterIndex)
      );
    }
    const declaration = binding.parent;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.name !== binding ||
      !isConstDeclaration(declaration) ||
      !declaration.initializer
    ) {
      return false;
    }
    return pure(
      declaration.initializer,
      parameterIndex,
      new Set(seenBindings).add(binding),
    );
  }

  for (const index of [...activeInitializerIndexes].sort((left, right) => left - right)) {
    const parameter = parameters[index];
    if (
      !parameter ||
      !ts.isIdentifier(parameter.name) ||
      parameter.dotDotDotToken ||
      parameter.questionToken ||
      !parameter.initializer ||
      !pure(parameter.initializer, index)
    ) {
      return false;
    }
    ordinaryParameterIndexes.add(index);
  }
  return true;
}

function activeParameterInitializersAreReadOnly(record, activeInitializerIndexes) {
  if (
    !record ||
    !activeParameterInitializersArePure(
      record._node,
      activeInitializerIndexes,
      record._lexicalBindings,
      record._assigned,
    )
  ) {
    return false;
  }
  if (
    !record._parameter &&
    [...activeInitializerIndexes].some((index) => {
      const parameter = record._node.parameters[index];
      return (
        !parameter ||
        !ts.isIdentifier(parameter.name) ||
        !parameter.initializer ||
        initializerHasPotentialEffect(parameter.initializer)
      );
    })
  ) {
    return false;
  }
  const activeFact = (fact) =>
    fact._parameterInitializerIndex !== undefined &&
    activeInitializerIndexes.has(fact._parameterInitializerIndex);
  if (record._known.some(activeFact) || record._unknown.some(activeFact)) return false;
  return record._dependencies
    .filter(activeFact)
    .every(
      (dependency) =>
        classifyFunctionInvocation(
          dependency._callee,
          dependency._calleeActiveInitializerIndexes ?? null,
        ) === "READ_ONLY",
    );
}

function callMember(call) {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    return { receiver: unwrap(callee.expression), name: callee.name.text, computed: false };
  }
  if (ts.isElementAccessExpression(callee)) {
    const argument = callee.argumentExpression;
    return {
      receiver: unwrap(callee.expression),
      name:
        argument &&
        (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          ? argument.text
          : null,
      computed: true,
    };
  }
  return null;
}

function readQueryResult(call, capabilityBindings, lexicalBindings) {
  const member = callMember(call);
  if (!member || member.computed || !member.name) return null;
  const forbidden = new Set([
    "insert",
    "update",
    "delete",
    "transaction",
    "rollback",
    "execute",
    "raw",
  ]);
  if (forbidden.has(member.name)) return { kind: "known", node: call };
  const hasCapabilityArgument = () =>
    call.arguments.some((argument) =>
      capabilityIdentifiers(argument, capabilityBindings, lexicalBindings).length > 0);
  if (
    member.name === "select" &&
    ts.isIdentifier(member.receiver) &&
    capabilityBindings.has(lexicalBindings.declarationFor(member.receiver))
  ) {
    return hasCapabilityArgument()
      ? { kind: "unknown", node: call }
      : { kind: "read", root: call };
  }
  if (ts.isCallExpression(member.receiver)) {
    const prior = readQueryResult(member.receiver, capabilityBindings, lexicalBindings);
    if (!prior || prior.kind !== "read") return prior;
    return hasCapabilityArgument()
      ? { kind: "unknown", node: call }
      : prior;
  }
  return null;
}

function isMaximalReceiverCall(call) {
  const parent = call.parent;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === call &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return false;
  }
  return true;
}

function terminalAwaitDeclaration(call) {
  let current = call;
  while (
    current.parent &&
    (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)
    )
  ) {
    current = current.parent;
  }
  if (!ts.isAwaitExpression(current.parent)) return null;
  const declaration = current.parent.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    isConstDeclaration(declaration) &&
    declaration.initializer === current.parent
  )
    ? declaration
    : null;
}

function selectTransactionParameters(registry, lexicalBindings) {
  const selected = new Map(
    registry.records.map((record) => [record, new Set()]),
  );
  const mappings = [];
  const transactionMembers = new Set([
    "select",
    "insert",
    "update",
    "delete",
    "transaction",
    "rollback",
    "execute",
    "raw",
  ]);

  for (const record of registry.records) {
    const parameters = new Map(
      record._node.parameters
        .filter((parameter) => ts.isIdentifier(parameter.name))
        .map((parameter) => [parameter.name, parameter]),
    );
    const soleParameter = record._node.parameters.length === 1
      ? record._node.parameters[0]
      : null;
    if (
      soleParameter &&
      ts.isIdentifier(soleParameter.name) &&
      ts.parameterIsThisKeyword(soleParameter) === false &&
      !soleParameter.dotDotDotToken &&
      !soleParameter.initializer &&
      !soleParameter.questionToken
    ) {
      selected.get(record).add(soleParameter);
    }
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const member = callMember(node);
        const receiver = member ? unwrap(member.receiver) : null;
        const receiverBinding = receiver && ts.isIdentifier(receiver)
          ? lexicalBindings.declarationFor(receiver)
          : null;
        if (
          parameters.has(receiverBinding) &&
          (member.computed || transactionMembers.has(member.name))
        ) {
          selected.get(record).add(parameters.get(receiverBinding));
        }

        const calleeExpression = unwrap(node.expression);
        if (ts.isIdentifier(calleeExpression) && node.arguments.length > 0) {
          const helperBinding = lexicalBindings.declarationFor(calleeExpression);
          const helper = helperBinding
            ? lexicalBindings.resolutions.get(helperBinding)
            : null;
          const helperArgument = unwrap(node.arguments[0]);
          const argumentBinding = ts.isIdentifier(helperArgument)
            ? lexicalBindings.declarationFor(helperArgument)
            : null;
          if (
            parameters.has(argumentBinding) &&
            helper?.kind === "helper" &&
            isTrustedHelperPair({
              helperExport: helper.helper,
              helperPath: helper.helperPath,
            })
          ) {
            selected.get(record).add(parameters.get(argumentBinding));
          }
        }

        const callee = registry.resolveCallee(node.expression);
        if (
          callee &&
          !node.questionDotToken &&
          !node.arguments.some((argument) => ts.isSpreadElement(argument))
        ) {
          for (
            let index = 0;
            index < node.arguments.length && index < callee._node.parameters.length;
            index += 1
          ) {
            const argument = unwrap(node.arguments[index]);
            const parameter = callee._node.parameters[index];
            if (
              !ts.isIdentifier(argument) ||
              !ts.isIdentifier(parameter.name) ||
              parameter.dotDotDotToken ||
              parameter.initializer ||
              parameter.questionToken
            ) {
              continue;
            }
            const callerBinding = lexicalBindings.declarationFor(argument);
            if (parameters.has(callerBinding)) {
              mappings.push({
                caller: record,
                callerParameter: parameters.get(callerBinding),
                callee,
                calleeParameter: parameter,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    for (const parameter of record._node.parameters) {
      if (parameter.initializer) visit(parameter.initializer);
    }
    visit(record._node.body);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const mapping of mappings) {
      const callerSelected = selected.get(mapping.caller);
      const calleeSelected = selected.get(mapping.callee);
      if (
        callerSelected.has(mapping.callerParameter) &&
        !calleeSelected.has(mapping.calleeParameter)
      ) {
        calleeSelected.add(mapping.calleeParameter);
        changed = true;
      }
      if (
        calleeSelected.has(mapping.calleeParameter) &&
        !callerSelected.has(mapping.callerParameter)
      ) {
        callerSelected.add(mapping.callerParameter);
        changed = true;
      }
    }
  }
  return selected;
}

function addEvidence(record, filePath, node, message) {
  const evidence = {
    nodeKey: nodeKey(filePath, node),
    message,
    syntaxKind: node.kind,
  };
  if (record._parameterInitializerIndex !== null) {
    Object.defineProperty(evidence, "_parameterInitializerIndex", {
      value: record._parameterInitializerIndex,
    });
  }
  if (
    !record._unknown.some((candidate) =>
      candidate.nodeKey === evidence.nodeKey && candidate.message === message)
  ) {
    record._unknown.push(evidence);
    record.evidence.push(evidence);
  }
}

function addKnown(record, filePath, node) {
  const evidence = {
    nodeKey: nodeKey(filePath, node),
    message: "known transaction write/control",
    syntaxKind: node.kind,
  };
  if (record._parameterInitializerIndex !== null) {
    Object.defineProperty(evidence, "_parameterInitializerIndex", {
      value: record._parameterInitializerIndex,
    });
  }
  if (!record._known.some((candidate) => candidate.nodeKey === evidence.nodeKey)) {
    record._known.push(evidence);
    record.evidence.push(evidence);
  }
}

function inspectNestedCaptures(
  record,
  filePath,
  capabilityBindings,
  lexicalBindings,
  root = record._node.body,
) {
  function collectNested(node) {
    if (node !== record._node && ts.isFunctionLike(node)) {
      record.captureFacts.nestedFunctionLikes.push(nodeKey(filePath, node));
      const captured = capabilityIdentifiers(node, capabilityBindings, lexicalBindings);
      if (captured.length > 0) {
        let knownNode = null;
        function findKnown(current) {
          if (knownNode) return;
          if (ts.isCallExpression(current)) {
            const member = callMember(current);
            if (
              member &&
              ["insert", "update", "delete", "transaction", "rollback", "execute", "raw"]
                .includes(member.name) &&
              capabilityIdentifiers(member.receiver, capabilityBindings, lexicalBindings)
                .length > 0
            ) {
              knownNode = current;
              return;
            }
          }
          ts.forEachChild(current, findKnown);
        }
        findKnown(node);
        const capture = {
          nestedFunction: nodeKey(filePath, node),
          capturedBinding: symbolKey(filePath, lexicalBindings.declarationFor(captured[0])),
          result: knownNode ? "KNOWN_WRITE_OR_CONTROL" : "UNKNOWN",
        };
        if (record._parameterInitializerIndex !== null) {
          Object.defineProperty(capture, "_parameterInitializerIndex", {
            value: record._parameterInitializerIndex,
          });
        }
        record.captureFacts.capabilityCaptures.push(capture);
        if (knownNode) addKnown(record, filePath, knownNode);
        else {
          addEvidence(
            record,
            filePath,
            node,
            "nested transaction/query capability capture",
          );
        }
      }
      return;
    }
    ts.forEachChild(node, collectNested);
  }
  collectNested(root);
  record.captureFacts.nestedFunctionLikes.sort();
  record.captureFacts.capabilityCaptures.sort((left, right) =>
    left.nestedFunction.localeCompare(right.nestedFunction));
}

function analyzeFunctionFacts(
  record,
  filePath,
  registry,
  lexicalBindings,
  assigned,
  helperAliases,
  transactionParameter,
) {
  record._assigned = assigned;
  if (!transactionParameter) return;
  const transactionBinding = transactionParameter.name;
  record._parameter = transactionParameter;
  const capabilityBindings = immutableAliasBindings(
    record._node,
    transactionBinding,
    lexicalBindings,
    assigned,
  );
  let addedParameterAlias = true;
  while (addedParameterAlias) {
    addedParameterAlias = false;
    for (const parameter of record._node.parameters) {
      if (
        ts.isIdentifier(parameter.name) &&
        parameter.initializer &&
        capabilityIdentifiers(
          parameter.initializer,
          capabilityBindings,
          lexicalBindings,
        ).length > 0 &&
        !capabilityBindings.has(parameter.name)
      ) {
        capabilityBindings.add(parameter.name);
        addedParameterAlias = true;
      }
    }
  }
  const builderBindings = new Set();
  const consumed = new Set();

  function collectBuilders(node) {
    if (node !== record._node.body && ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isConstDeclaration(node) &&
      node.initializer
    ) {
      const initializer = unwrap(node.initializer);
      if (
        (ts.isCallExpression(initializer) &&
          readQueryResult(initializer, capabilityBindings, lexicalBindings)?.kind === "read" &&
          !terminalAwaitDeclaration(initializer)) ||
        (
          ts.isIdentifier(initializer) &&
          builderBindings.has(lexicalBindings.declarationFor(initializer))
        )
      ) {
        builderBindings.add(node.name);
      }
    }
    ts.forEachChild(node, collectBuilders);
  }
  let previousBuilderCount = -1;
  while (previousBuilderCount !== builderBindings.size) {
    previousBuilderCount = builderBindings.size;
    for (const parameter of record._node.parameters) {
      if (parameter.initializer) collectBuilders(parameter.initializer);
    }
    collectBuilders(record._node.body);
  }
  for (const binding of builderBindings) capabilityBindings.add(binding);

  for (let index = 0; index < record._node.parameters.length; index += 1) {
    const parameter = record._node.parameters[index];
    if (!parameter.initializer) continue;
    record._parameterInitializerIndex = index;
    if (!ts.isIdentifier(parameter.name)) {
      addEvidence(
        record,
        filePath,
        parameter,
        "unsupported parameter initializer binding pattern",
      );
    }
    inspectNestedCaptures(
      record,
      filePath,
      capabilityBindings,
      lexicalBindings,
      parameter.initializer,
    );
  }
  record._parameterInitializerIndex = null;
  inspectNestedCaptures(record, filePath, capabilityBindings, lexicalBindings);

  function trustedHelperForCall(call) {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee)) return null;
    const binding = lexicalBindings.declarationFor(callee);
    const helper = binding ? lexicalBindings.resolutions.get(binding) : helperAliases.get(callee.text);
    return helper?.kind === "helper" &&
      isTrustedHelperPair({
        helperExport: helper.helper,
        helperPath: helper.helperPath,
      })
      ? helper
      : null;
  }

  function visit(node) {
    if (node !== record._node.body && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);

    if (ts.isCallExpression(node)) {
      let handledCapabilityReceiver = false;
      const read = readQueryResult(node, capabilityBindings, lexicalBindings);
      if (read && !isMaximalReceiverCall(node)) return;
      if (read && isMaximalReceiverCall(node)) {
        if (read.kind === "known") {
          addKnown(record, filePath, read.node);
          markCapabilityConsumed(node, capabilityBindings, lexicalBindings, consumed);
          return;
        }
        if (read.kind === "unknown") {
          addEvidence(record, filePath, read.node, "query capability in read argument");
          markCapabilityConsumed(node, capabilityBindings, lexicalBindings, consumed);
          return;
        }
        const argumentsWithCapabilities = node.arguments.some((argument) =>
          capabilityIdentifiers(argument, capabilityBindings, lexicalBindings).length > 0);
        if (argumentsWithCapabilities) {
          addEvidence(record, filePath, node, "query capability in read argument");
        } else if (terminalAwaitDeclaration(node)) {
          record.directReadRoots.push(nodeKey(filePath, read.root));
          record.terminalAwaits.push(nodeKey(filePath, node.parent));
        } else {
          addEvidence(record, filePath, node, "query capability escape");
        }
        markCapabilityConsumed(node, capabilityBindings, lexicalBindings, consumed);
        return;
      }

      const member = callMember(node);
      if (member) {
        const receiver = unwrap(member.receiver);
        const receiverBinding = ts.isIdentifier(receiver)
          ? lexicalBindings.declarationFor(receiver)
          : null;
        const receiverCapabilities =
          capabilityBindings.has(receiverBinding) && !consumed.has(receiver)
            ? [receiver]
            : [];
        if (receiverCapabilities.length > 0) {
          handledCapabilityReceiver = true;
          if (
            ["insert", "update", "delete", "transaction", "rollback", "execute", "raw"]
              .includes(member.name)
          ) {
            addKnown(record, filePath, node);
          } else {
            addEvidence(record, filePath, node, "query capability escape");
          }
          markCapabilityConsumed(member.receiver, capabilityBindings, lexicalBindings, consumed);
        }
      }

      const capabilityArguments = node.arguments
        .map((argument, index) => ({
          argument,
          index,
          identifiers: capabilityIdentifiers(
            argument,
            capabilityBindings,
            lexicalBindings,
            consumed,
          ),
        }))
        .filter((candidate) => candidate.identifiers.length > 0);
      if (capabilityArguments.length === 0) {
        if (
          record._parameterInitializerIndex !== null &&
          !handledCapabilityReceiver
        ) {
          addEvidence(
            record,
            filePath,
            node,
            "parameter initializer call has unknown effects",
          );
        }
        return;
      }

      const trustedHelper = trustedHelperForCall(node);
      if (trustedHelper) {
        if (trustedHelper.helper === "runIssueMutation") {
          addKnown(record, filePath, node);
        } else {
          addEvidence(record, filePath, node, "trusted helper is not a read dependency");
        }
        for (const candidate of capabilityArguments) {
          markCapabilityConsumed(
            candidate.argument,
            capabilityBindings,
            lexicalBindings,
            consumed,
          );
        }
        return;
      }

      const calleeExpression = unwrap(node.expression);
      if (
        ts.isIdentifier(calleeExpression) &&
        ["runIssueMutation", "versionedIssuePatch"].includes(calleeExpression.text)
      ) {
        addEvidence(record, filePath, node, "untrusted mutation helper");
        for (const candidate of capabilityArguments) {
          markCapabilityConsumed(
            candidate.argument,
            capabilityBindings,
            lexicalBindings,
            consumed,
          );
        }
        return;
      }

      const callee = registry.resolveCallee(node.expression);
      const executable = callee
        ? resolveExecutableFunctionLike(callee._declaration)
        : null;
      const syntheticThis = executable
        ? hasSyntheticThisParameter(executable)
        : SYNTHETIC_THIS_INSPECTION_UNRESOLVED;
      const initializerPlan = executable
        ? parameterInitializerExecutionPlan(
            node,
            executable,
            capabilityBindings,
            lexicalBindings,
          )
        : null;
      let exactDependency = null;
      if (
        callee &&
        executable &&
        syntheticThis === false &&
        initializerPlan &&
        capabilityArguments.length === 1 &&
        !node.questionDotToken &&
        !node.arguments.some((argument) => ts.isSpreadElement(argument))
      ) {
        const candidate = capabilityArguments[0];
        const entire = unwrap(candidate.argument);
        const entireBinding = ts.isIdentifier(entire)
          ? lexicalBindings.declarationFor(entire)
          : null;
        const parameter = executable.parameters[candidate.index];
        if (
          capabilityBindings.has(entireBinding) &&
          parameter &&
          ts.isIdentifier(parameter.name) &&
          ts.parameterIsThisKeyword(parameter) === false &&
          !parameter.dotDotDotToken &&
          !parameter.initializer &&
          !parameter.questionToken &&
          node.arguments.length <= executable.parameters.length
        ) {
          exactDependency = {
            callee,
            parameter,
            argumentIndex: candidate.index,
            activeInitializerIndexes: initializerPlan,
          };
        }
      }
      if (exactDependency) {
        const dependency = {
          edgeKey:
            `${record.symbolKey}|${nodeKey(filePath, node)}|` +
            `${exactDependency.callee.symbolKey}`,
          argumentIndex: exactDependency.argumentIndex,
          parameterSymbolKey: symbolKey(filePath, exactDependency.parameter),
          calleeSymbolKey: exactDependency.callee.symbolKey,
        };
        Object.defineProperties(dependency, {
          _callee: { value: exactDependency.callee },
          _calleeActiveInitializerIndexes: {
            value: exactDependency.activeInitializerIndexes,
          },
          _parameterInitializerIndex: {
            value: record._parameterInitializerIndex ?? undefined,
          },
        });
        record._dependencies.push(dependency);
        record.localDependencies.push({
          edgeKey: dependency.edgeKey,
          argumentIndex: dependency.argumentIndex,
          parameterSymbolKey: dependency.parameterSymbolKey,
          calleeSymbolKey: dependency.calleeSymbolKey,
        });
      } else {
        addEvidence(
          record,
          filePath,
          node,
          "non-exact transaction argument mapping",
        );
      }
      for (const candidate of capabilityArguments) {
        markCapabilityConsumed(
          candidate.argument,
          capabilityBindings,
          lexicalBindings,
          consumed,
        );
      }
      return;
    }

    if (ts.isNewExpression(node)) {
      const capabilities = [
        ...capabilityIdentifiers(
          node.expression,
          capabilityBindings,
          lexicalBindings,
          consumed,
        ),
        ...(node.arguments?.flatMap((argument) =>
          capabilityIdentifiers(argument, capabilityBindings, lexicalBindings, consumed)) ?? []),
      ];
      if (capabilities.length > 0) {
        addEvidence(record, filePath, node, "non-exact transaction argument mapping");
        markCapabilityConsumed(
          node.expression,
          capabilityBindings,
          lexicalBindings,
          consumed,
        );
        for (const argument of node.arguments ?? []) {
          markCapabilityConsumed(argument, capabilityBindings, lexicalBindings, consumed);
        }
      } else if (record._parameterInitializerIndex !== null) {
        addEvidence(
          record,
          filePath,
          node,
          "parameter initializer construction has unknown effects",
        );
      }
      return;
    }

    if (ts.isTaggedTemplateExpression(node)) {
      const capabilities = [
        ...capabilityIdentifiers(
          node.tag,
          capabilityBindings,
          lexicalBindings,
          consumed,
        ),
        ...(ts.isTemplateExpression(node.template)
          ? node.template.templateSpans.flatMap((span) =>
            capabilityIdentifiers(
              span.expression,
              capabilityBindings,
              lexicalBindings,
              consumed,
             ))
          : []),
      ];
      if (capabilities.length > 0 || record._parameterInitializerIndex !== null) {
        addEvidence(record, filePath, node, "non-exact transaction argument mapping");
        markCapabilityConsumed(
          node.tag,
          capabilityBindings,
          lexicalBindings,
          consumed,
        );
        if (ts.isTemplateExpression(node.template)) {
          for (const span of node.template.templateSpans) {
            markCapabilityConsumed(
              span.expression,
              capabilityBindings,
              lexicalBindings,
              consumed,
            );
          }
        }
      }
    }
  }
  for (let index = 0; index < record._node.parameters.length; index += 1) {
    const initializer = record._node.parameters[index].initializer;
    if (!initializer) continue;
    record._parameterInitializerIndex = index;
    visit(initializer);
  }
  record._parameterInitializerIndex = null;
  visit(record._node.body);

  function residual(node) {
    if (node !== record._node.body && ts.isFunctionLike(node)) return;
    if (
      ts.isIdentifier(node) &&
      !isDeclarationIdentifier(node) &&
      capabilityBindings.has(lexicalBindings.declarationFor(node)) &&
      !consumed.has(node)
    ) {
      addEvidence(
        record,
        filePath,
        node,
        "unclassified transaction/query capability use",
      );
      consumed.add(node);
    }
    ts.forEachChild(node, residual);
  }
  for (let index = 0; index < record._node.parameters.length; index += 1) {
    const initializer = record._node.parameters[index].initializer;
    if (!initializer) continue;
    record._parameterInitializerIndex = index;
    residual(initializer);
  }
  record._parameterInitializerIndex = null;
  residual(record._node.body);
  record.localDependencies.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
  record.directReadRoots = [...new Set(record.directReadRoots)].sort();
  record.terminalAwaits = [...new Set(record.terminalAwaits)].sort();
  record.evidence.sort((left, right) =>
    left.nodeKey.localeCompare(right.nodeKey) || left.message.localeCompare(right.message));
}

function classifyFunctionGraph(records) {
  const ordered = [...records].sort((left, right) =>
    left.symbolKey.localeCompare(right.symbolKey));
  let index = 0;
  const indexes = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cyclic = new Set();

  function strongConnect(record) {
    indexes.set(record, index);
    low.set(record, index);
    index += 1;
    stack.push(record);
    onStack.add(record);
    for (const dependency of [...record._dependencies].sort((left, right) =>
      left.calleeSymbolKey.localeCompare(right.calleeSymbolKey))) {
      const callee = dependency._callee;
      if (!indexes.has(callee)) {
        strongConnect(callee);
        low.set(record, Math.min(low.get(record), low.get(callee)));
      } else if (onStack.has(callee)) {
        low.set(record, Math.min(low.get(record), indexes.get(callee)));
      }
    }
    if (low.get(record) !== indexes.get(record)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== record);
    const selfLoop = component.length === 1 &&
      component[0]._dependencies.some((dependency) => dependency._callee === component[0]);
    if (component.length > 1 || selfLoop) {
      for (const member of component) cyclic.add(member);
    }
  }
  for (const record of ordered) {
    if (!indexes.has(record)) strongConnect(record);
  }

  const memo = new Map();
  for (const record of ordered) {
    record.classification = classifyFunctionInvocation(
      record,
      null,
      memo,
      new Set(),
    );
  }
  return cyclic;
}

function projectorSummary(record, filePath, lexicalBindings) {
  const functionLike = record._node;
  if (!ts.isBlock(functionLike.body)) return null;
  const rowsParameter = functionLike.parameters.find((parameter) =>
    ts.isIdentifier(parameter.name) && parameter.name.text === "rows");
  if (!rowsParameter) return null;
  let guard = null;
  let emptyReturn = null;
  let mapReturn = null;
  for (const statement of functionLike.body.statements) {
    if (ts.isIfStatement(statement)) {
      const condition = unwrap(statement.expression);
      if (
        !statement.elseStatement &&
        ts.isBinaryExpression(condition) &&
        condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isPropertyAccessExpression(condition.left) &&
        ts.isIdentifier(condition.left.expression) &&
        condition.left.expression.text === "rows" &&
        condition.left.name.text === "length" &&
        ts.isNumericLiteral(condition.right) &&
        condition.right.text === "0"
      ) {
        const returnStatement = ts.isReturnStatement(statement.thenStatement)
          ? statement.thenStatement
          : ts.isBlock(statement.thenStatement) &&
              statement.thenStatement.statements.length === 1 &&
              ts.isReturnStatement(statement.thenStatement.statements[0])
            ? statement.thenStatement.statements[0]
            : null;
        if (
          returnStatement?.expression &&
          ts.isArrayLiteralExpression(unwrap(returnStatement.expression)) &&
          unwrap(returnStatement.expression).elements.length === 0
        ) {
          guard = statement;
          emptyReturn = unwrap(returnStatement.expression);
        }
      }
    }
    if (ts.isReturnStatement(statement) && statement.expression) {
      const expression = unwrap(statement.expression);
      if (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === "rows" &&
        expression.expression.name.text === "map"
      ) {
        mapReturn = expression;
      }
    }
  }
  let spread = null;
  let noIdOverwrite = false;
  if (mapReturn?.arguments.length === 1) {
    const callback = unwrap(mapReturn.arguments[0]);
    if (
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      callback.parameters.length === 1 &&
      ts.isIdentifier(callback.parameters[0].name)
    ) {
      const rowName = callback.parameters[0].name.text;
      let returned = ts.isBlock(callback.body)
        ? directFunctionReturns(callback)[0]
        : callback.body;
      returned = returned ? unwrap(returned) : null;
      if (returned && ts.isObjectLiteralExpression(returned)) {
        const spreadIndex = returned.properties.findIndex(
          (property) =>
            ts.isSpreadAssignment(property) &&
            ts.isIdentifier(unwrap(property.expression)) &&
            unwrap(property.expression).text === rowName,
        );
        if (spreadIndex >= 0) {
          spread = returned.properties[spreadIndex];
          noIdOverwrite = returned.properties.slice(spreadIndex + 1).every((property) =>
            !ts.isSpreadAssignment(property) &&
            Boolean(property.name) &&
            !ts.isComputedPropertyName(property.name) &&
            literalName(property.name) !== "id");
        }
      }
    }
  }
  const dependencyCallKeys = new Set(
    record._dependencies.map((dependency) => dependency.edgeKey.split("|")[1]),
  );
  const allowedMapCalls = new Set();
  let forbiddenRowsUse = false;

  function isSetupMap(call) {
    const declaration = call.parent;
    return (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === call &&
      ts.isIdentifier(declaration.name) &&
      isConstDeclaration(declaration)
    );
  }

  function within(node, ancestor) {
    return Boolean(ancestor && node.pos >= ancestor.pos && node.end <= ancestor.end);
  }

  function scanRows(node) {
    if (forbiddenRowsUse) return;
    if (
      ts.isIdentifier(node) &&
      node !== rowsParameter.name &&
      lexicalBindings.declarationFor(node) === rowsParameter.name
    ) {
      const parent = node.parent;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "length" &&
        within(parent, guard)
      ) {
        return;
      }
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "map" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        (parent.parent === mapReturn || isSetupMap(parent.parent))
      ) {
        allowedMapCalls.add(parent.parent);
        return;
      }
      if (
        ts.isCallExpression(parent) &&
        parent.arguments.some((argument) => unwrap(argument) === node) &&
        dependencyCallKeys.has(nodeKey(filePath, parent))
      ) {
        return;
      }
      forbiddenRowsUse = true;
      return;
    }
    ts.forEachChild(node, scanRows);
  }
  scanRows(functionLike.body);

  function isMutatedOrInvoked(access) {
    let current = access;
    while (
      (ts.isPropertyAccessExpression(current.parent) ||
        ts.isElementAccessExpression(current.parent)) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    const parent = current.parent;
    return (
      (
        ts.isBinaryExpression(parent) &&
        parent.left === current &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) ||
      (
        (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        parent.operand === current &&
        (
          parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken
        )
      ) ||
      (ts.isDeleteExpression(parent) && parent.expression === current) ||
      (ts.isCallExpression(parent) && parent.expression === current)
    );
  }

  for (const mapCall of allowedMapCalls) {
    const callback = mapCall.arguments.length === 1
      ? unwrap(mapCall.arguments[0])
      : null;
    if (
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      callback.parameters.length !== 1 ||
      !ts.isIdentifier(callback.parameters[0].name)
    ) {
      forbiddenRowsUse = true;
      break;
    }
    const rowBinding = callback.parameters[0].name;
    function scanRow(node) {
      if (forbiddenRowsUse) return;
      if (
        ts.isIdentifier(node) &&
        node !== rowBinding &&
        lexicalBindings.declarationFor(node) === rowBinding
      ) {
        for (let current = node.parent; current && current !== callback; current = current.parent) {
          if (ts.isFunctionLike(current)) {
            forbiddenRowsUse = true;
            return;
          }
        }
        const parent = node.parent;
        if (
          mapCall === mapReturn &&
          spread &&
          ts.isSpreadAssignment(parent) &&
          parent === spread
        ) {
          return;
        }
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          !isMutatedOrInvoked(parent)
        ) {
          return;
        }
        forbiddenRowsUse = true;
        return;
      }
      ts.forEachChild(node, scanRow);
    }
    scanRow(callback.body);
  }

  const acceptedReadRoots = new Set(record.directReadRoots);
  const allowedReadCalls = new Set();
  function collectAcceptedReadCalls(node) {
    if (
      ts.isCallExpression(node) &&
      acceptedReadRoots.has(nodeKey(filePath, node))
    ) {
      let current = node;
      allowedReadCalls.add(current);
      while (
        ts.isPropertyAccessExpression(current.parent) &&
        current.parent.expression === current &&
        ts.isCallExpression(current.parent.parent) &&
        current.parent.parent.expression === current.parent
      ) {
        current = current.parent.parent;
        allowedReadCalls.add(current);
      }
    }
    ts.forEachChild(node, collectAcceptedReadCalls);
  }
  collectAcceptedReadCalls(functionLike.body);

  const allowedStructuralCalls = new Set();
  function collectStructuralCalls(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const promiseReceiver =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "all" &&
        ts.isIdentifier(unwrap(callee.expression)) &&
        unwrap(callee.expression).text === "Promise" &&
        !lexicalBindings.declarationFor(unwrap(callee.expression));
      const values =
        node.arguments.length === 1 &&
        ts.isArrayLiteralExpression(unwrap(node.arguments[0]))
          ? unwrap(node.arguments[0])
          : null;
      const exactDependencyAggregate =
        promiseReceiver &&
        values &&
        values.elements.length > 0 &&
        values.elements.every((element) =>
          ts.isCallExpression(unwrap(element)) &&
          dependencyCallKeys.has(nodeKey(filePath, unwrap(element)))) &&
        ts.isAwaitExpression(node.parent) &&
        ts.isVariableDeclaration(node.parent.parent) &&
        node.parent.parent.initializer === node.parent &&
        isConstDeclaration(node.parent.parent);
      if (exactDependencyAggregate) allowedStructuralCalls.add(node);
    }
    ts.forEachChild(node, collectStructuralCalls);
  }
  collectStructuralCalls(functionLike.body);

  const statements = [...functionLike.body.statements];
  const guardIndex = statements.indexOf(guard);
  const mapReturnStatement = mapReturn
    ? directBodyStatement(mapReturn, functionLike)
    : null;
  const mapReturnIndex = statements.indexOf(mapReturnStatement);
  let setupEffectSafe =
    guardIndex === 0 &&
    mapReturnIndex === statements.length - 1 &&
    mapReturnIndex > guardIndex;
  const allowedCalls = new Set([
    ...allowedMapCalls,
    ...allowedReadCalls,
    ...allowedStructuralCalls,
  ]);
  function scanSetupEffect(node) {
    if (!setupEffectSafe) return;
    if (ts.isFunctionLike(node)) {
      const ownerCall =
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        ts.isCallExpression(node.parent) &&
        allowedMapCalls.has(node.parent) &&
        node.parent.arguments.includes(node);
      if (!ownerCall) {
        setupEffectSafe = false;
        return;
      }
    }
    if (
      ts.isCallExpression(node) &&
      !allowedCalls.has(node) &&
      !dependencyCallKeys.has(nodeKey(filePath, node))
    ) {
      setupEffectSafe = false;
      return;
    }
    if (
      (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) ||
      (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (
          node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken
        )
      ) ||
      ts.isDeleteExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isYieldExpression(node)
    ) {
      setupEffectSafe = false;
      return;
    }
    ts.forEachChild(node, scanSetupEffect);
  }
  if (setupEffectSafe) {
    for (const statement of statements.slice(guardIndex + 1, mapReturnIndex)) {
      const structuralStatement =
        (
          ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
          statement.declarationList.declarations.every((declaration) =>
            Boolean(declaration.initializer))
        ) ||
        ts.isExpressionStatement(statement);
      if (!structuralStatement) {
        setupEffectSafe = false;
        break;
      }
      scanSetupEffect(statement);
    }
  }

  const proofNodes = [
    guard,
    emptyReturn,
    mapReturn,
    spread,
    ...record.directReadRoots.map(() => null),
  ].filter(Boolean).map((node) => nodeKey(filePath, node));
  proofNodes.push(...record.directReadRoots, ...record.terminalAwaits);
  for (const dependency of record._dependencies) {
    proofNodes.push(dependency.edgeKey.split("|")[1]);
    proofNodes.push(...dependency._callee.directReadRoots, ...dependency._callee.terminalAwaits);
  }
  const eligible =
    Boolean(guard && emptyReturn && mapReturn && spread && noIdOverwrite) &&
    !forbiddenRowsUse &&
    setupEffectSafe &&
    record.classification === "READ_ONLY";
  const summary = {
    name: record.name,
    symbolKey: record.symbolKey,
    eligible,
    emptyGuard: Boolean(guard && emptyReturn),
    cardinality: mapReturn ? "PRESERVED" : "UNKNOWN",
    identityPreserving: Boolean(spread && noIdOverwrite),
    noIdOverwrite,
    transactionEffect:
      record.classification === "READ_ONLY" && setupEffectSafe
        ? "read-only"
        : "unknown",
    proofNodes: [...new Set(proofNodes)].sort(),
  };
  Object.defineProperties(summary, {
    _record: { value: record },
    _structurallyEligible: {
      value:
        Boolean(guard && emptyReturn && mapReturn && spread && noIdOverwrite) &&
        !forbiddenRowsUse &&
        setupEffectSafe,
    },
  });
  return summary;
}

function analyzeTransactionSourceFile(
  filePath,
  sourceFile,
  {
    resolveNamedImport = null,
    resolveModuleSource = null,
    aliasState = null,
  } = {},
) {
  const state = aliasState ?? collectTableAliases(sourceFile, filePath, resolveNamedImport);
  const registry = createFunctionRegistry(sourceFile, filePath, state.lexicalBindings);
  const transactionParameters = selectTransactionParameters(
    registry,
    state.lexicalBindings,
  );
  for (const record of registry.records) {
    const parameters = [...transactionParameters.get(record)];
    if (parameters.length > 1) {
      addEvidence(
        record,
        filePath,
        record._node,
        "non-exact transaction argument mapping",
      );
      continue;
    }
    analyzeFunctionFacts(
      record,
      filePath,
      registry,
      state.lexicalBindings,
      state.assigned,
      state.helperAliases,
      parameters[0] ?? null,
    );
  }
  const cyclic = classifyFunctionGraph(registry.records);
  const projectors = registry.records
    .map((record) => projectorSummary(record, filePath, state.lexicalBindings))
    .filter(Boolean)
    .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
  const analysis = {
    path: normalizePath(filePath),
    functions: [...registry.records].sort((left, right) =>
      left.symbolKey.localeCompare(right.symbolKey)),
    projectors,
    cyclicSymbolKeys: [...cyclic].map((record) => record.symbolKey).sort(),
  };
  Object.defineProperties(analysis, {
    _sourceFile: { value: sourceFile },
    _registry: { value: registry },
    _aliasState: { value: state },
    _resolveNamedImport: { value: resolveNamedImport },
    _resolveModuleSource: { value: resolveModuleSource },
  });
  return analysis;
}

export function analyzeTransactionContractFromSource(
  filePath,
  source,
  { resolveNamedImport = null, resolveModuleSource = null } = {},
) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return analyzeTransactionSourceFile(filePath, sourceFile, {
    resolveNamedImport,
    resolveModuleSource,
  });
}

function enclosingFunctionRecord(node, analysis) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      const record = analysis._registry.byExecutable.get(current);
      if (record) return record;
    }
  }
  return null;
}

function trustedHelperResolution(call, analysis, helperExport) {
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee)) return null;
  const binding = analysis._aliasState.lexicalBindings.declarationFor(callee);
  const resolution = binding
    ? analysis._aliasState.lexicalBindings.resolutions.get(binding)
    : analysis._aliasState.helperAliases.get(callee.text);
  return resolution?.kind === "helper" &&
    resolution.helper === helperExport &&
    isTrustedHelperPair({
      helperExport: resolution.helper,
      helperPath: resolution.helperPath,
    })
    ? resolution
    : null;
}

function trustedMutationForCallback(functionLike, analysis) {
  const property = functionLike.parent;
  if (
    !ts.isPropertyAssignment(property) ||
    literalName(property.name) !== "mutate" ||
    !ts.isObjectLiteralExpression(property.parent) ||
    !ts.isCallExpression(property.parent.parent)
  ) {
    return null;
  }
  const call = property.parent.parent;
  const helper = trustedHelperResolution(call, analysis, "runIssueMutation");
  return helper ? { call, helper } : null;
}

function exactArgumentBinding(argument, analysis) {
  const current = unwrap(argument);
  return ts.isIdentifier(current)
    ? analysis._aliasState.lexicalBindings.declarationFor(current)
    : null;
}

function terminatingNonNullGuard(functionLike, binding, after, before = Infinity) {
  let result = null;
  function visit(node) {
    if (result || node.pos >= before) return;
    if (node !== functionLike.body && ts.isFunctionLike(node)) return;
    if (node.pos > after && ts.isIfStatement(node)) {
      const condition = unwrap(node.expression);
      const guarded =
        ts.isPrefixUnaryExpression(condition) &&
        condition.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isIdentifier(unwrap(condition.operand)) &&
        unwrap(condition.operand).text === binding.text;
      const terminates =
        ts.isReturnStatement(node.thenStatement) ||
        ts.isThrowStatement(node.thenStatement) ||
        (
          ts.isBlock(node.thenStatement) &&
          node.thenStatement.statements.some((statement) =>
            ts.isReturnStatement(statement) || ts.isThrowStatement(statement))
        );
      if (guarded && terminates) {
        result = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(functionLike.body);
  return result;
}

function immediateAwaitedCall(declaration) {
  if (!declaration?.initializer) return null;
  let current = unwrap(declaration.initializer);
  if (!ts.isAwaitExpression(current)) return null;
  current = unwrap(current.expression);
  return ts.isCallExpression(current) ? current : null;
}

function directBodyStatement(node, functionLike) {
  if (!node || !functionLike?.body || !ts.isBlock(functionLike.body)) return null;
  for (let current = node; current && current !== functionLike.body; current = current.parent) {
    if (current.parent === functionLike.body) {
      return functionLike.body.statements.includes(current) ? current : null;
    }
  }
  return null;
}

function isExactConsecutiveStatementSequence(functionLike, nodes) {
  if (!functionLike?.body || !ts.isBlock(functionLike.body)) return false;
  const statements = nodes.map((node) => directBodyStatement(node, functionLike));
  if (statements.some((statement) => !statement)) return false;
  const indexes = statements.map((statement) => functionLike.body.statements.indexOf(statement));
  return indexes.every((index, position) =>
    index >= 0 && (position === 0 || index === indexes[position - 1] + 1));
}

function singletonMutationIssue(argument, mutationBinding) {
  const current = unwrap(argument);
  if (!ts.isArrayLiteralExpression(current) || current.elements.length !== 1) return false;
  const element = unwrap(current.elements[0]);
  return (
    ts.isPropertyAccessExpression(element) &&
    ts.isIdentifier(element.expression) &&
    element.expression.text === mutationBinding.text &&
    element.name.text === "issue"
  );
}

function memberCompletionProof(memberCall, transactionBinding, analysis) {
  const memberExpression = unwrap(memberCall.expression);
  if (
    !ts.isPropertyAccessExpression(memberExpression) ||
    !ts.isCallExpression(unwrap(memberExpression.expression))
  ) {
    return null;
  }
  const factoryCall = unwrap(memberExpression.expression);
  const factory = analysis._registry.resolveCallee(factoryCall.expression);
  const factoryParameter = factory?._parameter;
  const factoryParameterIndex = factoryParameter
    ? factory._node.parameters.indexOf(factoryParameter)
    : -1;
  if (
    !factory ||
    factoryParameterIndex < 0 ||
    factoryParameterIndex >= factoryCall.arguments.length ||
    exactArgumentBinding(factoryCall.arguments[factoryParameterIndex], analysis) !==
      transactionBinding
  ) {
    return null;
  }
  const factoryInitializerPlan = parameterInitializerExecutionPlan(
    factoryCall,
    factory._node,
    new Set([transactionBinding]),
    analysis._aliasState.lexicalBindings,
    { exactCapabilityArgumentIndexes: new Set([factoryParameterIndex]) },
  );
  if (
    !factoryInitializerPlan ||
    !activeParameterInitializersAreReadOnly(factory, factoryInitializerPlan)
  ) {
    return null;
  }
  const member = analysis._registry.resolveCallee(memberCall.expression);
  if (!member || !member._parameter || !ts.isIdentifier(member._parameter.name)) return null;
  const memberParameterIndex = member._node.parameters.indexOf(member._parameter);
  if (
    memberParameterIndex < 0 ||
    memberParameterIndex >= memberCall.arguments.length ||
    exactArgumentBinding(memberCall.arguments[memberParameterIndex], analysis) !==
      transactionBinding
  ) {
    return null;
  }
  const memberInitializerPlan = parameterInitializerExecutionPlan(
    memberCall,
    member._node,
    new Set([transactionBinding]),
    analysis._aliasState.lexicalBindings,
    { exactCapabilityArgumentIndexes: new Set([memberParameterIndex]) },
  );
  if (
    !memberInitializerPlan ||
    !activeParameterInitializersAreReadOnly(member, memberInitializerPlan)
  ) {
    return null;
  }

  const helperCalls = [];
  function collect(node) {
    if (node !== member._node.body && ts.isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      trustedHelperResolution(node, analysis, "runIssueMutation")
    ) {
      helperCalls.push(node);
    }
    ts.forEachChild(node, collect);
  }
  collect(member._node.body);
  if (helperCalls.length !== 1) return null;
  const helperCall = helperCalls[0];
  if (
    helperCall.arguments.length < 2 ||
    exactArgumentBinding(helperCall.arguments[0], analysis) !== member._parameter.name
  ) {
    return null;
  }
  const helperDeclaration = helperCall.parent && ts.isAwaitExpression(helperCall.parent)
    ? helperCall.parent.parent
    : null;
  if (
    !helperDeclaration ||
    !ts.isVariableDeclaration(helperDeclaration) ||
    !ts.isIdentifier(helperDeclaration.name)
  ) {
    return null;
  }
  const mutationBinding = helperDeclaration.name;
  let projectorBeforeHelper = false;
  function findEarlierProjector(node) {
    if (projectorBeforeHelper || node.pos >= helperCall.pos) return;
    if (node !== member._node.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const candidate = analysis._registry.resolveCallee(node.expression);
      if (
        candidate &&
        analysis.projectors.some((summary) =>
          summary.symbolKey === candidate.symbolKey && summary.eligible)
      ) {
        projectorBeforeHelper = true;
        return;
      }
    }
    ts.forEachChild(node, findEarlierProjector);
  }
  findEarlierProjector(member._node.body);
  if (projectorBeforeHelper) return null;
  const helperGuard = terminatingNonNullGuard(
    member._node,
    mutationBinding,
    helperCall.end,
  );
  if (!helperGuard) return null;

  let projectorCall = null;
  let projector = null;
  function findProjector(node) {
    if (projectorCall) return;
    if (node !== member._node.body && ts.isFunctionLike(node)) return;
    if (
      node.pos > helperGuard.pos &&
      ts.isCallExpression(node) &&
      node.arguments.length >= 2
    ) {
      const candidate = analysis._registry.resolveCallee(node.expression);
      const summary = candidate
        ? analysis.projectors.find((item) => item.symbolKey === candidate.symbolKey)
        : null;
      const transactionIndex = candidate?._node.parameters.indexOf(candidate._parameter) ?? -1;
      const rowsIndex = candidate?._node.parameters.findIndex((parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === "rows") ?? -1;
      const initializerPlan =
        candidate && transactionIndex >= 0
          ? parameterInitializerExecutionPlan(
              node,
              candidate._node,
              new Set([member._parameter.name]),
              analysis._aliasState.lexicalBindings,
              {
                exactCapabilityArgumentIndexes: new Set([transactionIndex]),
                assigned: analysis._aliasState.assigned,
              },
            )
          : null;
      if (
        summary?._structurallyEligible &&
        initializerPlan &&
        classifyFunctionInvocation(candidate, initializerPlan) === "READ_ONLY" &&
        transactionIndex >= 0 &&
        rowsIndex >= 0 &&
        exactArgumentBinding(node.arguments[transactionIndex], analysis) ===
          member._parameter.name &&
        singletonMutationIssue(node.arguments[rowsIndex], mutationBinding)
      ) {
        projectorCall = node;
        projector = summary;
        return;
      }
    }
    ts.forEachChild(node, findProjector);
  }
  findProjector(member._node.body);
  if (!projectorCall || !projector) return null;

  const projectorAwait = projectorCall.parent;
  const projectorDeclaration =
    projectorAwait && ts.isAwaitExpression(projectorAwait)
      ? projectorAwait.parent
      : null;
  if (
    !projectorDeclaration ||
    !ts.isVariableDeclaration(projectorDeclaration) ||
    projectorDeclaration.initializer !== projectorAwait ||
    !isConstDeclaration(projectorDeclaration) ||
    !ts.isVariableDeclarationList(projectorDeclaration.parent) ||
    projectorDeclaration.parent.declarations.length !== 1 ||
    !ts.isArrayBindingPattern(projectorDeclaration.name) ||
    projectorDeclaration.name.elements.length !== 1
  ) {
    return null;
  }
  const projectedElement = projectorDeclaration.name.elements[0];
  if (
    !ts.isBindingElement(projectedElement) ||
    projectedElement.dotDotDotToken ||
    projectedElement.propertyName ||
    projectedElement.initializer ||
    !ts.isIdentifier(projectedElement.name) ||
    analysis._aliasState.assigned.has(projectedElement.name)
  ) {
    return null;
  }
  const projectedBinding = projectedElement.name;
  const returnProofNodes = [];
  let projectedReturnCount = 0;
  let invalidReturn = false;
  function collectReturns(node) {
    if (invalidReturn || (node !== member._node.body && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node)) {
      const inHelperGuard =
        node.pos >= helperGuard.pos &&
        node.end <= helperGuard.end;
      if (inHelperGuard) {
        if (!node.expression || unwrap(node.expression).kind !== ts.SyntaxKind.NullKeyword) {
          invalidReturn = true;
        }
      } else if (
        node.pos > projectorCall.end &&
        node.expression &&
        exactBindingIdentifier(
          node.expression,
          projectedBinding,
          analysis._aliasState.lexicalBindings,
        )
      ) {
        projectedReturnCount += 1;
        returnProofNodes.push(node);
      } else {
        invalidReturn = true;
      }
      return;
    }
    ts.forEachChild(node, collectReturns);
  }
  collectReturns(member._node.body);
  if (
    invalidReturn ||
    projectedReturnCount !== 1 ||
    !isExactConsecutiveStatementSequence(member._node, [
      helperCall,
      helperGuard,
      projectorCall,
      returnProofNodes[0],
    ])
  ) {
    return null;
  }

  const forbiddenBeforeCompletion = member.evidence.some((evidence) => {
    const position = Number(/#(\d+):/.exec(evidence.nodeKey)?.[1] ?? -1);
    return position > member._node.body.pos && position < helperCall.pos;
  });
  if (forbiddenBeforeCompletion) return null;

  return {
    member,
    proofNodes: [
      nodeKey(analysis.path, helperCall),
      nodeKey(analysis.path, helperGuard),
      nodeKey(analysis.path, projectorCall),
      ...returnProofNodes.map((node) => nodeKey(analysis.path, node)),
      ...projector.proofNodes,
    ],
  };
}

function canonicalCertificate(certificate) {
  return canonicalize({
    ...certificate,
    proofNodes: [...new Set(certificate.proofNodes)].sort(),
    ...(certificate.coverageScopeKeys
      ? { coverageScopeKeys: [...new Set(certificate.coverageScopeKeys)].sort() }
      : {}),
    ...(certificate.normalExitKeys
      ? { normalExitKeys: [...new Set(certificate.normalExitKeys)].sort() }
      : {}),
    ...(certificate.proofRoles
      ? { proofRoles: [...new Set(certificate.proofRoles)].sort() }
      : {}),
    ...(certificate.memberProofNodes
      ? { memberProofNodes: [...new Set(certificate.memberProofNodes)].sort() }
      : {}),
  });
}

function certificateSort(left, right) {
  return (
    left.edgeKey.localeCompare(right.edgeKey) ||
    left.sinkKey.localeCompare(right.sinkKey) ||
    left.authority.localeCompare(right.authority) ||
    left.transactionRoot.localeCompare(right.transactionRoot) ||
    left.issueKeyEvidence.localeCompare(right.issueKeyEvidence) ||
    left.helperPath.localeCompare(right.helperPath) ||
    left.helperExport.localeCompare(right.helperExport) ||
    (left.obligationKey ?? "").localeCompare(right.obligationKey ?? "") ||
    (left.scopeKind ?? "").localeCompare(right.scopeKind ?? "") ||
    (left.coverageKind ?? "").localeCompare(right.coverageKind ?? "") ||
    JSON.stringify(left.coverageScopeKeys ?? []).localeCompare(
      JSON.stringify(right.coverageScopeKeys ?? []),
    ) ||
    JSON.stringify(left.normalExitKeys ?? []).localeCompare(
      JSON.stringify(right.normalExitKeys ?? []),
    ) ||
    JSON.stringify(left.proofNodes).localeCompare(JSON.stringify(right.proofNodes))
  );
}

function certificateForLexicalCall(call, write, sinkRecord, analysis) {
  for (let current = call.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const trusted = trustedMutationForCallback(current, analysis);
    if (!trusted) return null;
    if (
      current.parameters.length < 2 ||
      !ts.isIdentifier(current.parameters[0].name) ||
      !ts.isIdentifier(current.parameters[1].name) ||
      call.arguments.length < 2 ||
      exactArgumentBinding(call.arguments[0], analysis) !== current.parameters[0].name ||
      exactArgumentBinding(call.arguments[1], analysis) !== current.parameters[1].name
    ) {
      return null;
    }
    const caller = analysis._registry.byExecutable.get(current) ??
      enclosingFunctionRecord(call, analysis);
    const edgeKey =
      `${caller.symbolKey}|${nodeKey(analysis.path, call)}|${sinkRecord.symbolKey}`;
    return canonicalCertificate({
      edgeKey,
      sinkKey: write.sinkKey,
      callerSymbolKey: caller.symbolKey,
      calleeSymbolKey: sinkRecord.symbolKey,
      callSite: nodeKey(analysis.path, call),
      table: write.table,
      operation: write.operation,
      authority: "runIssueMutation:lexical",
      transactionRoot: symbolKey(analysis.path, current.parameters[0]),
      issueKeyEvidence: symbolKey(analysis.path, current.parameters[1]),
      helperExport: "runIssueMutation",
      helperPath: trusted.helper.helperPath,
      proofNodes: [
        nodeKey(analysis.path, trusted.call),
        nodeKey(analysis.path, call),
      ],
    });
  }
  return null;
}

function certificateForSequentialCall(call, write, sinkRecord, analysis) {
  const caller = enclosingFunctionRecord(call, analysis);
  if (
    !caller ||
    call.arguments.length < 2 ||
    !ts.isIdentifier(unwrap(call.arguments[0])) ||
    !ts.isIdentifier(unwrap(call.arguments[1]))
  ) {
    return null;
  }
  const transactionBinding = exactArgumentBinding(call.arguments[0], analysis);
  const issueBinding = exactArgumentBinding(call.arguments[1], analysis);
  if (!transactionBinding || !issueBinding) return null;
  const issueDeclaration = issueBinding.parent;
  if (!ts.isVariableDeclaration(issueDeclaration)) return null;
  const memberCall = immediateAwaitedCall(issueDeclaration);
  if (!memberCall || memberCall.end >= call.pos) return null;
  const callerGuard = terminatingNonNullGuard(
    caller._node,
    issueBinding,
    memberCall.end,
    call.pos,
  );
  if (!callerGuard) return null;
  const completion = memberCompletionProof(memberCall, transactionBinding, analysis);
  if (!completion) return null;
  const callResult = call.parent && ts.isAwaitExpression(call.parent)
    ? call.parent
    : call;
  const callConsumer = callResult.parent;
  const directSink =
    (
      ts.isReturnStatement(callConsumer) &&
      callConsumer.expression === callResult
    ) ||
    (
      ts.isVariableDeclaration(callConsumer) &&
      callConsumer.initializer === callResult &&
      ts.isIdentifier(callConsumer.name) &&
      isConstDeclaration(callConsumer) &&
      !analysis._aliasState.assigned.has(callConsumer.name)
    );
  if (
    !directSink ||
    !isExactConsecutiveStatementSequence(caller._node, [
      issueDeclaration,
      callerGuard,
      callConsumer,
    ])
  ) {
    return null;
  }
  const edgeKey =
    `${caller.symbolKey}|${nodeKey(analysis.path, call)}|${sinkRecord.symbolKey}`;
  return canonicalCertificate({
    edgeKey,
    sinkKey: write.sinkKey,
    callerSymbolKey: caller.symbolKey,
    calleeSymbolKey: sinkRecord.symbolKey,
    callSite: nodeKey(analysis.path, call),
    table: write.table,
    operation: write.operation,
    authority: "runIssueMutation:same_transaction",
    transactionRoot: symbolKey(analysis.path, transactionBinding),
    issueKeyEvidence: symbolKey(analysis.path, issueBinding),
    helperExport: "runIssueMutation",
    helperPath: "server/src/services/issue-versioning.ts",
    proofNodes: [
      ...completion.proofNodes,
      nodeKey(analysis.path, memberCall),
      nodeKey(analysis.path, callerGuard),
      nodeKey(analysis.path, call),
    ],
  });
}

function certificateForDirectTrustedSink(write, analysis) {
  const callback = (() => {
    for (let current = write._node.parent; current; current = current.parent) {
      if (ts.isFunctionLike(current)) return current;
    }
    return null;
  })();
  if (!callback || callback.parameters.length === 0) return null;
  const trusted = trustedMutationForCallback(callback, analysis);
  const caller = analysis._registry.byExecutable.get(callback);
  const transaction = callback.parameters.find((parameter) =>
    ts.isIdentifier(parameter.name));
  if (!trusted || !caller || !transaction) return null;
  return canonicalCertificate({
    edgeKey:
      `${caller.symbolKey}|${nodeKey(analysis.path, trusted.call)}|${caller.symbolKey}`,
    sinkKey: write.sinkKey,
    callerSymbolKey: caller.symbolKey,
    calleeSymbolKey: caller.symbolKey,
    callSite: nodeKey(analysis.path, trusted.call),
    table: write.table,
    operation: write.operation,
    authority: "runIssueMutation:lexical",
    transactionRoot: symbolKey(analysis.path, transaction),
    issueKeyEvidence: nodeKey(analysis.path, trusted.call.arguments[1] ?? trusted.call),
    helperExport: "runIssueMutation",
    helperPath: trusted.helper.helperPath,
    proofNodes: [
      nodeKey(analysis.path, trusted.call),
      nodeKey(analysis.path, write._node),
    ],
  });
}

function exactObjectPropertyValue(expression, propertyName) {
  const object = unwrap(expression);
  if (!ts.isObjectLiteralExpression(object)) return null;
  let value = null;
  for (const property of object.properties) {
    if (
      ts.isSpreadAssignment(property) ||
      !property.name ||
      ts.isComputedPropertyName(property.name)
    ) {
      return null;
    }
    if (literalName(property.name) !== propertyName) continue;
    if (value) return null;
    if (ts.isPropertyAssignment(property)) value = property.initializer;
    else if (ts.isShorthandPropertyAssignment(property)) value = property.name;
    else return null;
  }
  return value;
}

function exactIssueIdentity(expression, analysis) {
  const current = unwrap(expression);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return `LIT:${JSON.stringify(current.text)}`;
  }
  if (ts.isIdentifier(current)) {
    const binding = analysis._aliasState.lexicalBindings.declarationFor(current);
    if (!binding || analysis._aliasState.assigned.has(binding)) return null;
    const declaration = binding.parent;
    if (ts.isParameter(declaration)) {
      if (
        declaration.name !== binding ||
        declaration.dotDotDotToken ||
        declaration.initializer ||
        declaration.questionToken
      ) {
        return null;
      }
      return `SYM:${symbolKey(analysis.path, binding)}`;
    }
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.name !== binding ||
      !isConstDeclaration(declaration)
    ) {
      return null;
    }
    const initializer = declaration.initializer && unwrap(declaration.initializer);
    if (
      initializer &&
      (
        ts.isIdentifier(initializer) ||
        ts.isPropertyAccessExpression(initializer) ||
        ts.isElementAccessExpression(initializer)
      )
    ) {
      return null;
    }
    return `SYM:${symbolKey(analysis.path, binding)}`;
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const receiver = exactIssueIdentity(current.expression, analysis);
    if (!receiver) return null;
    const segment = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : current.argumentExpression &&
          (
            ts.isStringLiteral(unwrap(current.argumentExpression)) ||
            ts.isNoSubstitutionTemplateLiteral(unwrap(current.argumentExpression))
          )
        ? unwrap(current.argumentExpression).text
        : null;
    return segment === null
      ? null
      : receiver.startsWith("MEM:")
        ? `${receiver}/${JSON.stringify(segment)}`
        : `MEM:${receiver}/${JSON.stringify(segment)}`;
  }
  return null;
}

function exactStableAtom(expression, analysis) {
  const current = unwrap(expression);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return `LIT:${JSON.stringify(current.text)}`;
  }
  if (ts.isIdentifier(current)) {
    const binding = analysis._aliasState.lexicalBindings.declarationFor(current);
    if (!binding || analysis._aliasState.assigned.has(binding)) return null;
    const declaration = binding.parent;
    if (
      ts.isParameter(declaration) &&
      declaration.name === binding &&
      !declaration.dotDotDotToken &&
      !declaration.initializer &&
      !declaration.questionToken
    ) {
      return `SYM:${symbolKey(analysis.path, binding)}`;
    }
    return (
      ts.isVariableDeclaration(declaration) &&
      declaration.name === binding &&
      isConstDeclaration(declaration)
    )
      ? `SYM:${symbolKey(analysis.path, binding)}`
      : null;
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const receiver = exactStableAtom(current.expression, analysis);
    if (!receiver) return null;
    const segment = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : current.argumentExpression &&
          (
            ts.isStringLiteral(unwrap(current.argumentExpression)) ||
            ts.isNoSubstitutionTemplateLiteral(unwrap(current.argumentExpression)) ||
            ts.isNumericLiteral(unwrap(current.argumentExpression))
          )
        ? unwrap(current.argumentExpression).text
        : null;
    return segment === null
      ? null
      : receiver.startsWith("MEM:")
        ? `${receiver}/${JSON.stringify(segment)}`
        : `MEM:${receiver}/${JSON.stringify(segment)}`;
  }
  return null;
}

function scopeRootBinding(expression, analysis) {
  let current = unwrap(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current)
    ? analysis._aliasState.lexicalBindings.declarationFor(current)
    : null;
}

function scopeExpressionStable(
  expression,
  callback,
  analysis,
  start = -Infinity,
  end = Infinity,
  allowedRegions = [],
  transactionBinding = null,
) {
  const root = scopeRootBinding(expression, analysis);
  if (!root || !callback?.body) return Boolean(exactIssueIdentity(expression, analysis));
  const segmentFor = (node) => {
    const current = unwrap(node);
    if (ts.isPropertyAccessExpression(current)) return current.name.text;
    if (!ts.isElementAccessExpression(current) || !current.argumentExpression) {
      return null;
    }
    const argument = unwrap(current.argumentExpression);
    return (
      ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument) ||
      ts.isNumericLiteral(argument)
    )
      ? argument.text
      : null;
  };
  const targetPrefixes = new Set();
  let prefixNode = unwrap(expression);
  while (
    ts.isPropertyAccessExpression(prefixNode) ||
    ts.isElementAccessExpression(prefixNode)
  ) {
    const key = exactStableAtom(prefixNode, analysis);
    if (!key) return false;
    targetPrefixes.add(key);
    prefixNode = unwrap(prefixNode.expression);
  }
  const rootKey = exactStableAtom(prefixNode, analysis);
  if (!rootKey) return false;
  targetPrefixes.add(rootKey);
  const targetKey = exactIssueIdentity(expression, analysis);
  if (!targetKey) return false;

  const aliases = new Map([[root, rootKey]]);
  const ambiguousAliases = new Set();
  const aliasDeclarations = new Set();
  const aliasPath = (node) => {
    const current = unwrap(node);
    if (ts.isIdentifier(current)) {
      return aliases.get(
        analysis._aliasState.lexicalBindings.declarationFor(current),
      ) ?? null;
    }
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return null;
    }
    const receiver = aliasPath(current.expression);
    const segment = segmentFor(current);
    if (!receiver || segment === null) return null;
    const key = receiver.startsWith("MEM:")
      ? `${receiver}/${JSON.stringify(segment)}`
      : `MEM:${receiver}/${JSON.stringify(segment)}`;
    return targetPrefixes.has(key) ? key : null;
  };
  let changed = true;
  while (changed) {
    changed = false;
    function collectAliases(node) {
      if (node !== callback.body && ts.isFunctionLike(node)) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        !aliases.has(node.name)
      ) {
        const key = aliasPath(node.initializer);
        if (key) {
          aliases.set(node.name, key);
          aliasDeclarations.add(node);
          if (
            !isConstDeclaration(node) ||
            analysis._aliasState.assigned.has(node.name)
          ) {
            ambiguousAliases.add(node.name);
          }
          changed = true;
        }
      }
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(callback.body);
  }
  const allowed = new Set(allowedRegions.filter(Boolean));
  const withinAllowed = (node) =>
    [...allowed].some((region) => nodeWithin(node, region));
  const inRegion = (node) => node.pos >= start && node.end <= end;
  const isKnownReadUse = (node) => {
    if (!transactionBinding) return false;
    for (
      let current = node.parent;
      current && current !== callback.body;
      current = current.parent
    ) {
      if (ts.isStatement(current)) return false;
      if (!ts.isCallExpression(current)) continue;
      const chain = expressionCallChain(current);
      const root = chain.find((item) => {
        const receiver = item.receiver && unwrap(item.receiver);
        return (
          ["select", "selectDistinct"].includes(item.name) &&
          receiver &&
          ts.isIdentifier(receiver) &&
          analysis._aliasState.lexicalBindings.declarationFor(receiver) ===
            transactionBinding
        );
      });
      if (
        root &&
        chain.every((item) => {
          const member = callMember(item.call);
          return member && !member.computed && !item.call.questionDotToken;
        })
      ) {
        return true;
      }
    }
    return false;
  };
  const baseAliasBinding = (node) => {
    let current = unwrap(node);
    while (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = unwrap(current.expression);
    }
    return ts.isIdentifier(current)
      ? analysis._aliasState.lexicalBindings.declarationFor(current)
      : null;
  };
  let stable = true;
  function visit(node) {
    if (!stable) return;
    if (node !== callback.body && ts.isFunctionLike(node)) {
      if ([...allowed].some((region) => nodeWithin(region, node))) {
        ts.forEachChild(node, visit);
        return;
      }
      function capture(current) {
        if (!stable) return;
        if (
          inRegion(current) &&
          !withinAllowed(current) &&
          ts.isIdentifier(current) &&
          aliases.has(
            analysis._aliasState.lexicalBindings.declarationFor(current),
          )
        ) {
          stable = false;
          return;
        }
        ts.forEachChild(current, capture);
      }
      capture(node);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      inRegion(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      if (aliases.has(baseAliasBinding(node.left))) {
        stable = false;
        return;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      inRegion(node) &&
      (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      )
    ) {
      if (aliases.has(baseAliasBinding(node.operand))) {
        stable = false;
        return;
      }
    }
    if (
      ts.isDeleteExpression(node) &&
      inRegion(node)
    ) {
      if (aliases.has(baseAliasBinding(node.expression))) {
        stable = false;
        return;
      }
    }
    if (
      ts.isIdentifier(node) &&
      inRegion(node) &&
      !withinAllowed(node)
    ) {
      const binding =
        analysis._aliasState.lexicalBindings.declarationFor(node);
      if (aliases.has(binding)) {
        if (node === binding) {
          ts.forEachChild(node, visit);
          return;
        }
        const declaration = node.parent;
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.name === node
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        if (ambiguousAliases.has(binding)) {
          stable = false;
          return;
        }
        let directPath = node;
        while (
          (
            ts.isPropertyAccessExpression(directPath.parent) ||
            ts.isElementAccessExpression(directPath.parent)
          ) &&
          directPath.parent.expression === directPath
        ) {
          directPath = directPath.parent;
        }
        if (
          binding === root &&
          directPath !== node
        ) {
          const directKey = exactStableAtom(directPath, analysis);
          if (
            directKey &&
            (
              directKey === targetKey ||
              !targetPrefixes.has(directKey)
            )
          ) {
            return;
          }
        }
        let owner = node.parent;
        while (owner && owner !== callback.body) {
          if (
            ts.isVariableDeclaration(owner) &&
            nodeWithin(node, owner.initializer)
          ) {
            if (aliasDeclarations.has(owner) && isConstDeclaration(owner)) break;
            stable = false;
            return;
          }
          if (
            (
              ts.isReturnStatement(owner) ||
              ts.isYieldExpression(owner)
            ) &&
            nodeWithin(node, owner.expression)
          ) {
            stable = false;
            return;
          }
          if (
            ts.isBinaryExpression(owner) &&
            owner.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            owner.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            nodeWithin(node, owner.right)
          ) {
            stable = false;
            return;
          }
          if (
            ts.isCallExpression(owner) ||
            ts.isNewExpression(owner) ||
            ts.isTaggedTemplateExpression(owner)
          ) {
            if (ts.isCallExpression(owner) && isKnownReadUse(node)) break;
            stable = false;
            return;
          }
          if (
            (
              ts.isObjectLiteralExpression(owner) ||
              ts.isArrayLiteralExpression(owner)
            ) &&
            !aliasDeclarations.has(owner.parent)
          ) {
            stable = false;
            return;
          }
          if (ts.isStatement(owner)) break;
          owner = owner.parent;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return stable;
}

function nodeWithin(node, ancestor) {
  return Boolean(
    node &&
    ancestor &&
    node.pos >= ancestor.pos &&
    node.end <= ancestor.end,
  );
}

function bindingStableInRegion(
  binding,
  region,
  analysis,
  {
    allowedUses = [],
    allowOrdinaryReads = false,
    ignoredNestedFunctions = [],
  } = {},
) {
  if (!binding || !region) return false;
  const allowed = new Set(allowedUses.filter(Boolean));
  const ignoredNested = new Set(ignoredNestedFunctions.filter(Boolean));
  let stable = true;
  function visit(node) {
    if (!stable) return;
    if (node !== region && ts.isFunctionLike(node)) {
      if (ignoredNested.has(node)) return;
      function capture(current) {
        if (!stable) return;
        if (
          ts.isIdentifier(current) &&
          analysis._aliasState.lexicalBindings.declarationFor(current) === binding
        ) {
          stable = false;
          return;
        }
        ts.forEachChild(current, capture);
      }
      capture(node);
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      analysis._aliasState.lexicalBindings.declarationFor(node) === binding &&
      !allowed.has(node)
    ) {
      const parent = node.parent;
      const assignment =
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const propertyAssignment =
        (
          ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)
        ) &&
        parent.expression === node &&
        ts.isBinaryExpression(parent.parent) &&
        parent.parent.left === parent &&
        parent.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const updated =
        (
          ts.isPrefixUnaryExpression(parent) ||
          ts.isPostfixUnaryExpression(parent)
        ) &&
        parent.operand === node &&
        [
          ts.SyntaxKind.PlusPlusToken,
          ts.SyntaxKind.MinusMinusToken,
        ].includes(parent.operator);
      const deleted = ts.isDeleteExpression(parent) && parent.expression === node;
      const stored =
        ts.isBinaryExpression(parent) &&
        parent.right === node &&
        (
          ts.isPropertyAccessExpression(unwrap(parent.left)) ||
          ts.isElementAccessExpression(unwrap(parent.left)) ||
          (
            ts.isIdentifier(unwrap(parent.left)) &&
            !isConstDeclaration(parent.parent)
          )
        );
      const aliased =
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node;
      let call = null;
      for (let current = parent; current && current !== region; current = current.parent) {
        if (ts.isCallExpression(current)) {
          call = current;
          break;
        }
        if (ts.isStatement(current)) break;
      }
      let returned = false;
      for (let current = parent; current && current !== region; current = current.parent) {
        if (
          (ts.isReturnStatement(current) || ts.isYieldExpression(current)) &&
          nodeWithin(node, current.expression)
        ) {
          returned = true;
          break;
        }
        if (ts.isStatement(current)) break;
      }
      if (
        assignment ||
        propertyAssignment ||
        updated ||
        deleted ||
        stored ||
        aliased ||
        call ||
        returned ||
        !allowOrdinaryReads
      ) {
        stable = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(region);
  return stable;
}

function scopePathStableForCoverage(
  scope,
  callback,
  coverageCall,
  write,
  transactionBinding,
  analysis,
) {
  if (
    !scope.issueExpression ||
    !scopeExpressionStable(
      scope.issueExpression,
      callback,
      analysis,
      Math.min(write._node.pos, coverageCall.pos),
      callback.body.end,
      [outermostWriteCall(write._node), coverageCall],
      transactionBinding,
    )
  ) {
    return false;
  }
  const root = scopeRootBinding(scope.issueExpression, analysis);
  if (!root) return true;
  let stable = true;
  function visit(node) {
    if (!stable || (node !== callback.body && ts.isFunctionLike(node))) return;
    if (
      ts.isIdentifier(node) &&
      node !== root &&
      analysis._aliasState.lexicalBindings.declarationFor(node) === root &&
      node.pos >= write._node.pos
    ) {
      if (nodeWithin(node, outermostWriteCall(write._node)) ||
          nodeWithin(node, coverageCall)) {
        return;
      }
      const parent = node.parent;
      if (
        ts.isBinaryExpression(parent) &&
        parent.right === node &&
        (
          ts.isIdentifier(unwrap(parent.left)) ||
          ts.isPropertyAccessExpression(unwrap(parent.left)) ||
          ts.isElementAccessExpression(unwrap(parent.left))
        )
      ) {
        stable = false;
        return;
      }
      for (let current = parent; current && current !== callback; current = current.parent) {
        if (ts.isCallExpression(current)) {
          stable = false;
          return;
        }
        if (ts.isStatement(current)) break;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return stable;
}

function chainCalls(writeCall) {
  const calls = [];
  let current = writeCall;
  while (
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current &&
    ts.isCallExpression(current.parent.parent) &&
    current.parent.parent.expression === current.parent
  ) {
    const property = current.parent;
    calls.push({
      call: property.parent,
      name: ts.isPropertyAccessExpression(property)
        ? property.name.text
        : property.argumentExpression &&
            (
              ts.isStringLiteral(property.argumentExpression) ||
              ts.isNoSubstitutionTemplateLiteral(property.argumentExpression)
            )
          ? property.argumentExpression.text
          : null,
    });
    current = property.parent;
  }
  return calls;
}

function chainCall(writeCall, name) {
  const matches = chainCalls(writeCall).filter((candidate) => candidate.name === name);
  return matches.length === 1 ? matches[0].call : null;
}

function directStatement(node) {
  for (let current = node; current?.parent; current = current.parent) {
    if (ts.isStatement(current)) return current;
  }
  return null;
}

function directChildOfBlock(node, block) {
  for (let current = node; current && current !== block; current = current.parent) {
    if (current.parent === block) {
      return block.statements.includes(current) ? current : null;
    }
  }
  return null;
}

function commonBlockRelation(firstNode, secondNode, callback) {
  if (!callback?.body || !ts.isBlock(callback.body)) return null;
  for (let current = firstNode; current && current !== callback; current = current.parent) {
    if (!ts.isBlock(current)) continue;
    const first = directChildOfBlock(firstNode, current);
    const second = directChildOfBlock(secondNode, current);
    if (!first || !second || first === second) continue;
    const firstIndex = current.statements.indexOf(first);
    const secondIndex = current.statements.indexOf(second);
    if (firstIndex >= 0 && secondIndex >= 0) {
      return { block: current, first, second, firstIndex, secondIndex };
    }
  }
  return null;
}

function hasNormalReturn(node) {
  let found = false;
  function visit(current) {
    if (found || (current !== node && ts.isFunctionLike(current))) return;
    if (ts.isReturnStatement(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function normalExitKeys(callback, filePath, afterPosition = -Infinity) {
  const exits = [];
  function visit(node) {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.pos > afterPosition) exits.push(nodeKey(filePath, node));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  function completesNormally(statement) {
    if (!statement) return true;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false;
    if (ts.isBlock(statement)) {
      return statement.statements.length === 0 ||
        completesNormally(statement.statements[statement.statements.length - 1]);
    }
    if (ts.isIfStatement(statement)) {
      return !statement.elseStatement ||
        completesNormally(statement.thenStatement) ||
        completesNormally(statement.elseStatement);
    }
    if (ts.isTryStatement(statement)) {
      if (statement.finallyBlock && !completesNormally(statement.finallyBlock)) return false;
      return completesNormally(statement.tryBlock) ||
        Boolean(statement.catchClause && completesNormally(statement.catchClause.block));
    }
    return true;
  }
  if (completesNormally(callback.body)) exits.push(nodeKey(filePath, callback.body));
  return [...new Set(exits)].sort();
}

function exactPredicate(expression, analysis) {
  const current = unwrap(expression);
  if (!ts.isCallExpression(current)) return null;
  const callee = unwrap(current.expression);
  if (!ts.isIdentifier(callee)) return null;
  const binding = analysis._aliasState.lexicalBindings.declarationFor(callee);
  const declaration = binding?.parent;
  const importDeclaration = declaration && ts.isImportSpecifier(declaration)
    ? declaration.parent.parent.parent
    : null;
  if (
    !importDeclaration ||
    !ts.isImportDeclaration(importDeclaration) ||
    !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
    importDeclaration.moduleSpecifier.text !== "drizzle-orm"
  ) {
    return null;
  }
  const importedName = declaration.propertyName?.text ?? declaration.name.text;
  if (importedName !== callee.text || !["eq", "and", "or"].includes(importedName)) {
    return null;
  }
  if (importedName === "eq") {
    if (current.arguments.length !== 2) return null;
    const column = unwrap(current.arguments[0]);
    if (!ts.isPropertyAccessExpression(column)) return null;
    const table = directTableReference(
      column.expression,
      analysis._aliasState.aliases,
      analysis._aliasState.namespaces,
      analysis._aliasState.helperAliases,
      analysis._aliasState.unresolvedAliases,
      analysis._aliasState.lexicalBindings,
    );
    if (!table) return null;
    const atom = ["id", "issueId"].includes(column.name.text)
      ? exactIssueIdentity(current.arguments[1], analysis)
      : exactStableAtom(current.arguments[1], analysis);
    if (!atom) return null;
    return {
      key: `EQ:${table}.${column.name.text}:${atom}`,
      kind: "eq",
      table,
      column: column.name.text,
      atom,
      atomNode: current.arguments[1],
      node: current,
      proofNodes: [nodeKey(analysis.path, current)],
    };
  }
  if (current.arguments.length === 0) return null;
  const children = current.arguments.map((argument) => exactPredicate(argument, analysis));
  if (children.some((child) => !child)) return null;
  return {
    key: `${importedName.toUpperCase()}:(${children.map((child) => child.key).join(",")})`,
    kind: importedName,
    children,
    node: current,
    proofNodes: [
      nodeKey(analysis.path, current),
      ...children.flatMap((child) => child.proofNodes),
    ],
  };
}

function predicateIssueAtom(predicate) {
  if (!predicate) return null;
  if (
    predicate.kind === "eq" &&
    predicate.table === "issueComments" &&
    predicate.column === "issueId"
  ) {
    return predicate.atom;
  }

  const atoms = (predicate.children ?? [])
    .map(predicateIssueAtom)
    .filter(Boolean);
  return atoms.length === 1 ? atoms[0] : null;
}

function predicateIssueExpression(predicate) {
  if (!predicate) return null;
  if (
    predicate.kind === "eq" &&
    predicate.table === "issueComments" &&
    predicate.column === "issueId"
  ) {
    return predicate.atomNode;
  }
  const expressions = (predicate.children ?? [])
    .map(predicateIssueExpression)
    .filter(Boolean);
  return expressions.length === 1 ? expressions[0] : null;
}

function commentScope(write, analysis) {
  if (write.operation === "insert") {
    const values = chainCall(write._node, "values");
    const issueExpression = values?.arguments.length === 1
      ? exactObjectPropertyValue(values.arguments[0], "issueId")
      : null;
    const key = issueExpression && exactIssueIdentity(issueExpression, analysis);
    return key
      ? {
          kind: "ExactIssue",
          key,
          issueExpression,
          proofNodes: [
            nodeKey(analysis.path, write._node),
            nodeKey(analysis.path, issueExpression),
          ],
        }
      : null;
  }
  const where = chainCall(write._node, "where");
  const predicate = where?.arguments.length === 1
    ? exactPredicate(where.arguments[0], analysis)
    : null;
  if (!predicate) return null;
  const issueAtom = predicateIssueAtom(predicate);
  const issueExpression = predicateIssueExpression(predicate);
  return issueAtom
    ? {
        kind: "ExactIssue",
        key: issueAtom,
        issueExpression,
        predicate,
        proofNodes: [
          nodeKey(analysis.path, write._node),
          ...predicate.proofNodes,
        ],
      }
    : {
        kind: "ExactPredicate",
        key: `PRED:${predicate.key}`,
        predicate,
        proofNodes: [
          nodeKey(analysis.path, write._node),
          ...predicate.proofNodes,
        ],
      };
}

function outermostWriteCall(writeCall) {
  let current = writeCall;
  while (
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current &&
    ts.isCallExpression(current.parent.parent) &&
    current.parent.parent.expression === current.parent
  ) {
    current = current.parent.parent;
  }
  return current;
}

function versionedUpdateIdentityExpression(write, analysis) {
  const where = chainCall(write._node, "where");
  const predicate = where?.arguments.length === 1
    ? exactPredicate(where.arguments[0], analysis)
    : null;
  return (
    predicate?.kind === "eq" &&
    predicate.table === "issues" &&
    predicate.column === "id"
  )
    ? predicate.atomNode
    : null;
}

function transactionReceiverBinding(write, analysis) {
  const member = callMember(write._node);
  const receiver = member && unwrap(member.receiver);
  return receiver && ts.isIdentifier(receiver)
    ? analysis._aliasState.lexicalBindings.declarationFor(receiver)
    : null;
}

function isJoinedWrite(writeCall, callback) {
  const outermost = outermostWriteCall(writeCall);
  let current = outermost;
  while (
    current.parent &&
    (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)
    )
  ) {
    current = current.parent;
  }
  if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) {
    const awaitExpression = current.parent;
    for (let owner = awaitExpression.parent; owner && owner !== callback; owner = owner.parent) {
      if (
        ts.isCallExpression(owner) &&
        ts.isPropertyAccessExpression(owner.expression) &&
        ts.isIdentifier(unwrap(owner.expression.expression)) &&
        unwrap(owner.expression.expression).text === "Promise" &&
        owner.expression.name.text === "all"
      ) {
        return false;
      }
      if (owner !== awaitExpression.parent && ts.isFunctionLike(owner)) return false;
    }
    return true;
  }
  if (!ts.isReturnStatement(current.parent) || current.parent.expression !== current) {
    return false;
  }
  for (let owner = current.parent.parent; owner; owner = owner.parent) {
    if (ts.isFunctionLike(owner)) return owner === callback;
  }
  return false;
}

function directPatchScope(write, callback, transactionBinding, analysis) {
  if (
    write.table !== "issues" ||
    write.operation !== "update" ||
    write.versionedBy !== "versionedIssuePatch" ||
    write.transactionCallback !== callback ||
    transactionReceiverBinding(write, analysis) !== transactionBinding ||
    !isTrustedHelperPair({
      helperExport: "versionedIssuePatch",
      helperPath: write.versionedHelperPath,
    }) ||
    !isJoinedWrite(write._node, callback)
  ) {
    return null;
  }
  const identityExpression = versionedUpdateIdentityExpression(write, analysis);
  const key = identityExpression && exactIssueIdentity(identityExpression, analysis);
  return key
    ? {
        kind: "ExactIssue",
        key,
        issueExpression: identityExpression,
        proofNodes: [
          nodeKey(analysis.path, write._node),
          nodeKey(analysis.path, identityExpression),
        ],
      }
    : null;
}

function localParameterInitializerCallInvalidates(
  call,
  capabilityBindings,
  analysis,
) {
  const callee = analysis._registry.resolveCallee(call.expression);
  if (
    !callee ||
    !callee._node.parameters.some((parameter) => parameter.initializer)
  ) {
    return false;
  }
  const activeInitializerIndexes = parameterInitializerExecutionPlan(
    call,
    callee._node,
    capabilityBindings,
    analysis._aliasState.lexicalBindings,
    { assigned: analysis._aliasState.assigned },
  );
  if (!activeInitializerIndexes) {
    const potentiallyActive = new Set(
      callee._node.parameters
        .map((parameter, index) => parameter.initializer ? index : -1)
        .filter((index) => index >= 0),
    );
    Object.defineProperty(potentiallyActive, "_ordinaryParameterIndexes", {
      value: new Set(),
    });
    return !activeParameterInitializersArePure(
      callee._node,
      potentiallyActive,
      analysis._aliasState.lexicalBindings,
      analysis._aliasState.assigned,
    );
  }
  return !activeParameterInitializersArePure(
    callee._node,
    activeInitializerIndexes,
    analysis._aliasState.lexicalBindings,
    analysis._aliasState.assigned,
  );
}

function statementInvalidatesTransaction(statement, transactionBinding, analysis) {
  let invalid = false;
  function visit(node) {
    if (invalid || (node !== statement && ts.isFunctionLike(node))) return;
    if (ts.isCallExpression(node)) {
      if (
        localParameterInitializerCallInvalidates(
          node,
          new Set([transactionBinding]),
          analysis,
        )
      ) {
        invalid = true;
        return;
      }
      const member = callMember(node);
      const receiver = member && unwrap(member.receiver);
      const receiverBinding = receiver && ts.isIdentifier(receiver)
        ? analysis._aliasState.lexicalBindings.declarationFor(receiver)
        : null;
      if (
        receiverBinding === transactionBinding &&
        (
          node.questionDotToken ||
          member.computed ||
          ["transaction", "rollback", "execute", "raw"].includes(member.name)
        )
      ) {
        invalid = true;
        return;
      }
      const transactionArguments = node.arguments.some((argument) =>
        capabilityIdentifiers(
          argument,
          new Set([transactionBinding]),
          analysis._aliasState.lexicalBindings,
        ).length > 0);
      if (transactionArguments) {
        if (
          !resolvedImportedReadOnlyTransactionCall(
            node,
            transactionBinding,
            analysis,
            new Set([transactionBinding]),
          )
        ) {
          invalid = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return invalid;
}

function relationHasNormalGap(relation, transactionBinding, analysis) {
  if (!relation) return true;
  const start = Math.min(relation.firstIndex, relation.secondIndex) + 1;
  const end = Math.max(relation.firstIndex, relation.secondIndex);
  return relation.block.statements.slice(start, end).some((statement) =>
    hasNormalReturn(statement) ||
    statementInvalidatesTransaction(statement, transactionBinding, analysis));
}

function exactTransactionCallRoot(call, transactionBinding, analysis) {
  return expressionCallChain(call).find((item) => {
    const receiver = item.receiver && unwrap(item.receiver);
    return (
      receiver &&
      ts.isIdentifier(receiver) &&
      analysis._aliasState.lexicalBindings.declarationFor(receiver) ===
        transactionBinding
    );
  }) ?? null;
}

function resolvedReadOnlyTransactionCall(call, transactionBinding, analysis) {
  const callee = analysis._registry.resolveCallee(call.expression);
  if (!callee || !callee._parameter) {
    return false;
  }
  const transactionIndex = callee._node.parameters.indexOf(callee._parameter);
  const capabilityBindings = new Set([transactionBinding]);
  const initializerPlan = parameterInitializerExecutionPlan(
    call,
    callee._node,
    capabilityBindings,
    analysis._aliasState.lexicalBindings,
  );
  if (
    !initializerPlan ||
    transactionIndex < 0 ||
    transactionIndex >= call.arguments.length ||
    callee._parameter.initializer ||
    exactArgumentBinding(call.arguments[transactionIndex], analysis) !==
      transactionBinding
  ) {
    return false;
  }
  return (
    call.arguments.every((argument, index) =>
      index === transactionIndex ||
      capabilityIdentifiers(
        argument,
        new Set([transactionBinding]),
        analysis._aliasState.lexicalBindings,
      ).length === 0) &&
    classifyFunctionInvocation(callee, initializerPlan) === "READ_ONLY"
  );
}

function analysisNodeForEvidence(analysis, evidence) {
  let result = null;
  function visit(node) {
    if (result) return;
    if (nodeKey(analysis.path, node) === evidence.nodeKey) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(analysis._sourceFile);
  return result;
}

function exactOrdinaryTransactionRoot(call, transactionParameter, analysis) {
  const transactionBinding = transactionParameter.name;
  const chain = expressionCallChain(call);
  const root = chain.find((item) => {
    const receiver = item.receiver && unwrap(item.receiver);
    return (
      receiver &&
      ts.isIdentifier(receiver) &&
      analysis._aliasState.lexicalBindings.declarationFor(receiver) ===
        transactionBinding
    );
  });
  if (!root || root.call.questionDotToken || rootMemberUnsafe(root.call)) return null;
  if (!["select", "selectDistinct", "insert", "update", "delete"].includes(root.name)) {
    return null;
  }
  if (
    root.call.arguments.some((argument) =>
      capabilityIdentifiers(
        argument,
        new Set([transactionBinding]),
        analysis._aliasState.lexicalBindings,
      ).length > 0)
  ) {
    return null;
  }
  if (["insert", "update", "delete"].includes(root.name)) {
    if (
      root.call.arguments.length !== 1 ||
      !exactImportedOrdinaryTarget(root.call.arguments[0], analysis)
    ) {
      return null;
    }
  }
  const allowedWriteMembers = new Set([
    "insert",
    "update",
    "delete",
    "values",
    "set",
    "where",
    "returning",
    "then",
    "onConflictDoUpdate",
  ]);
  const rootIndex = chain.findIndex((item) => item.call === root.call);
  if (
    chain.slice(rootIndex).some((item) => {
      const member = callMember(item.call);
      return (
        !member ||
        member.computed ||
        item.call.questionDotToken ||
        (
          !["select", "selectDistinct"].includes(root.name) &&
          !allowedWriteMembers.has(item.name)
        )
      );
    })
  ) {
    return null;
  }
  return { root, chain };
}

function rootMemberUnsafe(call) {
  const member = callMember(call);
  return (
    !member ||
    member.computed ||
    ["transaction", "rollback", "execute", "raw"].includes(member.name)
  );
}

function ordinaryRootIsJoined(call, root, analysis) {
  const outermost = outermostWriteCall(root.call);
  let owner = null;
  for (let current = outermost.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      owner = current;
      break;
    }
  }
  if (!owner) return false;
  if (isJoinedCall(outermost, owner)) return true;
  return (
    ["select", "selectDistinct"].includes(root.name) &&
    ts.isArrowFunction(owner) &&
    owner.body === outermost
  );
}

function capturedOrdinaryEffectsAreExact(
  functionLike,
  transactionParameter,
  analysis,
) {
  let valid = true;
  function visit(node) {
    if (!valid) return;
    if (
      ts.isIdentifier(node) &&
      analysis._aliasState.lexicalBindings.declarationFor(node) ===
        transactionParameter.name &&
      !isDeclarationIdentifier(node)
    ) {
      let safe = false;
      for (
        let current = node.parent;
        current && current !== functionLike;
        current = current.parent
      ) {
        if (!ts.isCallExpression(current)) continue;
        const ordinary = exactOrdinaryTransactionRoot(
          current,
          transactionParameter,
          analysis,
        );
        if (
          ordinary &&
          nodeWithin(node, ordinary.chain.at(-1).call) &&
          ordinaryRootIsJoined(current, ordinary.root, analysis)
        ) {
          safe = true;
          break;
        }
      }
      if (!safe) {
        valid = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(functionLike);
  return valid;
}

function resolvedImportedOrdinaryEffect(
  call,
  imported,
  moduleAnalysis,
  record,
  mappedParameter,
  analysis,
  activeInitializerIndexes = null,
  seen = new Set(),
  allowFactoryCaptures = false,
) {
  const key = `${imported.path}|${record.symbolKey}`;
  if (seen.has(key)) return false;
  const nextSeen = new Set(seen).add(key);
  if (
    classifyFunctionInvocation(record, activeInitializerIndexes) !==
      "MAY_WRITE_OR_CONTROL" ||
    moduleAnalysis._allWrites?.length > 0 ||
    record._dependencies
      .filter((dependency) =>
        initializerFactIsActive(dependency, activeInitializerIndexes))
      .some(
        (dependency) =>
          classifyFunctionInvocation(
            dependency._callee,
            dependency._calleeActiveInitializerIndexes ?? null,
          ) !== "READ_ONLY",
    )
  ) {
    return false;
  }
  for (const evidence of record._known.filter((fact) =>
    initializerFactIsActive(fact, activeInitializerIndexes))) {
    const node = analysisNodeForEvidence(moduleAnalysis, evidence);
    if (!node || !ts.isCallExpression(node)) return false;
    const ordinary = exactOrdinaryTransactionRoot(
      node,
      mappedParameter,
      moduleAnalysis,
    );
    if (
      !ordinary ||
      !["insert", "update", "delete"].includes(ordinary.root.name) ||
      !ordinaryRootIsJoined(node, ordinary.root, moduleAnalysis)
    ) {
      return false;
    }
  }
  for (const evidence of record._unknown.filter((fact) =>
    initializerFactIsActive(fact, activeInitializerIndexes))) {
    const node = analysisNodeForEvidence(moduleAnalysis, evidence);
    if (
      evidence.message === "nested transaction/query capability capture" &&
      allowFactoryCaptures &&
      node &&
      ts.isFunctionLike(node) &&
      capturedOrdinaryEffectsAreExact(node, mappedParameter, moduleAnalysis)
    ) {
      continue;
    }
    if (
      evidence.message !== "non-exact transaction argument mapping" ||
      !node ||
      !ts.isCallExpression(node) ||
      node.questionDotToken ||
      node.arguments.some((argument) => ts.isSpreadElement(argument)) ||
      !ts.isPropertyAccessExpression(node.parent) ||
      node.parent.expression !== node ||
      !ts.isCallExpression(node.parent.parent) ||
      node.parent.parent.expression !== node.parent ||
      node.parent.parent.questionDotToken
    ) {
      return false;
    }
    const nestedImport = resolveImportedExecutable(node, moduleAnalysis);
    if (!nestedImport) return false;
    const capabilityIndexes = node.arguments
      .map((argument, index) =>
        capabilityIdentifiers(
          argument,
          new Set([mappedParameter.name]),
          moduleAnalysis._aliasState.lexicalBindings,
        ).length > 0
          ? index
          : -1)
      .filter((index) => index >= 0);
    if (capabilityIndexes.length !== 1) return false;
    const parameterIndex = capabilityIndexes[0];
    const nestedWrites = collectIssueWritesFromSource(
      nestedImport.path,
      nestedImport.source,
      {
        resolveNamedImport: analysis._resolveNamedImport,
        resolveModuleSource: analysis._resolveModuleSource,
      },
    );
    const nestedAnalysis = nestedWrites.contractAnalysis;
    const nestedRecord = nestedAnalysis._registry.records.find((candidate) =>
      candidate.symbolKey ===
        symbolKey(
          nestedImport.path,
          functionDeclarationNode(nestedImport.executable),
        ));
    const nestedParameter = nestedRecord?._node.parameters[parameterIndex];
    if (
      !nestedRecord ||
      !nestedParameter ||
      !ts.isIdentifier(nestedParameter.name)
    ) {
      return false;
    }
    const nestedInitializerPlan = parameterInitializerExecutionPlan(
      node,
      nestedRecord._node,
      new Set([mappedParameter.name]),
      moduleAnalysis._aliasState.lexicalBindings,
    );
    if (!nestedInitializerPlan) return false;
    if (!nestedRecord._parameter) {
      analyzeFunctionFacts(
        nestedRecord,
        nestedImport.path,
        nestedAnalysis._registry,
        nestedAnalysis._aliasState.lexicalBindings,
        nestedAnalysis._aliasState.assigned,
        nestedAnalysis._aliasState.helperAliases,
        nestedParameter,
      );
      classifyFunctionGraph(nestedAnalysis._registry.records);
    }
    if (
      !resolvedImportedOrdinaryEffect(
        node,
        nestedImport,
        nestedAnalysis,
        nestedRecord,
        nestedParameter,
        analysis,
        nestedInitializerPlan,
        nextSeen,
        true,
      )
    ) {
      return false;
    }
  }
  return (
    record.captureFacts.capabilityCaptures.filter((capture) =>
      initializerFactIsActive(capture, activeInitializerIndexes)).length === 0 ||
    (
      allowFactoryCaptures &&
      record.captureFacts.capabilityCaptures
        .filter((capture) =>
          initializerFactIsActive(capture, activeInitializerIndexes))
        .every((capture) => {
        const evidence = {
          nodeKey: capture.nestedFunction,
        };
        const node = analysisNodeForEvidence(moduleAnalysis, evidence);
        return (
          node &&
          ts.isFunctionLike(node) &&
          capturedOrdinaryEffectsAreExact(
            node,
            mappedParameter,
            moduleAnalysis,
          )
        );
      })
    )
  );
}

function resolvedImportedReadOnlyTransactionCall(
  call,
  transactionBinding,
  analysis,
  capabilityBindings,
) {
  analysis._ordinaryImportedCallCache ??= new Map();
  const cacheKey = nodeKey(analysis.path, call);
  let readOnly = analysis._ordinaryImportedCallCache.get(cacheKey);
  if (readOnly !== undefined) return readOnly;
  const imported = resolveImportedExecutable(call, analysis);
  const executable = imported?.executable;
  const initializerPlan = executable
    ? parameterInitializerExecutionPlan(
        call,
        executable,
        capabilityBindings,
        analysis._aliasState.lexicalBindings,
      )
    : null;
  if (
    !imported ||
    !executable ||
    !initializerPlan
  ) {
    analysis._ordinaryImportedCallCache.set(cacheKey, false);
    return false;
  }
  const capabilityArguments = call.arguments
    .map((argument, index) => ({
      argument,
      index,
      identifiers: capabilityIdentifiers(
        argument,
        capabilityBindings,
        analysis._aliasState.lexicalBindings,
      ),
    }))
    .filter((candidate) => candidate.identifiers.length > 0);
  if (capabilityArguments.length !== 1) {
    analysis._ordinaryImportedCallCache.set(cacheKey, false);
    return false;
  }
  const mapped = capabilityArguments[0];
  const entireBinding = exactArgumentBinding(mapped.argument, analysis);
  const callback =
    transactionBinding.parent &&
    ts.isParameter(transactionBinding.parent) &&
    ts.isFunctionLike(transactionBinding.parent.parent)
      ? transactionBinding.parent.parent
      : null;
  const transactionAliases = callback
    ? immutableAliasBindings(
        callback,
        transactionBinding,
        analysis._aliasState.lexicalBindings,
        analysis._aliasState.assigned,
      )
    : new Set([transactionBinding]);
  const parameter = executable.parameters[mapped.index];
  if (
    !transactionAliases.has(entireBinding) ||
    !parameter ||
    !ts.isIdentifier(parameter.name) ||
    ts.parameterIsThisKeyword(parameter) !== false ||
    parameter.dotDotDotToken ||
    parameter.initializer ||
    parameter.questionToken
  ) {
    analysis._ordinaryImportedCallCache.set(cacheKey, false);
    return false;
  }
  const importedWrites = collectIssueWritesFromSource(
    imported.path,
    imported.source,
    {
      resolveNamedImport: analysis._resolveNamedImport,
      resolveModuleSource: analysis._resolveModuleSource,
    },
  );
  const moduleAnalysis = importedWrites.contractAnalysis;
  const record = moduleAnalysis._registry.records.find((candidate) =>
    candidate.symbolKey ===
      symbolKey(imported.path, functionDeclarationNode(imported.executable)));
  if (!record) {
    analysis._ordinaryImportedCallCache.set(cacheKey, false);
    return false;
  }
  const mappedParameter = record._node.parameters[mapped.index];
  if (
    !mappedParameter ||
    !ts.isIdentifier(mappedParameter.name) ||
    mappedParameter.dotDotDotToken ||
    mappedParameter.initializer ||
    mappedParameter.questionToken
  ) {
    analysis._ordinaryImportedCallCache.set(cacheKey, false);
    return false;
  }
  if (!record._parameter) {
    analyzeFunctionFacts(
      record,
      imported.path,
      moduleAnalysis._registry,
      moduleAnalysis._aliasState.lexicalBindings,
      moduleAnalysis._aliasState.assigned,
      moduleAnalysis._aliasState.helperAliases,
      mappedParameter,
    );
    classifyFunctionGraph(moduleAnalysis._registry.records);
  }
  readOnly =
    record._parameter === mappedParameter &&
    (
      classifyFunctionInvocation(record, initializerPlan) === "READ_ONLY" ||
      resolvedImportedOrdinaryEffect(
        call,
        imported,
        moduleAnalysis,
        record,
        mappedParameter,
        analysis,
        initializerPlan,
      )
    );
  analysis._ordinaryImportedCallCache.set(cacheKey, readOnly);
  return readOnly;
}

function callInvalidatesObligation(
  call,
  transactionBinding,
  analysis,
  allowedCalls,
  capabilityBindings,
) {
  if (allowedCalls.has(call)) return false;
  const root = exactTransactionCallRoot(call, transactionBinding, analysis);
  if (root) {
    const chain = expressionCallChain(call);
    const rootIndex = chain.findIndex((item) => item.call === root.call);
    const rootMember = callMember(root.call);
    const rootArgumentsHaveCapability = root.call.arguments.some((argument) =>
      capabilityIdentifiers(
        argument,
        new Set([transactionBinding]),
        analysis._aliasState.lexicalBindings,
      ).length > 0);
    if (
      rootIndex < 0 ||
      !rootMember ||
      rootMember.computed ||
      root.call.questionDotToken ||
      rootArgumentsHaveCapability ||
      !["select", "selectDistinct", "insert", "update", "delete"].includes(
        root.name,
      )
    ) {
      return true;
    }
    if (["insert", "update", "delete"].includes(root.name)) {
      if (root.call.arguments.length !== 1) return true;
      const target = root.call.arguments[0];
      const table = directTableReference(
        target,
        analysis._aliasState.aliases,
        analysis._aliasState.namespaces,
        analysis._aliasState.helperAliases,
        analysis._aliasState.unresolvedAliases,
        analysis._aliasState.lexicalBindings,
      );
      if (!table && !exactImportedOrdinaryTarget(target, analysis)) return true;
    }
    const allowedWriteMembers = new Set([
      "insert",
      "update",
      "delete",
      "values",
      "set",
      "where",
      "returning",
      "then",
    ]);
    for (const item of chain.slice(rootIndex)) {
      const member = callMember(item.call);
      if (
        !member ||
        member.computed ||
        item.call.questionDotToken ||
        ["transaction", "rollback", "execute", "raw"].includes(item.name)
      ) {
        return true;
      }
      if (
        !["select", "selectDistinct"].includes(root.name) &&
        !allowedWriteMembers.has(item.name)
      ) {
        return true;
      }
    }
    return false;
  }
  const member = callMember(call);
  const receiver = member && unwrap(member.receiver);
  if (
    receiver &&
    ts.isIdentifier(receiver) &&
    capabilityBindings.has(
      analysis._aliasState.lexicalBindings.declarationFor(receiver),
    )
  ) {
    return true;
  }
  const hasTransactionArgument = call.arguments.some((argument) =>
    capabilityIdentifiers(
      argument,
      capabilityBindings,
      analysis._aliasState.lexicalBindings,
    ).length > 0);
  if (
    localParameterInitializerCallInvalidates(
      call,
      capabilityBindings,
      analysis,
    )
  ) {
    return true;
  }
  if (!hasTransactionArgument) return false;
  return !resolvedReadOnlyTransactionCall(call, transactionBinding, analysis) &&
    !resolvedImportedReadOnlyTransactionCall(
      call,
      transactionBinding,
      analysis,
      capabilityBindings,
    );
}

function obligationCapabilityBindings(callback, transactionBinding, analysis) {
  const bindings = new Set([transactionBinding]);
  let changed = true;
  while (changed) {
    changed = false;
    function visit(node) {
      if (node !== callback.body && ts.isFunctionLike(node)) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        isConstDeclaration(node) &&
        !analysis._aliasState.assigned.has(node.name) &&
        node.initializer
      ) {
        const initializer = unwrap(node.initializer);
        const alias =
          ts.isIdentifier(initializer) &&
          bindings.has(
            analysis._aliasState.lexicalBindings.declarationFor(initializer),
          );
        const storedCapability =
          (
            ts.isObjectLiteralExpression(initializer) ||
            ts.isArrayLiteralExpression(initializer)
          ) &&
          capabilityIdentifiers(
            initializer,
            bindings,
            analysis._aliasState.lexicalBindings,
          ).length > 0;
        const query =
          !ts.isAwaitExpression(initializer) &&
          ts.isCallExpression(initializer) &&
          expressionCallChain(initializer).some((item) => {
            const receiver = item.receiver && unwrap(item.receiver);
            return (
              item.name === "select" &&
              receiver &&
              ts.isIdentifier(receiver) &&
              bindings.has(
                analysis._aliasState.lexicalBindings.declarationFor(receiver),
              )
            );
          });
        if ((alias || storedCapability || query) && !bindings.has(node.name)) {
          bindings.add(node.name);
          changed = true;
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (
          ts.isPropertyAccessExpression(unwrap(node.left)) ||
          ts.isElementAccessExpression(unwrap(node.left))
        ) &&
        capabilityIdentifiers(
          node.right,
          bindings,
          analysis._aliasState.lexicalBindings,
        ).length > 0
      ) {
        const receiver = unwrap(unwrap(node.left).expression);
        const receiverBinding =
          ts.isIdentifier(receiver) &&
          analysis._aliasState.lexicalBindings.declarationFor(receiver);
        if (receiverBinding && !bindings.has(receiverBinding)) {
          bindings.add(receiverBinding);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(callback.body);
  }
  return bindings;
}

function obligationInvalidationEvidence(callback, transactionBinding, analysis) {
  const record = analysis._registry.byExecutable.get(callback);
  if (!record || record._parameter?.name !== transactionBinding) return [];
  const evidenceKeys = new Set([
    ...record._unknown.map((evidence) => evidence.nodeKey),
    ...record.captureFacts.capabilityCaptures.map(
      (capture) => capture.nestedFunction,
    ),
  ]);
  const nodes = [];
  function visit(node) {
    const key = nodeKey(analysis.path, node);
    if (evidenceKeys.has(key)) {
      nodes.push({
        node,
        nodeKey: key,
        transactionRoot: symbolKey(analysis.path, transactionBinding),
      });
    }
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return nodes.sort((left, right) =>
    left.node.pos - right.node.pos ||
    left.node.end - right.node.end ||
    left.nodeKey.localeCompare(right.nodeKey));
}

function obligationEvidencePoisonsTransaction(node, callback) {
  if (!ts.isIdentifier(node)) return false;
  for (let current = node.parent; current && current !== callback; current = current.parent) {
    if (
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      nodeWithin(node, current.right)
    ) {
      const target = unwrap(current.left);
      return (
        ts.isIdentifier(target) ||
        ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)
      );
    }
    if (
      ts.isVariableDeclaration(current) &&
      current.initializer &&
      nodeWithin(node, current.initializer)
    ) {
      const initializer = unwrap(current.initializer);
      const exactImmutableAlias =
        ts.isIdentifier(current.name) &&
        isConstDeclaration(current) &&
        initializer === node;
      return !exactImmutableAlias;
    }
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

function obligationFlowProof(
  write,
  callback,
  transactionBinding,
  coverage,
  analysis,
) {
  if (!callback?.body || !ts.isBlock(callback.body)) return null;
  const sinkNodes = new Set(coverage.flowSinkNodes ?? [write._node]);
  const coverageNodes = new Set(
    coverage.flowCoverageNodes ?? [coverage.edgeNode],
  );
  const memberNodes = new Set(coverage.flowMemberNodes ?? []);
  const memberImpliesGuards = new Set(
    coverage.flowMemberImpliesGuards ?? [],
  );
  const sinkImpliesGuards = new Set(
    coverage.flowSinkImpliesGuards ?? [],
  );
  const pendingImpliesGuards = new Set(
    coverage.flowPendingImpliesGuards ?? [],
  );
  const ignoredExitNodes = new Set(coverage.flowIgnoredExitNodes ?? []);
  const allowedCaptureNodes = new Set(coverage.flowAllowedCaptureNodes ?? []);
  const invalidationNodeKeys = new Set();
  const capabilityBindings = obligationCapabilityBindings(
    callback,
    transactionBinding,
    analysis,
  );
  const positionalEvidence = obligationInvalidationEvidence(
    callback,
    transactionBinding,
    analysis,
  );
  const evidenceNodes = new Set(positionalEvidence.map((evidence) => evidence.node));
  const allowedCalls = new Set([
    write._node,
    coverage.edgeNode,
    ...(coverage.flowAllowedCalls ?? []),
    ...[...sinkNodes, ...coverageNodes, ...memberNodes].filter((node) =>
      ts.isCallExpression(node)),
  ].filter(Boolean));
  const requiresMember = coverage.flowRequiresMember === true;
  const initialState = {
    seen: false,
    covered: false,
    coverageAvailable: false,
    invalid: false,
    poisoned: false,
    member: false,
  };
  const stateKey = (state) =>
    [
      state.seen ? 1 : 0,
      state.covered ? 1 : 0,
      state.coverageAvailable ? 1 : 0,
      state.invalid ? 1 : 0,
      state.poisoned ? 1 : 0,
      state.member ? 1 : 0,
    ].join("");
  const stateMap = (states = []) =>
    new Map(states.map((state) => [stateKey(state), state]));
  const mergeStates = (...maps) => {
    const result = new Map();
    for (const map of maps) {
      for (const [key, state] of map) result.set(key, state);
    }
    return result;
  };
  const sameStates = (left, right) =>
    left.size === right.size && [...left.keys()].every((key) => right.has(key));
  const emptyOutcome = () => ({
    normal: new Map(),
    return: new Map(),
    throw: new Map(),
    break: new Map(),
    continue: new Map(),
  });
  const outcomeItemKey = (item) =>
    `${stateKey(item.state)}|${item.exitKey ?? ""}`;
  const addOutcome = (outcome, kind, item) => {
    outcome[kind].set(outcomeItemKey(item), item);
  };
  const mergeOutcomes = (...outcomes) => {
    const result = emptyOutcome();
    for (const outcome of outcomes) {
      for (const kind of Object.keys(result)) {
        for (const item of outcome[kind].values()) addOutcome(result, kind, item);
      }
    }
    return result;
  };
  const normalOutcome = (states) => {
    const result = emptyOutcome();
    for (const state of states.values()) addOutcome(result, "normal", { state });
    return result;
  };
  const itemsToStates = (items) =>
    stateMap([...items.values()].map((item) => item.state));
  const applyEvent = (state, kind) => {
    if (kind === "sink") {
      return {
        ...state,
        seen: true,
        covered: state.coverageAvailable && !state.poisoned,
        invalid: state.invalid || state.poisoned,
        member: false,
      };
    }
    if (kind === "coverage") {
      const usable = !state.poisoned &&
        (!requiresMember || !state.seen || state.member);
      return {
        ...state,
        coverageAvailable: state.coverageAvailable || usable,
        covered: state.covered || (state.seen && usable),
      };
    }
    if (kind === "member") {
      return { ...state, member: state.member || state.seen };
    }
    if (kind === "poison") {
      return {
        ...state,
        invalid: state.invalid || state.seen,
        poisoned: true,
        coverageAvailable: false,
        covered: state.seen ? false : state.covered,
      };
    }
    return {
      ...state,
      invalid: state.invalid || state.seen,
      coverageAvailable: state.seen || state.coverageAvailable
        ? false
        : state.coverageAvailable,
      covered: state.seen ? false : state.covered,
    };
  };
  const expressionEvents = (node) => {
    if (!node) return [];
    const events = [];
    const awaitCanReject = (expression) => {
      const current = unwrap(expression);
      if (
        ts.isStringLiteral(current) ||
        ts.isNoSubstitutionTemplateLiteral(current) ||
        ts.isNumericLiteral(current) ||
        ts.isBigIntLiteral(current) ||
        current.kind === ts.SyntaxKind.TrueKeyword ||
        current.kind === ts.SyntaxKind.FalseKeyword ||
        current.kind === ts.SyntaxKind.NullKeyword
      ) {
        return false;
      }
      return true;
    };
    function visit(current, insideAwait = false) {
      const joinedReadOnlyCall =
        ts.isCallExpression(current) &&
        isJoinedCall(current, callback) &&
        !callInvalidatesObligation(
          current,
          transactionBinding,
          analysis,
          allowedCalls,
          capabilityBindings,
        );
      const transferredSinkCarrier =
        ts.isFunctionLike(current) && allowedCaptureNodes.has(current);
      if (
        evidenceNodes.has(current) &&
        !allowedCalls.has(current) &&
        !joinedReadOnlyCall &&
        !transferredSinkCarrier
      ) {
        invalidationNodeKeys.add(nodeKey(analysis.path, current));
        events.push({
          node: current,
          kind: obligationEvidencePoisonsTransaction(current, callback)
            ? "poison"
            : "invalid",
        });
      }
      if (current !== node && ts.isFunctionLike(current)) return;
      if (ts.isAwaitExpression(current)) {
        if (awaitCanReject(current.expression)) {
          events.push({ node: current, kind: "exception" });
        }
        visit(current.expression, true);
        return;
      }
      if (
        !insideAwait &&
        (
          ts.isCallExpression(current) ||
          ts.isNewExpression(current) ||
          ts.isTaggedTemplateExpression(current)
        )
      ) {
        events.push({ node: current, kind: "exception" });
      }
      if (sinkNodes.has(current)) events.push({ node: current, kind: "sink" });
      if (coverageNodes.has(current)) {
        events.push({ node: current, kind: "coverage" });
      }
      if (memberNodes.has(current)) events.push({ node: current, kind: "member" });
      if (
        ts.isCallExpression(current) &&
        callInvalidatesObligation(
          current,
          transactionBinding,
          analysis,
          allowedCalls,
          capabilityBindings,
        )
      ) {
        invalidationNodeKeys.add(nodeKey(analysis.path, current));
        events.push({ node: current, kind: "invalid" });
      }
      ts.forEachChild(current, (child) => visit(child, insideAwait));
    }
    visit(node);
    const precedence = {
      exception: -1,
      sink: 0,
      member: 1,
      coverage: 2,
      poison: 3,
      invalid: 4,
    };
    const unique = new Map();
    for (const event of events) {
      unique.set(`${event.kind}|${nodeKey(analysis.path, event.node)}`, event);
    }
    return [...unique.values()].sort((left, right) =>
      left.node.pos - right.node.pos ||
      left.node.end - right.node.end ||
      precedence[left.kind] - precedence[right.kind]);
  };
  const applyExpression = (states, node, forceInvalid = false) => {
    const events = expressionEvents(node);
    if (forceInvalid) events.push({ node, kind: "invalid" });
    let current = states;
    let exceptional = stateMap();
    for (const event of events) {
      if (event.kind === "exception") {
        exceptional = mergeStates(exceptional, current);
        continue;
      }
      current = stateMap(
        [...current.values()].map((state) => applyEvent(state, event.kind)),
      );
    }
    return { normal: current, throw: exceptional };
  };
  const expressionOutcome = (states, node, forceInvalid = false) => {
    const flow = applyExpression(states, node, forceInvalid);
    const result = normalOutcome(flow.normal);
    for (const state of flow.throw.values()) {
      addOutcome(result, "throw", { state });
    }
    return result;
  };
  const literalBoolean = (expression) => {
    const current = unwrap(expression);
    if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
    return null;
  };

  let analyzeStatement;
  const analyzeBlock = (block, input) => {
    let normal = input;
    let abrupt = emptyOutcome();
    for (const statement of block.statements) {
      if (normal.size === 0) break;
      const next = analyzeStatement(statement, normal);
      abrupt = mergeOutcomes(abrupt, {
        ...emptyOutcome(),
        return: next.return,
        throw: next.throw,
        break: next.break,
        continue: next.continue,
      });
      normal = itemsToStates(next.normal);
    }
    const result = abrupt;
    for (const state of normal.values()) addOutcome(result, "normal", { state });
    return result;
  };
  const analyzeLoop = (
    statement,
    input,
    { body, test, incrementor, atLeastOnce, unknownTest = false },
  ) => {
    let propagated = emptyOutcome();
    const applyLoopExpression = (states, expression) => {
      const flow = applyExpression(states, expression);
      for (const state of flow.throw.values()) {
        addOutcome(propagated, "throw", { state });
      }
      return flow.normal;
    };
    const preTest = (states) => applyLoopExpression(states, test);
    const testValue = unknownTest ? null : test ? literalBoolean(test) : true;
    let header = atLeastOnce ? stateMap() : input;
    let bodyInput = atLeastOnce ? input : preTest(header);
    let previous = null;
    let normalExits = atLeastOnce || testValue === true
      ? stateMap()
      : preTest(header);
    while (
      !previous ||
      !sameStates(previous.header, header) ||
      !sameStates(previous.bodyInput, bodyInput)
    ) {
      previous = { header, bodyInput };
      const bodyOutcome =
        testValue === false && !atLeastOnce
          ? normalOutcome(stateMap())
          : analyzeStatement(body, bodyInput);
      propagated = mergeOutcomes(propagated, {
        ...emptyOutcome(),
        return: bodyOutcome.return,
        throw: bodyOutcome.throw,
      });
      normalExits = mergeStates(
        normalExits,
        itemsToStates(bodyOutcome.break),
      );
      let back = mergeStates(
        itemsToStates(bodyOutcome.normal),
        itemsToStates(bodyOutcome.continue),
      );
      back = applyLoopExpression(back, incrementor);
      if (atLeastOnce) {
        const tested = preTest(back);
        if (testValue !== true) normalExits = mergeStates(normalExits, tested);
        bodyInput = testValue === false
          ? stateMap()
          : mergeStates(input, tested);
        header = mergeStates(input, back);
      } else {
        header = mergeStates(input, back);
        const tested = preTest(header);
        if (testValue !== true) normalExits = mergeStates(normalExits, tested);
        bodyInput = testValue === false ? stateMap() : tested;
      }
    }
    const result = propagated;
    for (const state of normalExits.values()) addOutcome(result, "normal", { state });
    return result;
  };

  analyzeStatement = (statement, input) => {
    if (ts.isBlock(statement)) return analyzeBlock(statement, input);
    if (ts.isIfStatement(statement)) {
      const conditionFlow = applyExpression(input, statement.expression);
      const conditioned = conditionFlow.normal;
      const value = literalBoolean(statement.expression);
      const thenInput = conditioned;
      const elseInput = memberImpliesGuards.has(statement)
        ? stateMap(
            [...conditioned.values()].filter((state) =>
              !(state.seen && state.member)),
          )
        : sinkImpliesGuards.has(statement)
          ? stateMap(
              [...conditioned.values()].filter((state) => !state.seen),
            )
        : pendingImpliesGuards.has(statement)
          ? stateMap(
              [...conditioned.values()].filter((state) =>
                !(state.seen && !state.covered)),
            )
        : conditioned;
      const thenOutcome = value === false
        ? normalOutcome(stateMap())
        : analyzeStatement(statement.thenStatement, thenInput);
      const elseOutcome = value === true
        ? normalOutcome(stateMap())
        : statement.elseStatement
          ? analyzeStatement(statement.elseStatement, elseInput)
          : normalOutcome(elseInput);
      const result = mergeOutcomes(thenOutcome, elseOutcome);
      for (const state of conditionFlow.throw.values()) {
        addOutcome(result, "throw", { state });
      }
      return result;
    }
    if (ts.isForStatement(statement)) {
      const initialization = applyExpression(input, statement.initializer);
      const loop = analyzeLoop(statement, initialization.normal, {
        body: statement.statement,
        test: statement.condition,
        incrementor: statement.incrementor,
        atLeastOnce: false,
      });
      for (const state of initialization.throw.values()) {
        addOutcome(loop, "throw", { state });
      }
      return loop;
    }
    if (ts.isWhileStatement(statement)) {
      return analyzeLoop(statement, input, {
        body: statement.statement,
        test: statement.expression,
        incrementor: null,
        atLeastOnce: false,
      });
    }
    if (ts.isDoStatement(statement)) {
      return analyzeLoop(statement, input, {
        body: statement.statement,
        test: statement.expression,
        incrementor: null,
        atLeastOnce: true,
      });
    }
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      const iteration = applyExpression(input, statement.expression);
      const loop = analyzeLoop(statement, iteration.normal, {
        body: statement.statement,
        test: null,
        incrementor: null,
        atLeastOnce: false,
        unknownTest: true,
      });
      for (const state of iteration.throw.values()) {
        addOutcome(loop, "throw", { state });
      }
      return loop;
    }
    if (ts.isTryStatement(statement)) {
      const tried = analyzeBlock(statement.tryBlock, input);
      let combined = tried;
      if (statement.catchClause) {
        const caught = analyzeBlock(
          statement.catchClause.block,
          itemsToStates(tried.throw),
        );
        combined = {
          ...tried,
          normal: mergeOutcomes(
            { ...emptyOutcome(), normal: tried.normal },
            { ...emptyOutcome(), normal: caught.normal },
          ).normal,
          return: mergeOutcomes(
            { ...emptyOutcome(), return: tried.return },
            { ...emptyOutcome(), return: caught.return },
          ).return,
          throw: caught.throw,
          break: mergeOutcomes(
            { ...emptyOutcome(), break: tried.break },
            { ...emptyOutcome(), break: caught.break },
          ).break,
          continue: mergeOutcomes(
            { ...emptyOutcome(), continue: tried.continue },
            { ...emptyOutcome(), continue: caught.continue },
          ).continue,
        };
      }
      if (!statement.finallyBlock) return combined;
      const result = emptyOutcome();
      for (const kind of Object.keys(combined)) {
        for (const item of combined[kind].values()) {
          const finalized = analyzeBlock(
            statement.finallyBlock,
            stateMap([item.state]),
          );
          for (const finalItem of finalized.normal.values()) {
            addOutcome(result, kind, {
              state: finalItem.state,
              exitKey: item.exitKey,
            });
          }
          for (const abruptKind of ["return", "throw", "break", "continue"]) {
            for (const finalItem of finalized[abruptKind].values()) {
              addOutcome(result, abruptKind, finalItem);
            }
          }
        }
      }
      return result;
    }
    if (ts.isReturnStatement(statement)) {
      const flow = applyExpression(input, statement.expression);
      const result = emptyOutcome();
      for (const state of flow.normal.values()) {
        addOutcome(result, "return", {
          state,
          exitKey: nodeKey(analysis.path, statement),
        });
      }
      for (const state of flow.throw.values()) {
        addOutcome(result, "throw", { state });
      }
      return result;
    }
    if (ts.isThrowStatement(statement)) {
      const flow = applyExpression(input, statement.expression);
      const result = emptyOutcome();
      for (const state of mergeStates(flow.normal, flow.throw).values()) {
        addOutcome(result, "throw", { state });
      }
      return result;
    }
    if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
      const flow = statement.label
        ? applyExpression(input, statement, true)
        : { normal: input, throw: stateMap() };
      const result = emptyOutcome();
      const kind = ts.isBreakStatement(statement) ? "break" : "continue";
      for (const state of flow.normal.values()) addOutcome(result, kind, { state });
      for (const state of flow.throw.values()) addOutcome(result, "throw", { state });
      return result;
    }
    if (ts.isSwitchStatement(statement) || ts.isLabeledStatement(statement)) {
      return expressionOutcome(input, statement, true);
    }
    return expressionOutcome(input, statement);
  };

  const outcome = analyzeBlock(callback.body, stateMap([initialState]));
  const normalItems = [
    ...outcome.return.values(),
    ...[...outcome.normal.values()].map((item) => ({
      ...item,
      exitKey: nodeKey(analysis.path, callback.body),
    })),
  ];
  const committing = normalItems.filter((item) =>
    item.state.seen && !ignoredExitNodes.has(
      [...ignoredExitNodes].find((node) =>
        item.exitKey === nodeKey(analysis.path, node)),
    ));
  const accepted = committing.filter((item) =>
    item.state.covered && !item.state.invalid);
  const pending = committing.filter((item) =>
    !item.state.covered && !item.state.invalid);
  const invalidated = committing.filter((item) => item.state.invalid);
  const keys = (items) =>
    [...new Set(items.map((item) => item.exitKey).filter(Boolean))].sort();
  return {
    valid:
      committing.length > 0 &&
      accepted.length === committing.length,
    normalExitKeys: keys(accepted),
    pendingExitKeys: keys(pending),
    invalidatedExitKeys: keys(invalidated),
    unseenExitKeys: keys(normalItems.filter((item) => !item.state.seen)),
    invalidationNodeKeys: [...invalidationNodeKeys].sort(),
  };
}

function directPatchCertificate(
  write,
  writes,
  callback,
  transactionBinding,
  scope,
  analysis,
) {
  if (!isJoinedWrite(write._node, callback)) return null;
  const patches = writes
    .map((candidate) => ({
      write: candidate,
      scope: directPatchScope(candidate, callback, transactionBinding, analysis),
    }))
    .filter((candidate) => candidate.scope?.key === scope.key);
  for (const patch of patches) {
    const relation = commonBlockRelation(patch.write._node, write._node, callback);
    if (!relation) {
      let owningTry = null;
      for (let current = write._node.parent; current && current !== callback; current = current.parent) {
        if (ts.isTryStatement(current)) {
          owningTry = current;
          break;
        }
      }
      const finallyBlock = owningTry?.finallyBlock;
      const patchStatement = finallyBlock &&
        directChildOfBlock(patch.write._node, finallyBlock);
      if (
        finallyBlock &&
        patchStatement &&
        patchStatement === directStatement(patch.write._node) &&
        finallyBlock.statements
          .slice(0, finallyBlock.statements.indexOf(patchStatement))
          .every((statement) =>
            !hasNormalReturn(statement) &&
            !statementInvalidatesTransaction(
              statement,
              transactionBinding,
              analysis,
            )) &&
        scopeExpressionStable(
          scope.issueExpression,
          callback,
          analysis,
          write._node.pos,
          callback.body.end,
          [
            outermostWriteCall(write._node),
            ...patches.map((candidate) =>
              outermostWriteCall(candidate.write._node)),
          ],
          transactionBinding,
        )
      ) {
        const exits = normalExitKeys(callback, analysis.path, write._node.pos);
        return {
          coverageKind: "direct_patch",
          coverageScopeKeys: [patch.scope.key],
          normalExitKeys: exits,
          proofNodes: [
            ...scope.proofNodes,
            ...patch.scope.proofNodes,
            nodeKey(analysis.path, owningTry),
            nodeKey(analysis.path, finallyBlock),
            ...exits,
          ],
          proofRoles: [
            "direct_patch_after",
            "finally",
            "normal_exit",
            "pending_obligation",
          ],
          callSite: nodeKey(analysis.path, patch.write._node),
          edgeNode: patch.write._node,
          helperPath: patch.write.versionedHelperPath,
          flowCoverageNodes: patches.map((candidate) => candidate.write._node),
        };
      }
    }
    if (
      !relation ||
      relationHasNormalGap(relation, transactionBinding, analysis)
    ) {
      continue;
    }
    const before = relation.firstIndex < relation.secondIndex;
    const patchIsUnconditional = directChildOfBlock(patch.write._node, relation.block) ===
      directStatement(patch.write._node);
    if (!patchIsUnconditional) continue;
    if (!before && relation.second !== directStatement(write._node) &&
        hasNormalReturn(relation.second)) {
      continue;
    }
    if (!before) {
      const between = relation.block.statements.slice(
        relation.secondIndex + 1,
        relation.firstIndex,
      );
      if (between.some(hasNormalReturn)) continue;
    }
    const stabilityStart = Math.min(patch.write._node.pos, write._node.pos);
    if (
      !scopeExpressionStable(
        scope.issueExpression,
        callback,
        analysis,
        stabilityStart,
        callback.body.end,
        [
          outermostWriteCall(write._node),
          ...patches.map((candidate) =>
            outermostWriteCall(candidate.write._node)),
        ],
        transactionBinding,
      ) ||
      !scopeExpressionStable(
        patch.scope.issueExpression,
        callback,
        analysis,
        stabilityStart,
        callback.body.end,
        [
          outermostWriteCall(write._node),
          ...patches.map((candidate) =>
            outermostWriteCall(candidate.write._node)),
        ],
        transactionBinding,
      )
    ) {
      continue;
    }
    const exits = normalExitKeys(callback, analysis.path, write._node.pos);
    if (exits.length === 0) continue;
    return {
      coverageKind: "direct_patch",
      coverageScopeKeys: [patch.scope.key],
      normalExitKeys: exits,
      proofNodes: [
        ...scope.proofNodes,
        ...patch.scope.proofNodes,
        nodeKey(analysis.path, relation.block),
        ...exits,
      ],
      proofRoles: [
        before ? "direct_patch_before" : "direct_patch_after",
        "normal_exit",
        "pending_obligation",
      ],
      callSite: nodeKey(analysis.path, patch.write._node),
      edgeNode: patch.write._node,
      helperPath: patch.write.versionedHelperPath,
      flowCoverageNodes: patches.map((candidate) => candidate.write._node),
    };
  }
  return null;
}

function exactImportedCallName(call, moduleName, names, analysis) {
  if (!ts.isCallExpression(call)) return null;
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee)) return null;
  const binding = analysis._aliasState.lexicalBindings.declarationFor(callee);
  const specifier = binding?.parent;
  const importDeclaration =
    specifier && ts.isImportSpecifier(specifier)
      ? specifier.parent.parent.parent
      : null;
  if (
    !importDeclaration ||
    !ts.isImportDeclaration(importDeclaration) ||
    !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
    importDeclaration.moduleSpecifier.text !== moduleName
  ) {
    return null;
  }
  const imported = specifier.propertyName?.text ?? specifier.name.text;
  return names.includes(imported) ? imported : null;
}

function exactColumn(expression, table, column, analysis) {
  const current = unwrap(expression);
  if (!ts.isPropertyAccessExpression(current) || current.name.text !== column) {
    return false;
  }
  return directTableReference(
    current.expression,
    analysis._aliasState.aliases,
    analysis._aliasState.namespaces,
    analysis._aliasState.helperAliases,
    analysis._aliasState.unresolvedAliases,
    analysis._aliasState.lexicalBindings,
  ) === table;
}

function emptySetBindings(callback, analysis) {
  const bindings = [];
  function visit(node) {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isConstDeclaration(node) &&
      !analysis._aliasState.assigned.has(node.name) &&
      node.initializer
    ) {
      const initializer = unwrap(node.initializer);
      if (
        ts.isNewExpression(initializer) &&
        ts.isIdentifier(unwrap(initializer.expression)) &&
        unwrap(initializer.expression).text === "Set" &&
        !analysis._aliasState.lexicalBindings.declarationFor(
          unwrap(initializer.expression),
        ) &&
        (initializer.arguments?.length ?? 0) === 0
      ) {
        bindings.push({
          binding: node.name,
          declaration: node,
          setKey: `SET:${symbolKey(analysis.path, node.name)}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return bindings;
}

function exactSetReceiver(call, binding, memberName, analysis) {
  const member = callMember(call);
  const receiver = member && unwrap(member.receiver);
  return Boolean(
    member &&
    !member.computed &&
    member.name === memberName &&
    receiver &&
    ts.isIdentifier(receiver) &&
    analysis._aliasState.lexicalBindings.declarationFor(receiver) === binding,
  );
}

function accumulatorTerminalPatch(
  candidate,
  callback,
  transactionBinding,
  set,
  analysis,
) {
  if (
    candidate.table !== "issues" ||
    candidate.operation !== "update" ||
    candidate.versionedBy !== "versionedIssuePatch" ||
    candidate.transactionCallback !== callback ||
    transactionReceiverBinding(candidate, analysis) !== transactionBinding ||
    !isJoinedWrite(candidate._node, callback)
  ) {
    return null;
  }
  const where = chainCall(candidate._node, "where");
  if (!where || where.arguments.length !== 1) return null;
  const predicate = unwrap(where.arguments[0]);
  const terminalCalls =
    ts.isCallExpression(predicate) &&
    exactImportedCallName(predicate, "drizzle-orm", ["and"], analysis) === "and"
      ? [...predicate.arguments]
      : [predicate];
  if (terminalCalls.length !== 1 && terminalCalls.length !== 2) return null;
  let inArrayCall = null;
  let tenantCall = null;
  const orderedPredicateKinds = [];
  for (const expression of terminalCalls) {
    const call = unwrap(expression);
    if (!ts.isCallExpression(call)) return null;
    const name = exactImportedCallName(
      call,
      "drizzle-orm",
      ["eq", "inArray"],
      analysis,
    );
    orderedPredicateKinds.push(name);
    if (name === "inArray") {
      if (inArrayCall || call.arguments.length !== 2) return null;
      const ids = unwrap(call.arguments[1]);
      if (
        !exactColumn(call.arguments[0], "issues", "id", analysis) ||
        !ts.isArrayLiteralExpression(ids) ||
        ids.elements.length !== 1 ||
        !ts.isSpreadElement(ids.elements[0]) ||
        !ts.isIdentifier(unwrap(ids.elements[0].expression)) ||
        analysis._aliasState.lexicalBindings.declarationFor(
          unwrap(ids.elements[0].expression),
        ) !== set.binding
      ) {
        return null;
      }
      inArrayCall = call;
    } else if (name === "eq") {
      if (
        tenantCall ||
        call.arguments.length !== 2 ||
        !exactColumn(call.arguments[0], "issues", "companyId", analysis)
      ) {
        return null;
      }
      const tenantKey = exactStableAtom(call.arguments[1], analysis);
      if (!tenantKey) return null;
      tenantCall = { call, key: tenantKey };
    } else {
      return null;
    }
  }
  if (!inArrayCall || (terminalCalls.length === 2 && !tenantCall)) return null;
  if (
    terminalCalls.length === 2 &&
    !(
      orderedPredicateKinds.join(",") === "inArray,eq" ||
      orderedPredicateKinds.join(",") === "eq,inArray"
    )
  ) {
    return null;
  }
  const guard = (() => {
    for (let current = candidate._node; current && current !== callback; current = current.parent) {
      if (!ts.isIfStatement(current)) continue;
      const condition = unwrap(current.expression);
      if (!ts.isBinaryExpression(condition)) return null;
      const left = unwrap(condition.left);
      const right = unwrap(condition.right);
      const size =
        ts.isPropertyAccessExpression(left) &&
        left.name.text === "size" &&
        ts.isIdentifier(unwrap(left.expression)) &&
        analysis._aliasState.lexicalBindings.declarationFor(
          unwrap(left.expression),
        ) === set.binding;
      const nonempty =
        ts.isNumericLiteral(right) &&
        right.text === "0" &&
        (
          condition.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
          condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        );
      return size && nonempty ? current : null;
    }
    return null;
  })();
  if (!guard) return null;
  return {
    write: candidate,
    inArrayCall,
    tenantCall,
    guard,
    orderedPredicateKinds,
  };
}

function parentExistenceProof(
  sink,
  issueKey,
  tenantKey,
  transactionBinding,
  analysis,
) {
  const sinkStatement = directStatement(sink._node);
  const block = sinkStatement?.parent;
  if (!block || !ts.isBlock(block)) return null;
  const sinkIndex = block.statements.indexOf(sinkStatement);
  for (let index = 0; index < sinkIndex; index += 1) {
    const statement = block.statements[index];
    if (
      !ts.isVariableStatement(statement) ||
      statement.declarationList.declarations.length !== 1 ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !isConstDeclaration(declaration) ||
        analysis._aliasState.assigned.has(declaration.name)
      ) {
        continue;
      }
      let expression = unwrap(declaration.initializer);
      if (!ts.isAwaitExpression(expression)) continue;
      expression = unwrap(expression.expression);
      if (!ts.isCallExpression(expression)) continue;
      const chain = expressionCallChain(expression);
      if (
        chain.map((item) => item.name).join(",") !== "select,from,where,then" ||
        chain.some((item) => callMember(item.call)?.computed || item.call.questionDotToken)
      ) {
        continue;
      }
      const select = chain[0].call;
      const receiver = unwrap(chain[0].receiver);
      const projection =
        select.arguments.length === 1 ? unwrap(select.arguments[0]) : null;
      const projectionProperty =
        projection &&
        ts.isObjectLiteralExpression(projection) &&
        projection.properties.length === 1 &&
        ts.isPropertyAssignment(projection.properties[0])
          ? projection.properties[0]
          : null;
      const from = chain[1].call;
      const where = chain[2].call;
      const then = chain[3].call;
      const thenCallback =
        then.arguments.length === 1 ? unwrap(then.arguments[0]) : null;
      if (
        !ts.isIdentifier(receiver) ||
        analysis._aliasState.lexicalBindings.declarationFor(receiver) !==
          transactionBinding ||
        !projectionProperty ||
        literalName(projectionProperty.name) !== "id" ||
        !exactColumn(projectionProperty.initializer, "issues", "id", analysis) ||
        from.arguments.length !== 1 ||
        directTableReference(
          from.arguments[0],
          analysis._aliasState.aliases,
          analysis._aliasState.namespaces,
          analysis._aliasState.helperAliases,
          analysis._aliasState.unresolvedAliases,
          analysis._aliasState.lexicalBindings,
        ) !== "issues" ||
        where.arguments.length !== 1 ||
        !thenCallback ||
        (
          !ts.isArrowFunction(thenCallback) &&
          !ts.isFunctionExpression(thenCallback)
        )
      ) {
        continue;
      }
      const rowsBinding = exactCallbackParameter(thenCallback);
      const resultExpression = exactCallbackReturnExpression(thenCallback);
      const result =
        resultExpression && ts.isBinaryExpression(unwrap(resultExpression))
          ? unwrap(resultExpression)
          : null;
      const firstRow = result && unwrap(result.left);
      if (
        !rowsBinding ||
        !result ||
        result.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
        !ts.isElementAccessExpression(firstRow) ||
        !ts.isIdentifier(unwrap(firstRow.expression)) ||
        analysis._aliasState.lexicalBindings.declarationFor(
          unwrap(firstRow.expression),
        ) !== rowsBinding ||
        !firstRow.argumentExpression ||
        !ts.isNumericLiteral(unwrap(firstRow.argumentExpression)) ||
        unwrap(firstRow.argumentExpression).text !== "0" ||
        unwrap(result.right).kind !== ts.SyntaxKind.NullKeyword
      ) {
        continue;
      }
      const predicate = exactPredicate(where.arguments[0], analysis);
      if (
        !predicate ||
        predicate.kind !== "and" ||
        predicate.children.length !== 2 ||
        predicate.children[0].kind !== "eq" ||
        predicate.children[0].table !== "issues" ||
        predicate.children[0].column !== "id" ||
        predicate.children[0].atom !== issueKey ||
        predicate.children[1].kind !== "eq" ||
        predicate.children[1].table !== "issues" ||
        predicate.children[1].column !== "companyId" ||
        predicate.children[1].atom !== tenantKey
      ) {
        continue;
      }
      let guardUse = null;
      const guard = block.statements.slice(index + 1, sinkIndex).find((candidate) => {
        if (!ts.isIfStatement(candidate)) return false;
        const condition = unwrap(candidate.expression);
        const operand =
          ts.isPrefixUnaryExpression(condition) &&
          condition.operator === ts.SyntaxKind.ExclamationToken
            ? unwrap(condition.operand)
            : null;
        const exactGuard =
          operand &&
          ts.isIdentifier(operand) &&
          analysis._aliasState.lexicalBindings.declarationFor(
            operand,
          ) === declaration.name;
        const terminating =
          ts.isContinueStatement(candidate.thenStatement) ||
          ts.isReturnStatement(candidate.thenStatement) ||
          ts.isThrowStatement(candidate.thenStatement) ||
          (
            ts.isBlock(candidate.thenStatement) &&
            candidate.thenStatement.statements.length === 1 &&
            (
              ts.isContinueStatement(candidate.thenStatement.statements[0]) ||
              ts.isReturnStatement(candidate.thenStatement.statements[0]) ||
              ts.isThrowStatement(candidate.thenStatement.statements[0])
            )
          );
        if (exactGuard && terminating) guardUse = operand;
        return exactGuard && terminating;
      });
      if (
        guard &&
        guardUse &&
        bindingUsesOnly(declaration.name, [guardUse], analysis)
      ) {
        return {
          declaration,
          guard,
          proofNodes: [
            nodeKey(analysis.path, declaration),
            ...chain.map((item) => nodeKey(analysis.path, item.call)),
            nodeKey(analysis.path, thenCallback),
            nodeKey(analysis.path, result),
            ...predicate.proofNodes,
            nodeKey(analysis.path, guard),
          ],
        };
      }
    }
  }
  return null;
}

function accumulatorSetUses(set, terminal, callback, analysis) {
  const addCalls = [];
  let valid = true;
  function visit(node) {
    if (!valid || (node !== callback.body && ts.isFunctionLike(node))) return;
    if (
      ts.isIdentifier(node) &&
      node !== set.binding &&
      analysis._aliasState.lexicalBindings.declarationFor(node) === set.binding
    ) {
      const parent = node.parent;
      if (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === node
      ) {
        const owner = parent.parent;
        if (
          ts.isCallExpression(owner) &&
          owner.expression === parent &&
          exactSetReceiver(owner, set.binding, "add", analysis) &&
          owner.arguments.length === 1 &&
          exactIssueIdentity(owner.arguments[0], analysis)
        ) {
          addCalls.push(owner);
          return;
        }
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.name.text === "size" &&
          parent.pos >= terminal.guard.expression.pos &&
          parent.end <= terminal.guard.expression.end
        ) {
          return;
        }
      }
      if (
        ts.isSpreadElement(parent) &&
        parent.expression === node &&
        parent.pos >= terminal.inArrayCall.pos &&
        parent.end <= terminal.inArrayCall.end
      ) {
        return;
      }
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return valid && addCalls.every((call) => call.pos < terminal.write._node.pos)
    ? addCalls
    : null;
}

function accumulatorPatchCertificate(
  write,
  writes,
  callback,
  transactionBinding,
  scope,
  analysis,
) {
  if (
    scope.kind !== "ExactIssue" ||
    write.operation !== "insert" ||
    !isJoinedWrite(write._node, callback)
  ) {
    return null;
  }
  const values = chainCall(write._node, "values");
  const companyExpression = values?.arguments.length === 1
    ? exactObjectPropertyValue(values.arguments[0], "companyId")
    : null;
  const tenantKey = companyExpression && exactStableAtom(companyExpression, analysis);
  for (const set of emptySetBindings(callback, analysis)) {
    for (const candidate of writes) {
      const terminal = accumulatorTerminalPatch(
        candidate,
        callback,
        transactionBinding,
        set,
        analysis,
      );
      if (
        !terminal ||
        (
          terminal.tenantCall &&
          (!tenantKey || terminal.tenantCall.key !== tenantKey)
        )
      ) {
        continue;
      }
      const sinkStatement = directStatement(write._node);
      const sinkBlock = sinkStatement?.parent;
      if (!sinkBlock || !ts.isBlock(sinkBlock)) continue;
      const sinkIndex = sinkBlock.statements.indexOf(sinkStatement);
      const add = sinkBlock.statements.slice(sinkIndex + 1).find((statement) => {
        if (!ts.isExpressionStatement(statement)) return false;
        const call = unwrap(statement.expression);
        return ts.isCallExpression(call) &&
          exactSetReceiver(call, set.binding, "add", analysis) &&
          call.arguments.length === 1 &&
          exactIssueIdentity(call.arguments[0], analysis) === scope.key;
      });
      if (!add) continue;
      const addCall = unwrap(add.expression);
      const addIndex = sinkBlock.statements.indexOf(add);
      const continuationGap = sinkBlock.statements
        .slice(sinkIndex + 1, addIndex)
        .some((statement) => {
          let found = false;
          function visit(node) {
            if (found || (node !== statement && ts.isFunctionLike(node))) return;
            if (
              ts.isContinueStatement(node) ||
              ts.isBreakStatement(node) ||
              ts.isReturnStatement(node)
            ) {
              found = true;
              return;
            }
            ts.forEachChild(node, visit);
          }
          visit(statement);
          return found;
        });
      if (continuationGap) continue;
      const parent = terminal.tenantCall
        ? parentExistenceProof(
            write,
            scope.key,
            tenantKey,
            transactionBinding,
            analysis,
          )
        : null;
      const allAdds = accumulatorSetUses(set, terminal, callback, analysis);
      const relation = commonBlockRelation(write._node, terminal.write._node, callback);
      if (
        (terminal.tenantCall && !parent) ||
        !allAdds ||
        !relation ||
        relation.firstIndex >= relation.secondIndex ||
        addCall.pos >= terminal.write._node.pos
      ) {
        continue;
      }
      const exits = normalExitKeys(callback, analysis.path, write._node.pos);
      return {
        coverageKind: "accumulator_bulk_patch",
        coverageScopeKeys: [set.setKey],
        normalExitKeys: exits,
        proofNodes: [
          ...scope.proofNodes,
          nodeKey(analysis.path, set.declaration),
          nodeKey(analysis.path, addCall),
          ...(parent?.proofNodes ?? []),
          nodeKey(analysis.path, terminal.guard),
          nodeKey(analysis.path, terminal.inArrayCall),
          ...(terminal.tenantCall
            ? [nodeKey(analysis.path, terminal.tenantCall.call)]
            : []),
          nodeKey(analysis.path, terminal.write._node),
          ...exits,
        ],
        proofRoles: [
          "pending_obligation",
          "accumulator_member",
          ...(parent ? ["parent_existence", "tenant_scope"] : []),
          "set_nonempty",
          "bulk_patch",
          "normal_exit",
        ],
        orderedPredicateKinds: terminal.orderedPredicateKinds,
        callSite: nodeKey(analysis.path, terminal.write._node),
        edgeNode: terminal.write._node,
        helperPath: terminal.write.versionedHelperPath,
        flowCoverageNodes: [terminal.write._node],
        flowMemberNodes: [addCall],
        flowMemberImpliesGuards: [terminal.guard],
        flowRequiresMember: true,
      };
    }
  }
  return null;
}

function exportedExecutable(module, exportName) {
  const candidates = [];
  for (const statement of module.sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement) ?? []
      : [];
    const exported = modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (
      exported &&
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === exportName &&
      statement.body
    ) {
      candidates.push(statement);
    } else if (exported && ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === exportName
        ) {
          const executable = resolveExecutableFunctionLike(declaration);
          if (executable) candidates.push(executable);
        }
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveImportedExecutable(call, analysis) {
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee) || !analysis._resolveModuleSource) return null;
  const binding = analysis._aliasState.lexicalBindings.declarationFor(callee);
  const specifier = binding?.parent;
  const importDeclaration =
    specifier && ts.isImportSpecifier(specifier)
      ? specifier.parent.parent.parent
      : null;
  if (
    !importDeclaration ||
    !ts.isImportDeclaration(importDeclaration) ||
    !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
    !importDeclaration.moduleSpecifier.text.startsWith(".") ||
    specifier.name.text !== callee.text
  ) {
    return null;
  }
  const exportName = specifier.propertyName?.text ?? specifier.name.text;
  const resolved = analysis._resolveModuleSource(
    analysis.path,
    importDeclaration.moduleSpecifier.text,
  );
  if (!resolved?.path || typeof resolved.source !== "string") return null;
  const sourceFile = ts.createSourceFile(
    resolved.path,
    resolved.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const executable = exportedExecutable({ sourceFile }, exportName);
  return executable
    ? {
        path: normalizePath(resolved.path),
        source: resolved.source,
        sourceFile,
        executable,
        exportName,
        importDeclaration,
        specifier,
      }
    : null;
}

function wrapperReexportsVersionedPatch(module) {
  return module.sourceFile.statements.some((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return false;
    }
    return (
      statement.moduleSpecifier.text === "@paperclipai/db" &&
      statement.exportClause.elements.some((specifier) =>
        specifier.name.text === "versionedIssuePatch" &&
        (specifier.propertyName?.text ?? specifier.name.text) ===
          "versionedIssuePatch")
    );
  });
}

function exactWrapperMapSuffix(write, distinctBinding, moduleAnalysis) {
  const calls = chainCalls(write._node);
  if (calls.map((candidate) => candidate.name).join(",") !==
      "set,where,returning,then") {
    return null;
  }
  const where = calls[1].call;
  const predicate = where.arguments.length === 1 ? unwrap(where.arguments[0]) : null;
  if (
    !predicate ||
    !ts.isCallExpression(predicate) ||
    exactImportedCallName(
      predicate,
      "drizzle-orm",
      ["inArray"],
      moduleAnalysis,
    ) !== "inArray" ||
    predicate.arguments.length !== 2 ||
    !exactColumn(predicate.arguments[0], "issues", "id", moduleAnalysis) ||
    !ts.isIdentifier(unwrap(predicate.arguments[1])) ||
    moduleAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(predicate.arguments[1]),
    ) !== distinctBinding
  ) {
    return null;
  }
  const returning = calls[2].call;
  const projection = returning.arguments.length === 1
    ? unwrap(returning.arguments[0])
    : null;
  if (
    !projection ||
    !ts.isObjectLiteralExpression(projection) ||
    projection.properties.length !== 1 ||
    !ts.isPropertyAssignment(projection.properties[0]) ||
    literalName(projection.properties[0].name) !== "id" ||
    !exactColumn(projection.properties[0].initializer, "issues", "id", moduleAnalysis)
  ) {
    return null;
  }
  const then = calls[3].call;
  if (then.arguments.length !== 1) return null;
  const callback = unwrap(then.arguments[0]);
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !exactCallbackParameter(callback)
  ) {
    return null;
  }
  const map = exactCallbackReturnExpression(callback);
  const mapCall = map && unwrap(map);
  if (
    !mapCall ||
    !ts.isCallExpression(mapCall) ||
    !ts.isPropertyAccessExpression(mapCall.expression) ||
    mapCall.expression.name.text !== "map" ||
    !ts.isIdentifier(unwrap(mapCall.expression.expression)) ||
    moduleAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(mapCall.expression.expression),
    ) !== callback.parameters[0].name ||
    mapCall.arguments.length !== 1
  ) {
    return null;
  }
  const mapCallback = unwrap(mapCall.arguments[0]);
  if (
    (!ts.isArrowFunction(mapCallback) && !ts.isFunctionExpression(mapCallback)) ||
    !exactCallbackParameter(mapCallback)
  ) {
    return null;
  }
  const output = exactCallbackReturnExpression(mapCallback);
  return (
    output &&
    ts.isPropertyAccessExpression(unwrap(output)) &&
    unwrap(output).name.text === "id" &&
    ts.isIdentifier(unwrap(output).expression) &&
    moduleAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(output).expression,
    ) === mapCallback.parameters[0].name
  )
    ? {
        predicate,
        returning,
        then,
        mapCall,
      }
    : null;
}

function derivedPatchWrapper(call, analysis) {
  const importedModule = resolveImportedExecutable(call, analysis);
  const localRecord = importedModule
    ? null
    : analysis._registry.resolveCallee(call.expression);
  const module = importedModule ?? (
    localRecord
      ? {
          path: analysis.path,
          sourceFile: analysis._sourceFile,
          executable: localRecord._node,
          exportName: null,
          importDeclaration: null,
          specifier: null,
        }
      : null
  );
  const imported = Boolean(importedModule);
  if (
    !module ||
    !ts.isBlock(module.executable.body) ||
    module.executable.parameters.length < 2 ||
    hasSyntheticThisParameter(module.executable) !== false
  ) {
    return null;
  }
  let transactionParameter = module.executable.parameters[0];
  let setParameter = module.executable.parameters[1];
  if (
    !ts.isIdentifier(transactionParameter.name) ||
    !ts.isIdentifier(setParameter.name) ||
    transactionParameter.dotDotDotToken ||
    transactionParameter.initializer ||
    transactionParameter.questionToken ||
    setParameter.dotDotDotToken ||
    setParameter.initializer ||
    setParameter.questionToken
  ) {
    return null;
  }
  const moduleWrites = imported
    ? collectIssueWritesFromSource(
        module.path,
        module.source,
        {
          resolveNamedImport: analysis._resolveNamedImport,
          resolveModuleSource: analysis._resolveModuleSource,
        },
      )
    : analysis._allWrites;
  const moduleAnalysis = imported ? moduleWrites.contractAnalysis : analysis;
  const executable = imported
    ? moduleAnalysis._registry.records.find(
        (record) =>
          record.symbolKey ===
          symbolKey(module.path, functionDeclarationNode(module.executable)),
      )?._node
    : module.executable;
  if (!executable || !ts.isBlock(executable.body)) return null;
  transactionParameter = executable.parameters[0];
  setParameter = executable.parameters[1];
  const statements = [...executable.body.statements];
  if (statements.length !== 3) return null;
  const [dedupStatement, guard, terminalReturn] = statements;
  if (
    !ts.isVariableStatement(dedupStatement) ||
    dedupStatement.declarationList.declarations.length !== 1 ||
    (dedupStatement.declarationList.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const distinctDeclaration = dedupStatement.declarationList.declarations[0];
  if (
    !ts.isIdentifier(distinctDeclaration.name) ||
    !distinctDeclaration.initializer ||
    !ts.isArrayLiteralExpression(unwrap(distinctDeclaration.initializer))
  ) {
    return null;
  }
  const dedupArray = unwrap(distinctDeclaration.initializer);
  if (
    dedupArray.elements.length !== 1 ||
    !ts.isSpreadElement(dedupArray.elements[0])
  ) {
    return null;
  }
  const newSet = unwrap(dedupArray.elements[0].expression);
  if (
    !ts.isNewExpression(newSet) ||
    !ts.isIdentifier(unwrap(newSet.expression)) ||
    unwrap(newSet.expression).text !== "Set" ||
    moduleAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(newSet.expression),
    ) ||
    (newSet.arguments?.length ?? 0) !== 1 ||
    !ts.isIdentifier(unwrap(newSet.arguments[0])) ||
    moduleAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(newSet.arguments[0]),
    ) !== setParameter.name
  ) {
    return null;
  }
  const condition = ts.isIfStatement(guard) ? unwrap(guard.expression) : null;
  const guardReturn =
    ts.isIfStatement(guard) &&
    !guard.elseStatement &&
    (
      ts.isReturnStatement(guard.thenStatement)
        ? guard.thenStatement
        : ts.isBlock(guard.thenStatement) &&
            guard.thenStatement.statements.length === 1 &&
            ts.isReturnStatement(guard.thenStatement.statements[0])
          ? guard.thenStatement.statements[0]
          : null
    );
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !ts.isPropertyAccessExpression(unwrap(condition.left)) ||
    unwrap(condition.left).name.text !== "length" ||
    !ts.isIdentifier(unwrap(condition.left).expression) ||
    moduleAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(condition.left).expression,
    ) !== distinctDeclaration.name ||
    !ts.isNumericLiteral(unwrap(condition.right)) ||
    unwrap(condition.right).text !== "0" ||
    !guardReturn?.expression ||
    !ts.isArrayLiteralExpression(unwrap(guardReturn.expression)) ||
    unwrap(guardReturn.expression).elements.length !== 0 ||
    !ts.isReturnStatement(terminalReturn) ||
    !terminalReturn.expression
  ) {
    return null;
  }
  const awaited = unwrap(terminalReturn.expression);
  if (!ts.isAwaitExpression(awaited)) return null;
  const terminalExpression = unwrap(awaited.expression);
  const update = moduleWrites.find((candidate) =>
    candidate.table === "issues" &&
    candidate.operation === "update" &&
    candidate.versionedBy === "versionedIssuePatch" &&
    candidate._node.pos >= executable.body.pos &&
    candidate._node.end <= executable.body.end);
  const helperPath = imported ? module.path : update?.versionedHelperPath;
  if (
    !update ||
    outermostWriteCall(update._node) !== terminalExpression ||
    transactionReceiverBinding(update, moduleAnalysis) !== transactionParameter.name ||
    !isTrustedHelperPair({
      helperExport: "versionedIssuePatch",
      helperPath,
    }) ||
    (
      imported &&
      (
        update.versionedHelperPath !== "packages/db/src/issue-versioning.ts" ||
        !wrapperReexportsVersionedPatch(module)
      )
    )
  ) {
    return null;
  }
  const suffix = exactWrapperMapSuffix(
    update,
    distinctDeclaration.name,
    moduleAnalysis,
  );
  if (!suffix || !isTrustedHelperPair({
    helperExport: "versionedIssuePatch",
    helperPath,
  })) {
    return null;
  }
  return {
    ...module,
    executable,
    moduleAnalysis,
    transactionParameter,
    setParameter,
    distinctDeclaration,
    guard,
    guardReturn,
    terminalReturn,
    update,
    suffix,
    helperPath,
    proofNodes: [
      ...(module.importDeclaration
        ? [nodeKey(analysis.path, module.importDeclaration)]
        : []),
      nodeKey(module.path, executable),
      nodeKey(module.path, distinctDeclaration),
      nodeKey(module.path, guard),
      nodeKey(module.path, update._node),
      nodeKey(module.path, suffix.predicate),
      nodeKey(module.path, terminalReturn),
    ],
  };
}

function wrapperCallArgumentsAreExact(
  call,
  wrapper,
  callback,
  transactionBinding,
  analysis,
) {
  const executable = wrapper?.executable;
  if (
    !executable ||
    call.questionDotToken ||
    call.arguments.some((argument) => ts.isSpreadElement(argument)) ||
    call.arguments.length > executable.parameters.length
  ) {
    return false;
  }
  const transactionIndex = executable.parameters.indexOf(wrapper.transactionParameter);
  const setIndex = executable.parameters.indexOf(wrapper.setParameter);
  if (
    transactionIndex < 0 ||
    setIndex < 0 ||
    transactionIndex === setIndex ||
    transactionIndex >= call.arguments.length ||
    setIndex >= call.arguments.length
  ) {
    return false;
  }
  const transactionAliases = immutableAliasBindings(
    callback,
    transactionBinding,
    analysis._aliasState.lexicalBindings,
    analysis._aliasState.assigned,
  );
  const capabilityBindings = obligationCapabilityBindings(
    callback,
    transactionBinding,
    analysis,
  );
  const initializerPlan = parameterInitializerExecutionPlan(
    call,
    executable,
    capabilityBindings,
    analysis._aliasState.lexicalBindings,
  );
  if (!initializerPlan) return false;
  const capabilityArguments = call.arguments
    .map((argument, index) => ({
      index,
      identifiers: capabilityIdentifiers(
        argument,
        capabilityBindings,
        analysis._aliasState.lexicalBindings,
      ),
    }))
    .filter((candidate) => candidate.identifiers.length > 0);
  if (
    capabilityArguments.length !== 1 ||
    capabilityArguments[0].index !== transactionIndex ||
    !transactionAliases.has(
      exactArgumentBinding(call.arguments[transactionIndex], analysis),
    )
  ) {
    return false;
  }
  const wrapperPureInitializerPlan = new Set(
    [...initializerPlan].filter((index) => {
      const current = unwrap(executable.parameters[index]?.initializer);
      return !(
        current &&
        ts.isNewExpression(current) &&
        ts.isIdentifier(unwrap(current.expression)) &&
        unwrap(current.expression).text === "Date" &&
        !wrapper.moduleAnalysis._aliasState.lexicalBindings.declarationFor(
          unwrap(current.expression),
        ) &&
        (current.arguments?.length ?? 0) === 0
      );
    }),
  );
  Object.defineProperty(wrapperPureInitializerPlan, "_ordinaryParameterIndexes", {
    value: initializerPlan._ordinaryParameterIndexes ?? new Set(),
  });
  if (
    !activeParameterInitializersArePure(
      executable,
      wrapperPureInitializerPlan,
      wrapper.moduleAnalysis._aliasState.lexicalBindings,
      wrapper.moduleAnalysis._aliasState.assigned,
    )
  ) {
    return false;
  }
  for (let index = 0; index < executable.parameters.length; index += 1) {
    const parameter = executable.parameters[index];
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.dotDotDotToken ||
      parameter.questionToken
    ) {
      return false;
    }
    if (index >= call.arguments.length && !parameter.initializer) return false;
  }
  return true;
}

function finiteArrayBindingStable(binding, allowedUse, analysis) {
  let stable = true;
  function visit(node) {
    if (!stable) return;
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      analysis._aliasState.lexicalBindings.declarationFor(node) === binding
    ) {
      if (node === allowedUse) return;
      stable = false;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(analysis._sourceFile);
  return stable;
}

function exactFiniteArray(expression, analysis) {
  const current = unwrap(expression);
  let array = current;
  let binding = null;
  if (ts.isIdentifier(current)) {
    binding = analysis._aliasState.lexicalBindings.declarationFor(current);
    const declaration = binding?.parent;
    if (
      !binding ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.name !== binding ||
      !isConstDeclaration(declaration) ||
      analysis._aliasState.assigned.has(binding) ||
      !declaration.initializer ||
      !ts.isArrayLiteralExpression(unwrap(declaration.initializer)) ||
      !finiteArrayBindingStable(binding, current, analysis)
    ) {
      return null;
    }
    array = unwrap(declaration.initializer);
  }
  if (!ts.isArrayLiteralExpression(array)) return null;
  const members = [];
  for (const element of array.elements) {
    if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return null;
    const key = exactIssueIdentity(element, analysis);
    if (!key) return null;
    members.push({
      key,
      node: element,
      nodeKey: nodeKey(analysis.path, element),
    });
  }
  return {
    setKey: binding
      ? `SET:${symbolKey(analysis.path, binding)}`
      : `SETEXPR:${nodeKey(analysis.path, array)}`,
    array,
    members,
    proofNodes: [
      nodeKey(analysis.path, array),
      ...members.map((member) => member.nodeKey),
    ],
  };
}

function isJoinedCall(call, callback) {
  let current = call;
  while (
    current.parent &&
    (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)
    )
  ) {
    current = current.parent;
  }
  if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) {
    for (let owner = current.parent.parent; owner && owner !== callback; owner = owner.parent) {
      if (
        ts.isCallExpression(owner) &&
        ts.isPropertyAccessExpression(owner.expression) &&
        ts.isIdentifier(unwrap(owner.expression.expression)) &&
        unwrap(owner.expression.expression).text === "Promise" &&
        owner.expression.name.text === "all"
      ) {
        return false;
      }
      if (ts.isFunctionLike(owner)) return false;
    }
    return true;
  }
  return ts.isReturnStatement(current.parent) && current.parent.expression === current;
}

function wrapperPatchCertificate(
  write,
  callback,
  transactionBinding,
  scope,
  analysis,
) {
  if (scope.kind !== "ExactIssue" || !isJoinedWrite(write._node, callback)) {
    return null;
  }
  const calls = [];
  function collect(node) {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  }
  collect(callback.body);
  for (const call of calls) {
    if (
      call.arguments.length < 2 ||
      !isJoinedCall(call, callback)
    ) {
      continue;
    }
    const wrapper = derivedPatchWrapper(call, analysis);
    if (
      !wrapper ||
      !wrapperCallArgumentsAreExact(
        call,
        wrapper,
        callback,
        transactionBinding,
        analysis,
      )
    ) {
      continue;
    }
    const set = exactFiniteArray(call.arguments[1], analysis);
    if (!set || set.members.length === 0) continue;
    const member = set.members.find((candidate) => candidate.key === scope.key);
    if (
      !member ||
      !scopePathStableForCoverage(
        scope,
        callback,
        call,
        write,
        transactionBinding,
        analysis,
      )
    ) {
      continue;
    }
    const relation = commonBlockRelation(write._node, call, callback);
    if (
      !relation ||
      relationHasNormalGap(relation, transactionBinding, analysis)
    ) {
      continue;
    }
    const wrapperStatement = directStatement(call);
    if (directChildOfBlock(call, relation.block) !== wrapperStatement) continue;
    const exits = normalExitKeys(callback, analysis.path, write._node.pos);
    return {
      coverageKind: "derived_patch_wrapper",
      coverageScopeKeys: [set.setKey],
      normalExitKeys: exits,
      proofNodes: [
        ...scope.proofNodes,
        ...set.proofNodes,
        member.nodeKey,
        ...wrapper.proofNodes,
        nodeKey(analysis.path, call),
        ...exits,
      ],
      memberProofNodes: [nodeKey(analysis.path, set.array), member.nodeKey],
      proofRoles: [
        "pending_obligation",
        "finite_array",
        "Member",
        "dedup_membership",
        "derived_wrapper",
        "inner_versionedIssuePatch",
        "normal_exit",
      ],
      callSite: nodeKey(analysis.path, call),
      edgeNode: call,
      helperPath: wrapper.helperPath,
      flowCoverageNodes: [call],
    };
  }
  return null;
}

function expressionCallChain(expression) {
  const current = unwrap(expression);
  if (!ts.isCallExpression(current)) return [];
  const member = callMember(current);
  if (!member) return [{ call: current, name: null, receiver: null }];
  const prior = ts.isCallExpression(member.receiver)
    ? expressionCallChain(member.receiver)
    : [];
  return [...prior, { call: current, name: member.name, receiver: member.receiver }];
}

function exactRowsMap(call, sourceBinding, property, analysis) {
  if (call.arguments.length !== 1) return null;
  const callback = unwrap(call.arguments[0]);
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !exactCallbackParameter(callback)
  ) {
    return null;
  }
  const body = exactCallbackReturnExpression(callback);
  const map = body && unwrap(body);
  if (
    !map ||
    !ts.isCallExpression(map) ||
    !ts.isPropertyAccessExpression(map.expression) ||
    map.expression.name.text !== "map" ||
    !ts.isIdentifier(unwrap(map.expression.expression)) ||
    analysis._aliasState.lexicalBindings.declarationFor(
      unwrap(map.expression.expression),
    ) !== sourceBinding ||
    map.arguments.length !== 1
  ) {
    return null;
  }
  const mapper = unwrap(map.arguments[0]);
  if (
    (!ts.isArrowFunction(mapper) && !ts.isFunctionExpression(mapper)) ||
    !exactCallbackParameter(mapper)
  ) {
    return null;
  }
  const output = exactCallbackReturnExpression(mapper);
  return (
    output &&
    ts.isPropertyAccessExpression(unwrap(output)) &&
    unwrap(output).name.text === property &&
    ts.isIdentifier(unwrap(output).expression) &&
    analysis._aliasState.lexicalBindings.declarationFor(
      unwrap(output).expression,
    ) === mapper.parameters[0].name
  )
    ? { callback, map, mapper, output: unwrap(output) }
    : null;
}

function predicateProjection(callback, scope, transactionBinding, analysis) {
  if (scope.kind !== "ExactPredicate") return null;
  let result = null;
  function visit(node) {
    if (result || (node !== callback.body && ts.isFunctionLike(node))) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isConstDeclaration(node) &&
      node.initializer &&
      ts.isAwaitExpression(unwrap(node.initializer))
    ) {
      const expression = unwrap(unwrap(node.initializer).expression);
      const chain = expressionCallChain(expression);
      if (
        chain.map((item) => item.name).join(",") ===
          "selectDistinct,from,where,then" &&
        chain[0].call.arguments.length === 1 &&
        chain[1].call.arguments.length === 1 &&
        chain[2].call.arguments.length === 1
      ) {
        const rootReceiver = unwrap(chain[0].receiver);
        const projection = unwrap(chain[0].call.arguments[0]);
        const from = chain[1].call.arguments[0];
        const predicate = exactPredicate(chain[2].call.arguments[0], analysis);
        const map = exactRowsMap(
          chain[3].call,
          (() => {
            const callbackExpression = unwrap(chain[3].call.arguments[0]);
            return callbackExpression.parameters[0]?.name;
          })(),
          "issueId",
          analysis,
        );
        if (
          ts.isIdentifier(rootReceiver) &&
          analysis._aliasState.lexicalBindings.declarationFor(rootReceiver) ===
            transactionBinding &&
          ts.isObjectLiteralExpression(projection) &&
          projection.properties.length === 1 &&
          ts.isPropertyAssignment(projection.properties[0]) &&
          literalName(projection.properties[0].name) === "issueId" &&
          exactColumn(
            projection.properties[0].initializer,
            "issueComments",
            "issueId",
            analysis,
          ) &&
          directTableReference(
            from,
            analysis._aliasState.aliases,
            analysis._aliasState.namespaces,
            analysis._aliasState.helperAliases,
            analysis._aliasState.unresolvedAliases,
            analysis._aliasState.lexicalBindings,
          ) === "issueComments" &&
          predicate &&
          `PRED:${predicate.key}` === scope.key &&
          map
        ) {
          result = {
            binding: node.name,
            declaration: node,
            setKey: `SET:${symbolKey(analysis.path, node.name)}`,
            predicate,
            proofNodes: [
              nodeKey(analysis.path, node),
              ...predicate.proofNodes,
              nodeKey(analysis.path, chain[0].call),
              nodeKey(analysis.path, chain[3].call),
              nodeKey(analysis.path, map.map),
            ],
          };
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return result;
}

function returnedIssueSet(writes, callback, transactionBinding, analysis) {
  for (const write of writes) {
    if (
      write.table !== "issues" ||
      write.operation !== "update" ||
      write.versionedBy !== "versionedIssuePatch" ||
      write.transactionCallback !== callback ||
      transactionReceiverBinding(write, analysis) !== transactionBinding ||
      !isJoinedWrite(write._node, callback)
    ) {
      continue;
    }
    const outermost = outermostWriteCall(write._node);
    const awaited = outermost.parent;
    const declaration =
      ts.isAwaitExpression(awaited) &&
      ts.isVariableDeclaration(awaited.parent) &&
      awaited.parent.initializer === awaited &&
      ts.isIdentifier(awaited.parent.name) &&
      isConstDeclaration(awaited.parent)
        ? awaited.parent
        : null;
    if (!declaration) continue;
    const chain = chainCalls(write._node);
    if (
      chain.map((candidate) => candidate.name).join(",") !==
      "set,where,returning,then"
    ) {
      continue;
    }
    const returning = unwrap(chain[2].call.arguments[0]);
    if (
      chain[2].call.arguments.length !== 1 ||
      !ts.isObjectLiteralExpression(returning) ||
      returning.properties.length !== 1 ||
      !ts.isPropertyAssignment(returning.properties[0]) ||
      literalName(returning.properties[0].name) !== "id" ||
      !exactColumn(returning.properties[0].initializer, "issues", "id", analysis)
    ) {
      continue;
    }
    const thenCallback = unwrap(chain[3].call.arguments[0]);
    const map = exactRowsMap(
      chain[3].call,
      thenCallback.parameters?.[0]?.name,
      "id",
      analysis,
    );
    if (!map) continue;
    return {
      binding: declaration.name,
      declaration,
      write,
      setKey: `SET:${symbolKey(analysis.path, declaration.name)}`,
      proofNodes: [
        nodeKey(analysis.path, declaration),
        nodeKey(analysis.path, write._node),
        nodeKey(analysis.path, chain[2].call),
        nodeKey(analysis.path, map.map),
      ],
    };
  }
  return null;
}

function exactSetView(callback, sourceSet, analysis) {
  let result = null;
  function visit(node) {
    if (result || (node !== callback.body && ts.isFunctionLike(node))) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isConstDeclaration(node) &&
      node.initializer
    ) {
      const initializer = unwrap(node.initializer);
      if (
        ts.isNewExpression(initializer) &&
        ts.isIdentifier(unwrap(initializer.expression)) &&
        unwrap(initializer.expression).text === "Set" &&
        !analysis._aliasState.lexicalBindings.declarationFor(
          unwrap(initializer.expression),
        ) &&
        (initializer.arguments?.length ?? 0) === 1 &&
        ts.isIdentifier(unwrap(initializer.arguments[0])) &&
        analysis._aliasState.lexicalBindings.declarationFor(
          unwrap(initializer.arguments[0]),
        ) === sourceSet.binding
      ) {
        result = {
          binding: node.name,
          declaration: node,
          proofNodes: [nodeKey(analysis.path, node)],
        };
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return result;
}

function exactComplement(
  expression,
  sourceSet,
  directSetView,
  analysis,
) {
  const call = unwrap(expression);
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "filter" ||
    !ts.isIdentifier(unwrap(call.expression.expression)) ||
    analysis._aliasState.lexicalBindings.declarationFor(
      unwrap(call.expression.expression),
    ) !== sourceSet.binding ||
    call.arguments.length !== 1
  ) {
    return null;
  }
  const callback = unwrap(call.arguments[0]);
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !exactCallbackParameter(callback)
  ) {
    return null;
  }
  const body = exactCallbackReturnExpression(callback);
  const negation = body && unwrap(body);
  if (
    !negation ||
    !ts.isPrefixUnaryExpression(negation) ||
    negation.operator !== ts.SyntaxKind.ExclamationToken
  ) {
    return null;
  }
  const hasCall = unwrap(negation.operand);
  if (
    !ts.isCallExpression(hasCall) ||
    !exactSetReceiver(
      hasCall,
      directSetView.binding,
      "has",
      analysis,
    ) ||
    hasCall.arguments.length !== 1 ||
    !ts.isIdentifier(unwrap(hasCall.arguments[0])) ||
    analysis._aliasState.lexicalBindings.declarationFor(
      unwrap(hasCall.arguments[0]),
    ) !== callback.parameters[0].name
  ) {
    return null;
  }
  return {
    call,
    callback,
    hasCall,
    setKey: `SETEXPR:${nodeKey(analysis.path, call)}`,
    proofNodes: [
      nodeKey(analysis.path, call),
      nodeKey(analysis.path, callback),
      nodeKey(analysis.path, hasCall),
    ],
  };
}

function bindingUsesOnly(binding, allowedNodes, analysis) {
  const allowed = new Set(allowedNodes);
  let valid = true;
  function visit(node) {
    if (!valid) return;
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      analysis._aliasState.lexicalBindings.declarationFor(node) === binding &&
      !allowed.has(node)
    ) {
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(analysis._sourceFile);
  return valid;
}

function consumedSqlProof(callback, transactionBinding, analysis) {
  const templates = [];
  let invalid = false;
  function visit(node) {
    if (invalid || (node !== callback.body && ts.isFunctionLike(node))) return;
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = unwrap(node.tag);
      const binding = ts.isIdentifier(tag)
        ? analysis._aliasState.lexicalBindings.declarationFor(tag)
        : null;
      const specifier = binding?.parent;
      const importDeclaration =
        specifier && ts.isImportSpecifier(specifier)
          ? specifier.parent.parent.parent
          : null;
      if (
        !ts.isIdentifier(tag) ||
        !importDeclaration ||
        !ts.isImportDeclaration(importDeclaration) ||
        !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
        importDeclaration.moduleSpecifier.text !== "drizzle-orm" ||
        (specifier.propertyName?.text ?? specifier.name.text) !== "sql"
      ) {
        invalid = true;
        return;
      }
      if (
        capabilityIdentifiers(
          node,
          new Set([transactionBinding]),
          analysis._aliasState.lexicalBindings,
        ).length > 0
      ) {
        invalid = true;
        return;
      }
      let unsafeSubstitution = false;
      const substitutions = ts.isTemplateExpression(node.template)
        ? node.template.templateSpans.map((span) => span.expression)
        : [];
      function inspectSubstitution(expression, resolving = new Set()) {
        if (unsafeSubstitution) return;
        const current = unwrap(expression);
        if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
          unsafeSubstitution = true;
          return;
        }
        if (ts.isIdentifier(current)) {
          const binding = analysis._aliasState.lexicalBindings.declarationFor(current);
          const declaration = binding?.parent;
          if (
            binding &&
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            declaration.name === binding &&
            declaration.initializer &&
            !resolving.has(binding)
          ) {
            resolving.add(binding);
            inspectSubstitution(declaration.initializer, resolving);
            resolving.delete(binding);
          }
        }
        ts.forEachChild(current, (child) => inspectSubstitution(child, resolving));
      }
      for (const substitution of substitutions) inspectSubstitution(substitution);
      if (unsafeSubstitution) {
        invalid = true;
        return;
      }
      let operation = null;
      for (let current = node.parent; current && current !== callback; current = current.parent) {
        if (!ts.isCallExpression(current)) continue;
        const root = expressionCallChain(current).find((item) => {
          const receiver = item.receiver && unwrap(item.receiver);
          return (
            receiver &&
            ts.isIdentifier(receiver) &&
            analysis._aliasState.lexicalBindings.declarationFor(receiver) ===
              transactionBinding
          );
        });
        if (root) {
          operation = root.call;
          if (
            root.call.questionDotToken ||
            !["insert", "update", "delete"].includes(root.name) ||
            root.call.arguments.length !== 1 ||
            directTableReference(
              root.call.arguments[0],
              analysis._aliasState.aliases,
              analysis._aliasState.namespaces,
              analysis._aliasState.helperAliases,
              analysis._aliasState.unresolvedAliases,
              analysis._aliasState.lexicalBindings,
            ) ||
            !exactImportedOrdinaryTarget(root.call.arguments[0], analysis)
          ) {
            invalid = true;
          }
          break;
        }
      }
      if (!operation) invalid = true;
      else templates.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return invalid
    ? null
    : {
        templates,
        proofNodes: templates.map((template) => nodeKey(analysis.path, template)),
      };
}

function predicatePartitionCertificate(
  write,
  writes,
  callback,
  transactionBinding,
  scope,
  analysis,
) {
  if (!isJoinedWrite(write._node, callback)) return null;
  const projection = predicateProjection(
    callback,
    scope,
    transactionBinding,
    analysis,
  );
  if (!projection) return null;
  const directSet = returnedIssueSet(writes, callback, transactionBinding, analysis);
  if (!directSet) return null;
  const directSetView = exactSetView(callback, directSet, analysis);
  if (!directSetView) return null;
  const calls = [];
  function collect(node) {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  }
  collect(callback.body);
  for (const call of calls) {
    if (
      call.arguments.length < 2 ||
      !isJoinedCall(call, callback)
    ) {
      continue;
    }
    const wrapper = derivedPatchWrapper(call, analysis);
    const complement = exactComplement(
      call.arguments[1],
      projection,
      directSetView,
      analysis,
    );
    if (
      !wrapper ||
      !wrapperCallArgumentsAreExact(
        call,
        wrapper,
        callback,
        transactionBinding,
        analysis,
      ) ||
      !complement
    ) {
      continue;
    }
    const directSourceUse = unwrap(directSetView.declaration.initializer.arguments[0]);
    const projectionUse = unwrap(complement.call.expression.expression);
    const directViewUse = unwrap(complement.hasCall.expression.expression);
    if (
      !bindingUsesOnly(directSet.binding, [directSourceUse], analysis) ||
      !bindingUsesOnly(projection.binding, [projectionUse], analysis) ||
      !bindingUsesOnly(directSetView.binding, [directViewUse], analysis)
    ) {
      continue;
    }
    if (
      projection.declaration.pos >= directSet.declaration.pos ||
      directSet.declaration.pos >= directSetView.declaration.pos ||
      directSetView.declaration.pos >= call.pos ||
      call.pos >= write._node.pos
    ) {
      continue;
    }
    const wrapperStatement = directStatement(call);
    const callbackStatements = ts.isBlock(callback.body)
      ? callback.body.statements
      : [];
    if (
      callbackStatements.some((statement) =>
        statement !== wrapperStatement &&
        statement.pos > projection.declaration.pos &&
        statement.pos < write._node.pos &&
        statementInvalidatesTransaction(
          statement,
          transactionBinding,
          analysis,
        ))
    ) {
      continue;
    }
    const sql = consumedSqlProof(callback, transactionBinding, analysis);
    if (!sql) continue;
    const exits = normalExitKeys(callback, analysis.path, write._node.pos);
    return {
      scope: {
        kind: "ExactIssueSet",
        key: projection.setKey,
        proofNodes: [...scope.proofNodes, ...projection.proofNodes],
      },
      coverageKind: "predicate_partition",
      coverageScopeKeys: [directSet.setKey, complement.setKey],
      normalExitKeys: exits,
      proofNodes: [
        ...scope.proofNodes,
        ...projection.proofNodes,
        ...directSet.proofNodes,
        ...directSetView.proofNodes,
        ...complement.proofNodes,
        ...wrapper.proofNodes,
        ...sql.proofNodes,
        nodeKey(analysis.path, write._node),
        ...exits,
      ],
      proofRoles: [
        "pending_obligation",
        "predicate_projection",
        "direct_covered_set",
        "exact_complement",
        "partition_union",
        "derived_wrapper",
        "inner_versionedIssuePatch",
        ...(sql.templates.length > 0 ? ["consumed_sql"] : []),
        "normal_exit",
      ],
      callSite: nodeKey(analysis.path, call),
      edgeNode: call,
      helperPath: wrapper.helperPath,
      flowCoverageNodes: [call],
    };
  }
  return null;
}

function exactLiteralDiscriminant(expression, analysis) {
  const current = unwrap(expression);
  if (
    !ts.isBinaryExpression(current) ||
    ![
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(current.operatorToken.kind)
  ) {
    return null;
  }
  const leftKey = exactIssueIdentity(current.left, analysis);
  const rightKey = exactIssueIdentity(current.right, analysis);
  const leftLiteral = leftKey?.startsWith("LIT:") ? leftKey : null;
  const rightLiteral = rightKey?.startsWith("LIT:") ? rightKey : null;
  if (Boolean(leftLiteral) === Boolean(rightLiteral)) return null;
  return {
    discriminant: leftLiteral ? rightKey : leftKey,
    literal: leftLiteral ?? rightLiteral,
    equal: current.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken,
    node: current,
  };
}

function exactImportedOrdinaryTarget(expression, analysis) {
  const current = unwrap(expression);
  if (!ts.isIdentifier(current)) return false;
  const binding = analysis._aliasState.lexicalBindings.declarationFor(current);
  const specifier = binding?.parent;
  const importDeclaration =
    specifier && ts.isImportSpecifier(specifier)
      ? specifier.parent.parent.parent
      : null;
  return Boolean(
    importDeclaration &&
    ts.isImportDeclaration(importDeclaration) &&
    ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
    TABLE_IMPORT_MODULES.has(importDeclaration.moduleSpecifier.text) &&
    !TABLE_EXPORTS.has(specifier.propertyName?.text ?? specifier.name.text),
  );
}

function carrierEffectsAreKnown(
  carrier,
  transactionBinding,
  sink,
  analysis,
) {
  let valid = true;
  function visit(node) {
    if (!valid) return;
    if (node !== carrier.body && ts.isFunctionLike(node)) {
      valid = false;
      return;
    }
    if (ts.isCallExpression(node)) {
      const chain = expressionCallChain(node);
      const root = chain.find((item) => {
        const receiver = item.receiver && unwrap(item.receiver);
        return (
          receiver &&
          ts.isIdentifier(receiver) &&
          analysis._aliasState.lexicalBindings.declarationFor(receiver) ===
            transactionBinding
        );
      });
      if (root) {
        if (
          root.call.questionDotToken ||
          !root.name ||
          !["select", "insert", "update", "delete"].includes(root.name)
        ) {
          valid = false;
          return;
        }
        if (["insert", "update", "delete"].includes(root.name)) {
          if (root.call.arguments.length !== 1) {
            valid = false;
            return;
          }
          const table = directTableReference(
            root.call.arguments[0],
            analysis._aliasState.aliases,
            analysis._aliasState.namespaces,
            analysis._aliasState.helperAliases,
            analysis._aliasState.unresolvedAliases,
            analysis._aliasState.lexicalBindings,
          );
          if (!table && !exactImportedOrdinaryTarget(root.call.arguments[0], analysis)) {
            valid = false;
            return;
          }
          if (table === "issues") {
            const issueWrite = analysis._allWrites?.find(
              (write) => write._node === root.call,
            );
            if (
              !issueWrite ||
              issueWrite.operation !== "update" ||
              issueWrite.versionedBy !== "versionedIssuePatch"
            ) {
              valid = false;
              return;
            }
          }
          if (table === "issueComments" && root.call !== sink._node) {
            valid = false;
            return;
          }
        }
      } else if (
        node.arguments.some((argument) =>
          capabilityIdentifiers(
            argument,
            new Set([transactionBinding]),
            analysis._aliasState.lexicalBindings,
          ).length > 0)
      ) {
        valid = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(carrier.body);
  return valid;
}

function carrierResultUsesAreExact(
  declaration,
  resultGuard,
  callback,
  analysis,
) {
  const condition = unwrap(resultGuard.expression);
  const operand =
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken
      ? unwrap(condition.operand)
      : null;
  const guardUse =
    operand &&
    ts.isElementAccessExpression(operand) &&
    ts.isIdentifier(unwrap(operand.expression))
      ? unwrap(operand.expression)
      : null;
  if (
    !guardUse ||
    analysis._aliasState.lexicalBindings.declarationFor(guardUse) !==
      declaration.name
  ) {
    return false;
  }
  const uses = [];
  function visit(node) {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (
      ts.isIdentifier(node) &&
      node !== declaration.name &&
      analysis._aliasState.lexicalBindings.declarationFor(node) ===
        declaration.name
    ) {
      uses.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  uses.sort((left, right) => left.pos - right.pos || left.end - right.end);
  if (uses[0] !== guardUse) return false;
  return uses.every((use) => {
    if (use === guardUse) return true;
    const parent = use.parent;
    return (
      use.pos > resultGuard.end &&
      ts.isReturnStatement(parent) &&
      parent.expression === use
    );
  });
}

function sinkCarrier(write, callback, transactionBinding, scope, analysis) {
  let carrier = null;
  for (let current = write._node.parent; current && current !== callback; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      carrier = current;
      break;
    }
  }
  if (
    !carrier ||
    !carrier.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    carrier.parameters.length !== 0 ||
    !ts.isBlock(carrier.body)
  ) {
    return null;
  }
  let wrapped = carrier;
  while (
    wrapped.parent &&
    (
      ts.isParenthesizedExpression(wrapped.parent) ||
      ts.isAsExpression(wrapped.parent) ||
      ts.isNonNullExpression(wrapped.parent)
    )
  ) {
    wrapped = wrapped.parent;
  }
  const invocation =
    ts.isCallExpression(wrapped.parent) &&
    wrapped.parent.expression === wrapped &&
    wrapped.parent.arguments.length === 0 &&
    !wrapped.parent.questionDotToken
      ? wrapped.parent
      : null;
  const awaitExpression = invocation?.parent;
  const declaration =
    awaitExpression &&
    ts.isAwaitExpression(awaitExpression) &&
    ts.isVariableDeclaration(awaitExpression.parent) &&
    awaitExpression.parent.initializer === awaitExpression &&
    ts.isIdentifier(awaitExpression.parent.name) &&
    isConstDeclaration(awaitExpression.parent)
      ? awaitExpression.parent
      : null;
  if (!invocation || !declaration) return null;
  let sinkBranch = null;
  for (let current = write._node.parent; current && current !== carrier; current = current.parent) {
    if (
      ts.isIfStatement(current) &&
      current.thenStatement.pos <= write._node.pos &&
      current.thenStatement.end >= write._node.end
    ) {
      sinkBranch = current;
      break;
    }
  }
  const sinkFact = sinkBranch && exactLiteralDiscriminant(
    sinkBranch.expression,
    analysis,
  );
  if (!sinkFact?.equal || !carrierEffectsAreKnown(
    carrier,
    transactionBinding,
    write,
    analysis,
  )) {
    return null;
  }
  const declarationStatement = directStatement(declaration);
  const block = declarationStatement?.parent;
  if (!block || !ts.isBlock(block)) return null;
  const declarationIndex = block.statements.indexOf(declarationStatement);
  let resultGuard = null;
  let resultGuardReturn = null;
  for (const statement of block.statements.slice(declarationIndex + 1)) {
    if (!ts.isIfStatement(statement)) continue;
    const condition = unwrap(statement.expression);
    const operand =
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken
        ? unwrap(condition.operand)
        : null;
    const exactResult =
      operand &&
      ts.isElementAccessExpression(operand) &&
      ts.isIdentifier(unwrap(operand.expression)) &&
      analysis._aliasState.lexicalBindings.declarationFor(
        unwrap(operand.expression),
      ) === declaration.name &&
      operand.argumentExpression &&
      ts.isNumericLiteral(unwrap(operand.argumentExpression)) &&
      unwrap(operand.argumentExpression).text === "0";
    const terminating =
      ts.isReturnStatement(statement.thenStatement)
        ? statement.thenStatement
        : ts.isBlock(statement.thenStatement) &&
            statement.thenStatement.statements.length === 1 &&
            ts.isReturnStatement(statement.thenStatement.statements[0])
          ? statement.thenStatement.statements[0]
          : null;
    if (exactResult && terminating) {
      resultGuard = statement;
      resultGuardReturn = terminating;
      break;
    }
  }
  return resultGuard &&
    carrierResultUsesAreExact(
      declaration,
      resultGuard,
      callback,
      analysis,
    )
    ? {
        carrier,
        invocation,
        declaration,
        sinkFact,
        resultGuard,
        resultGuardReturn,
      }
    : null;
}

function carrierWrapperPatchCertificate(
  write,
  callback,
  transactionBinding,
  scope,
  analysis,
) {
  if (scope.kind !== "ExactIssue") return null;
  const carrier = sinkCarrier(
    write,
    callback,
    transactionBinding,
    scope,
    analysis,
  );
  if (!carrier) return null;
  const calls = [];
  function collect(node) {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  }
  collect(callback.body);
  for (const call of calls) {
    if (
      call.arguments.length < 2 ||
      !isJoinedCall(call, callback) ||
      call.pos <= carrier.resultGuard.end
    ) {
      continue;
    }
    const wrapper = derivedPatchWrapper(call, analysis);
    const set = exactFiniteArray(call.arguments[1], analysis);
    const member = set?.members.find((candidate) => candidate.key === scope.key);
    if (
      !wrapper ||
      !wrapperCallArgumentsAreExact(
        call,
        wrapper,
        callback,
        transactionBinding,
        analysis,
      ) ||
      !set ||
      !member ||
      !scopeExpressionStable(
        scope.issueExpression,
        callback,
        analysis,
        write._node.pos,
        callback.body.end,
        [outermostWriteCall(write._node), call],
        transactionBinding,
      )
    ) {
      continue;
    }
    const carrierRelation = commonBlockRelation(
      carrier.invocation,
      call,
      callback,
    );
    const betweenCarrierAndPatch = carrierRelation
      ? carrierRelation.block.statements.slice(
          carrierRelation.firstIndex + 1,
          carrierRelation.secondIndex,
        )
      : [];
    if (
      !carrierRelation ||
      carrierRelation.firstIndex >= carrierRelation.secondIndex ||
      betweenCarrierAndPatch.some((statement) =>
        statement !== carrier.resultGuard &&
        (
          hasNormalReturn(statement) ||
          statementInvalidatesTransaction(
            statement,
            transactionBinding,
            analysis,
          )
        ))
    ) {
      continue;
    }
    let implicationGuard = null;
    for (let current = call.parent; current && current !== callback; current = current.parent) {
      if (!ts.isIfStatement(current)) continue;
      const condition = unwrap(current.expression);
      const left =
        ts.isBinaryExpression(condition) &&
        condition.operatorToken.kind === ts.SyntaxKind.BarBarToken
          ? exactLiteralDiscriminant(condition.left, analysis)
          : exactLiteralDiscriminant(condition, analysis);
      if (
        left &&
        !left.equal &&
        left.discriminant === carrier.sinkFact.discriminant &&
        left.literal !== carrier.sinkFact.literal
      ) {
        implicationGuard = current;
        break;
      }
    }
    if (!implicationGuard) continue;
    const exits = normalExitKeys(callback, analysis.path, write._node.pos).filter(
      (key) => key !== nodeKey(analysis.path, carrier.resultGuardReturn),
    );
    return {
      coverageKind: "derived_patch_wrapper",
      coverageScopeKeys: [set.setKey],
      normalExitKeys: exits,
      proofNodes: [
        ...scope.proofNodes,
        nodeKey(analysis.path, carrier.carrier),
        nodeKey(analysis.path, carrier.invocation),
        nodeKey(analysis.path, carrier.sinkFact.node),
        nodeKey(analysis.path, carrier.resultGuard),
        nodeKey(analysis.path, implicationGuard),
        ...set.proofNodes,
        member.nodeKey,
        ...wrapper.proofNodes,
        nodeKey(analysis.path, call),
        ...exits,
      ],
      memberProofNodes: [nodeKey(analysis.path, set.array), member.nodeKey],
      proofRoles: [
        "pending_obligation",
        "sink_carrier",
        "known_sibling_writes",
        "result_guard",
        "literal_implication",
        "finite_array",
        "Member",
        "derived_wrapper",
        "inner_versionedIssuePatch",
        "normal_exit",
      ],
      callSite: nodeKey(analysis.path, call),
      edgeNode: call,
      helperPath: wrapper.helperPath,
      flowSinkNodes: [carrier.invocation],
      flowCoverageNodes: [call],
      flowAllowedCaptureNodes: [carrier.carrier],
      flowIgnoredExitNodes: [carrier.resultGuardReturn],
      flowSinkImpliesGuards: [implicationGuard],
    };
  }
  return null;
}

function dynamicImportFactoryBinding(identifier, analysis) {
  const binding = analysis._aliasState.lexicalBindings.declarationFor(identifier);
  const element = binding?.parent;
  const pattern = element?.parent;
  const declaration = pattern?.parent;
  if (
    !binding ||
    !element ||
    !ts.isBindingElement(element) ||
    element.name !== binding ||
    element.propertyName ||
    element.dotDotDotToken ||
    element.initializer ||
    !ts.isObjectBindingPattern(pattern) ||
    pattern.elements.length !== 1 ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.name !== pattern ||
    !isConstDeclaration(declaration) ||
    analysis._aliasState.assigned.has(binding) ||
    !declaration.initializer
  ) {
    return null;
  }
  const awaited = unwrap(declaration.initializer);
  const importCall =
    ts.isAwaitExpression(awaited) &&
    ts.isCallExpression(unwrap(awaited.expression)) &&
    unwrap(awaited.expression).expression.kind === ts.SyntaxKind.ImportKeyword
      ? unwrap(awaited.expression)
      : null;
  if (
    !importCall ||
    importCall.arguments.length !== 1 ||
    !ts.isStringLiteral(importCall.arguments[0]) ||
    !importCall.arguments[0].text.startsWith(".") ||
    !analysis._resolveModuleSource
  ) {
    return null;
  }
  const resolved = analysis._resolveModuleSource(
    analysis.path,
    importCall.arguments[0].text,
  );
  if (!resolved?.path || typeof resolved.source !== "string") return null;
  return {
    binding,
    element,
    declaration,
    importCall,
    modulePath: normalizePath(resolved.path),
    moduleSource: resolved.source,
  };
}

function foreignHelperHasInnerPatch(module, foreignAnalysis) {
  const importDeclaration = module.sourceFile.statements.find((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.importClause?.namedBindings &&
    ts.isNamedImports(statement.importClause.namedBindings) &&
    statement.importClause.namedBindings.elements.some((specifier) =>
      (specifier.propertyName?.text ?? specifier.name.text) === "runIssueMutation"));
  if (
    !importDeclaration ||
    !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
    !foreignAnalysis._resolveModuleSource
  ) {
    return null;
  }
  const helper = foreignAnalysis._resolveModuleSource(
    module.path,
    importDeclaration.moduleSpecifier.text,
  );
  if (
    !helper ||
    normalizePath(helper.path) !==
      "server/src/services/issue-versioning.ts"
  ) {
    return null;
  }
  const writes = collectIssueWritesFromSource(
    helper.path,
    helper.source,
    {
      resolveNamedImport: foreignAnalysis._resolveNamedImport,
      resolveModuleSource: foreignAnalysis._resolveModuleSource,
    },
  );
  const patches = writes.filter((write) =>
    write.table === "issues" &&
    write.operation === "update" &&
    write.versionedBy === "versionedIssuePatch" &&
    write.versionedHelperPath === "packages/db/src/issue-versioning.ts");
  const helperFile = writes.contractAnalysis._sourceFile;
  const exported = exportedExecutable(
    { sourceFile: helperFile },
    "runIssueMutation",
  );
  if (
    patches.length === 0 ||
    !exported ||
    !exported.body ||
    !wrapperReexportsVersionedPatch({ sourceFile: helperFile }) ||
    exported.parameters.length !== 2 ||
    !ts.isIdentifier(exported.parameters[0].name) ||
    !ts.isIdentifier(exported.parameters[1].name) ||
    exported.parameters.some((parameter) =>
      parameter.dotDotDotToken || parameter.initializer || parameter.questionToken)
  ) {
    return null;
  }
  const helperAnalysis = writes.contractAnalysis;
  function exactBoundEquality(expression, column, binding) {
    const call = unwrap(expression);
    return (
      ts.isCallExpression(call) &&
      exactImportedCallName(call, "drizzle-orm", ["eq"], helperAnalysis) ===
        "eq" &&
      call.arguments.length === 2 &&
      exactColumn(call.arguments[0], "issues", column, helperAnalysis) &&
      exactArgumentBinding(call.arguments[1], helperAnalysis) === binding
    )
      ? call
      : null;
  }
  function exactNegatedExitGuard(statement, binding, exitKind) {
    if (!ts.isIfStatement(statement) || statement.elseStatement) return null;
    const condition = unwrap(statement.expression);
    const operand =
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken
        ? unwrap(condition.operand)
        : null;
    if (
      !operand ||
      !ts.isIdentifier(operand) ||
      helperAnalysis._aliasState.lexicalBindings.declarationFor(operand) !==
        binding
    ) {
      return null;
    }
    const exit =
      exitKind === "return" && ts.isReturnStatement(statement.thenStatement)
        ? statement.thenStatement
        : exitKind === "throw" && ts.isThrowStatement(statement.thenStatement)
          ? statement.thenStatement
          : ts.isBlock(statement.thenStatement) &&
              statement.thenStatement.statements.length === 1 &&
              (
                (
                  exitKind === "return" &&
                  ts.isReturnStatement(statement.thenStatement.statements[0])
                ) ||
                (
                  exitKind === "throw" &&
                  ts.isThrowStatement(statement.thenStatement.statements[0])
                )
              )
            ? statement.thenStatement.statements[0]
            : null;
    return exit ? { operand, exit } : null;
  }
  const runInCandidates = helperAnalysis._registry.records.filter((record) =>
    record.name === "runInTransaction" && record._node !== exported);
  const runInRecord =
    runInCandidates.length === 1 ? runInCandidates[0] : null;
  const runIn = runInRecord?._node;
  if (
    !runIn ||
    !runIn.body ||
    runIn.parameters.length !== 2 ||
    !ts.isIdentifier(runIn.parameters[0].name) ||
    !ts.isObjectBindingPattern(runIn.parameters[1].name) ||
    runIn.parameters[0].dotDotDotToken ||
    runIn.parameters[0].initializer ||
    runIn.parameters[0].questionToken
  ) {
    return null;
  }
  const destructured = new Map();
  for (const element of runIn.parameters[1].name.elements) {
    if (
      element.dotDotDotToken ||
      element.propertyName ||
      element.initializer ||
      !ts.isIdentifier(element.name) ||
      destructured.has(element.name.text)
    ) {
      return null;
    }
    destructured.set(element.name.text, element.name);
  }
  if (
    destructured.size !== 4 ||
    !["issueId", "expectedVersion", "now", "mutate"].every((name) =>
      destructured.has(name))
  ) {
    return null;
  }
  const transactionParameter = runIn.parameters[0].name;
  const issueIdBinding = destructured.get("issueId");
  const nowBinding = destructured.get("now");
  const mutateBinding = destructured.get("mutate");
  const statements = [...runIn.body.statements];
  if (
    statements.length !== 7 ||
    !ts.isVariableStatement(statements[0]) ||
    statements[0].declarationList.declarations.length !== 1 ||
    !ts.isIfStatement(statements[1]) ||
    !ts.isIfStatement(statements[2]) ||
    !ts.isVariableStatement(statements[3]) ||
    statements[3].declarationList.declarations.length !== 1 ||
    !ts.isVariableStatement(statements[4]) ||
    statements[4].declarationList.declarations.length !== 1 ||
    !ts.isIfStatement(statements[5]) ||
    !ts.isReturnStatement(statements[6]) ||
    !statements[6].expression
  ) {
    return null;
  }
  const currentDeclaration = statements[0].declarationList.declarations[0];
  const plannedDeclaration = statements[3].declarationList.declarations[0];
  const updatedDeclaration = statements[4].declarationList.declarations[0];
  if (
    !ts.isIdentifier(currentDeclaration.name) ||
    !ts.isIdentifier(plannedDeclaration.name) ||
    !ts.isIdentifier(updatedDeclaration.name) ||
    !isConstDeclaration(currentDeclaration) ||
    !isConstDeclaration(plannedDeclaration) ||
    !isConstDeclaration(updatedDeclaration)
  ) {
    return null;
  }
  const currentCall = immediateAwaitedCall(currentDeclaration);
  const currentChain = currentCall ? expressionCallChain(currentCall) : [];
  const currentReceiver = currentChain[0]?.receiver &&
    unwrap(currentChain[0].receiver);
  const currentWhere = currentChain[2]?.call;
  const currentPredicate =
    currentWhere?.arguments.length === 1
      ? exactBoundEquality(
          currentWhere.arguments[0],
          "id",
          issueIdBinding,
        )
      : null;
  const currentThen = currentChain[4]?.call;
  const currentThenCallback =
    currentThen?.arguments.length === 1
      ? unwrap(currentThen.arguments[0])
      : null;
  const currentResult =
    currentThenCallback &&
    (
      ts.isArrowFunction(currentThenCallback) ||
      ts.isFunctionExpression(currentThenCallback)
    )
      ? exactCallbackReturnExpression(currentThenCallback)
      : null;
  const currentCoalesce =
    currentResult && ts.isBinaryExpression(unwrap(currentResult))
      ? unwrap(currentResult)
      : null;
  const currentFirst = currentCoalesce && unwrap(currentCoalesce.left);
  const currentGuardProof = exactNegatedExitGuard(
    statements[1],
    currentDeclaration.name,
    "return",
  );
  const currentGuard = currentGuardProof ? statements[1] : null;
  const versionExit =
    !statements[2].elseStatement &&
    (
      ts.isThrowStatement(statements[2].thenStatement)
        ? statements[2].thenStatement
        : ts.isBlock(statements[2].thenStatement) &&
            statements[2].thenStatement.statements.length === 1 &&
            ts.isThrowStatement(statements[2].thenStatement.statements[0])
          ? statements[2].thenStatement.statements[0]
          : null
    );
  if (
    !currentCall ||
    currentChain.map((item) => item.name).join(",") !==
      "select,from,where,for,then" ||
    currentChain[0].call.arguments.length !== 0 ||
    !ts.isIdentifier(currentReceiver) ||
    helperAnalysis._aliasState.lexicalBindings.declarationFor(currentReceiver) !==
      transactionParameter ||
    currentChain[1].call.arguments.length !== 1 ||
    directTableReference(
      currentChain[1].call.arguments[0],
      helperAnalysis._aliasState.aliases,
      helperAnalysis._aliasState.namespaces,
      helperAnalysis._aliasState.helperAliases,
      helperAnalysis._aliasState.unresolvedAliases,
      helperAnalysis._aliasState.lexicalBindings,
    ) !== "issues" ||
    currentChain[3].call.arguments.length !== 1 ||
    !ts.isStringLiteral(unwrap(currentChain[3].call.arguments[0])) ||
    unwrap(currentChain[3].call.arguments[0]).text !== "update" ||
    !currentPredicate ||
    !currentThenCallback ||
    !exactCallbackParameter(currentThenCallback) ||
    !currentCoalesce ||
    currentCoalesce.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !ts.isElementAccessExpression(currentFirst) ||
    !ts.isIdentifier(unwrap(currentFirst.expression)) ||
    helperAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(currentFirst.expression),
    ) !== exactCallbackParameter(currentThenCallback) ||
    !currentFirst.argumentExpression ||
    !ts.isNumericLiteral(unwrap(currentFirst.argumentExpression)) ||
    unwrap(currentFirst.argumentExpression).text !== "0" ||
    unwrap(currentCoalesce.right).kind !== ts.SyntaxKind.NullKeyword ||
    currentGuard !== statements[1] ||
    !currentGuardProof.exit.expression ||
    unwrap(currentGuardProof.exit.expression).kind !== ts.SyntaxKind.NullKeyword ||
    !versionExit
  ) {
    return null;
  }
  const plannedCall = immediateAwaitedCall(plannedDeclaration);
  if (
    !plannedCall ||
    !ts.isIdentifier(unwrap(plannedCall.expression)) ||
    helperAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(plannedCall.expression),
    ) !== mutateBinding ||
    plannedCall.arguments.length !== 2 ||
    exactArgumentBinding(plannedCall.arguments[0], helperAnalysis) !==
      transactionParameter ||
    exactArgumentBinding(plannedCall.arguments[1], helperAnalysis) !==
      currentDeclaration.name
  ) {
    return null;
  }
  const runInPatches = patches.filter((patch) =>
    enclosingFunctionRecord(patch._node, helperAnalysis) === runInRecord);
  const selectedPatch =
    runInPatches.length === 1 ? runInPatches[0] : null;
  const updatedCall = immediateAwaitedCall(updatedDeclaration);
  if (
    !selectedPatch ||
    !updatedCall ||
    outermostWriteCall(selectedPatch._node) !== updatedCall ||
    transactionReceiverBinding(selectedPatch, helperAnalysis) !==
      transactionParameter ||
    selectedPatch.versionedHelperPath !==
      "packages/db/src/issue-versioning.ts"
  ) {
    return null;
  }
  const updateCalls = chainCalls(selectedPatch._node);
  if (
    updateCalls.map((candidate) => candidate.name).join(",") !==
      "set,where,returning,then" ||
    updateCalls[0].call.arguments.length !== 1 ||
    updateCalls[2].call.arguments.length !== 0 ||
    updateCalls[3].call.arguments.length !== 1
  ) {
    return null;
  }
  const updatedThenCallback = unwrap(updateCalls[3].call.arguments[0]);
  const updatedRowsBinding =
    (
      ts.isArrowFunction(updatedThenCallback) ||
      ts.isFunctionExpression(updatedThenCallback)
    )
      ? exactCallbackParameter(updatedThenCallback)
      : null;
  const updatedResult = updatedRowsBinding
    ? exactCallbackReturnExpression(updatedThenCallback)
    : null;
  const updatedCoalesce =
    updatedResult && ts.isBinaryExpression(unwrap(updatedResult))
      ? unwrap(updatedResult)
      : null;
  const updatedFirst = updatedCoalesce && unwrap(updatedCoalesce.left);
  if (
    !updatedRowsBinding ||
    !updatedCoalesce ||
    updatedCoalesce.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !ts.isElementAccessExpression(updatedFirst) ||
    !ts.isIdentifier(unwrap(updatedFirst.expression)) ||
    helperAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(updatedFirst.expression),
    ) !== updatedRowsBinding ||
    !updatedFirst.argumentExpression ||
    !ts.isNumericLiteral(unwrap(updatedFirst.argumentExpression)) ||
    unwrap(updatedFirst.argumentExpression).text !== "0" ||
    unwrap(updatedCoalesce.right).kind !== ts.SyntaxKind.NullKeyword
  ) {
    return null;
  }
  const patchCall = unwrap(updateCalls[0].call.arguments[0]);
  const patchCallee = patchCall && ts.isCallExpression(patchCall)
    ? unwrap(patchCall.expression)
    : null;
  const patchPayload =
    patchCall && ts.isCallExpression(patchCall) && patchCall.arguments.length === 2
      ? unwrap(patchCall.arguments[0])
      : null;
  const patchNow =
    patchCall && ts.isCallExpression(patchCall)
      ? patchCall.arguments[1]
      : null;
  const payloadLeft =
    patchPayload && ts.isBinaryExpression(patchPayload)
      ? unwrap(patchPayload.left)
      : null;
  if (
    !patchCall ||
    !ts.isCallExpression(patchCall) ||
    !ts.isIdentifier(patchCallee) ||
    !trustedHelperResolution(
      patchCall,
      helperAnalysis,
      "versionedIssuePatch",
    ) ||
    !ts.isBinaryExpression(patchPayload) ||
    patchPayload.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !ts.isPropertyAccessExpression(payloadLeft) ||
    payloadLeft.name.text !== "issuePatch" ||
    !ts.isIdentifier(unwrap(payloadLeft.expression)) ||
    helperAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(payloadLeft.expression),
    ) !== plannedDeclaration.name ||
    !ts.isObjectLiteralExpression(unwrap(patchPayload.right)) ||
    unwrap(patchPayload.right).properties.length !== 0 ||
    exactArgumentBinding(patchNow, helperAnalysis) !== nowBinding
  ) {
    return null;
  }
  const updatePredicate =
    updateCalls[1].call.arguments.length === 1
      ? unwrap(updateCalls[1].call.arguments[0])
      : null;
  const updateAnd =
    updatePredicate &&
    ts.isCallExpression(updatePredicate) &&
    exactImportedCallName(
      updatePredicate,
      "drizzle-orm",
      ["and"],
      helperAnalysis,
    ) === "and" &&
    updatePredicate.arguments.length === 2
      ? updatePredicate
      : null;
  const updateId = updateAnd &&
    exactBoundEquality(updateAnd.arguments[0], "id", issueIdBinding);
  const versionCall = updateAnd && unwrap(updateAnd.arguments[1]);
  const versionRight =
    versionCall &&
    ts.isCallExpression(versionCall) &&
    exactImportedCallName(
      versionCall,
      "drizzle-orm",
      ["eq"],
      helperAnalysis,
    ) === "eq" &&
    versionCall.arguments.length === 2 &&
    exactColumn(versionCall.arguments[0], "issues", "version", helperAnalysis)
      ? unwrap(versionCall.arguments[1])
      : null;
  if (
    !updateAnd ||
    !updateId ||
    !versionRight ||
    !ts.isPropertyAccessExpression(versionRight) ||
    versionRight.name.text !== "version" ||
    !ts.isIdentifier(unwrap(versionRight.expression)) ||
    helperAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(versionRight.expression),
    ) !== currentDeclaration.name
  ) {
    return null;
  }
  const updatedGuardProof = exactNegatedExitGuard(
    statements[5],
    updatedDeclaration.name,
    "throw",
  );
  const updatedGuard = updatedGuardProof ? statements[5] : null;
  const returned = unwrap(statements[6].expression);
  if (
    updatedGuard !== statements[5] ||
    !ts.isObjectLiteralExpression(returned) ||
    returned.properties.length !== 2
  ) {
    return null;
  }
  const returnedIssue = exactObjectPropertyValue(returned, "issue");
  const returnedResult = exactObjectPropertyValue(returned, "result");
  if (
    exactArgumentBinding(returnedIssue, helperAnalysis) !==
      updatedDeclaration.name ||
    !returnedResult ||
    !ts.isPropertyAccessExpression(unwrap(returnedResult)) ||
    unwrap(returnedResult).name.text !== "result" ||
    !ts.isIdentifier(unwrap(returnedResult).expression) ||
    helperAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(returnedResult).expression,
    ) !== plannedDeclaration.name ||
    !isExactConsecutiveStatementSequence(runIn, [
      plannedCall,
      selectedPatch._node,
      updatedGuard,
      statements[6],
    ])
  ) {
    return null;
  }

  const outerStatements = [...exported.body.statements];
  if (
    outerStatements.length !== 2 ||
    !ts.isIfStatement(outerStatements[0]) ||
    outerStatements[0].elseStatement ||
    !ts.isReturnStatement(outerStatements[1])
  ) {
    return null;
  }
  const transactionTest = unwrap(outerStatements[0].expression);
  if (
    !ts.isCallExpression(transactionTest) ||
    transactionTest.arguments.length !== 1 ||
    helperAnalysis._registry.resolveCallee(transactionTest.expression)?.name !==
      "isDbTransaction" ||
    exactArgumentBinding(transactionTest.arguments[0], helperAnalysis) !==
      exported.parameters[0].name
  ) {
    return null;
  }
  const directReturn =
    ts.isReturnStatement(outerStatements[0].thenStatement)
      ? outerStatements[0].thenStatement
      : ts.isBlock(outerStatements[0].thenStatement) &&
          outerStatements[0].thenStatement.statements.length === 1 &&
          ts.isReturnStatement(outerStatements[0].thenStatement.statements[0])
        ? outerStatements[0].thenStatement.statements[0]
        : null;
  function exactAwaitedRunIn(returnStatement, transactionBinding, inputBinding) {
    const awaited = returnStatement?.expression &&
      unwrap(returnStatement.expression);
    const call =
      awaited && ts.isAwaitExpression(awaited)
        ? unwrap(awaited.expression)
        : null;
    return (
      call &&
      ts.isCallExpression(call) &&
      helperAnalysis._registry.resolveCallee(call.expression) === runInRecord &&
      call.arguments.length === 2 &&
      exactArgumentBinding(call.arguments[0], helperAnalysis) ===
        transactionBinding &&
      exactArgumentBinding(call.arguments[1], helperAnalysis) === inputBinding
    )
      ? call
      : null;
  }
  const directRunIn = exactAwaitedRunIn(
    directReturn,
    exported.parameters[0].name,
    exported.parameters[1].name,
  );
  const transactionAwait = outerStatements[1].expression &&
    unwrap(outerStatements[1].expression);
  const transactionCall =
    transactionAwait && ts.isAwaitExpression(transactionAwait)
      ? unwrap(transactionAwait.expression)
      : null;
  const transactionMember =
    transactionCall && ts.isCallExpression(transactionCall)
      ? callMember(transactionCall)
      : null;
  const transactionReceiver = transactionMember &&
    unwrap(transactionMember.receiver);
  const transactionCallback =
    transactionCall &&
    ts.isCallExpression(transactionCall) &&
    transactionCall.arguments.length === 1
      ? unwrap(transactionCall.arguments[0])
      : null;
  if (
    !directRunIn ||
    !transactionCall ||
    !ts.isCallExpression(transactionCall) ||
    !transactionMember ||
    transactionMember.computed ||
    transactionMember.name !== "transaction" ||
    transactionCall.questionDotToken ||
    !ts.isIdentifier(transactionReceiver) ||
    helperAnalysis._aliasState.lexicalBindings.declarationFor(
      transactionReceiver,
    ) !== exported.parameters[0].name ||
    !transactionCallback ||
    !ts.isArrowFunction(transactionCallback) ||
    !transactionCallback.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    !exactCallbackParameter(transactionCallback)
  ) {
    return null;
  }
  const callbackReturn = exactCallbackReturnExpression(transactionCallback);
  const callbackAwait = callbackReturn && unwrap(callbackReturn);
  const callbackCall =
    callbackAwait && ts.isAwaitExpression(callbackAwait)
      ? unwrap(callbackAwait.expression)
      : null;
  if (
    !callbackCall ||
    !ts.isCallExpression(callbackCall) ||
    helperAnalysis._registry.resolveCallee(callbackCall.expression) !==
      runInRecord ||
    callbackCall.arguments.length !== 2 ||
    exactArgumentBinding(callbackCall.arguments[0], helperAnalysis) !==
      transactionCallback.parameters[0].name ||
    exactArgumentBinding(callbackCall.arguments[1], helperAnalysis) !==
      exported.parameters[1].name
  ) {
    return null;
  }
  return {
    path: normalizePath(helper.path),
    exported,
    patch: selectedPatch,
    proofNodes: [
      nodeKey(module.path, importDeclaration),
      nodeKey(helper.path, exported),
      nodeKey(helper.path, runIn),
      nodeKey(helper.path, currentCall),
      nodeKey(helper.path, currentGuard),
      nodeKey(helper.path, plannedCall),
      nodeKey(helper.path, selectedPatch._node),
      nodeKey(helper.path, patchCall),
      nodeKey(helper.path, updatedGuard),
      nodeKey(helper.path, statements[6]),
      nodeKey(helper.path, directRunIn),
      nodeKey(helper.path, transactionCall),
      nodeKey(helper.path, callbackCall),
    ],
  };
}

function exactForeignProjector(
  member,
  helperCall,
  helperGuard,
  mutationBinding,
  transactionParameter,
  foreignAnalysis,
) {
  let projectorCall = null;
  let projector = null;
  function visit(node) {
    if (projectorCall || (node !== member.body && ts.isFunctionLike(node))) return;
    if (node.pos > helperGuard.end && ts.isCallExpression(node)) {
      const candidate = foreignAnalysis._registry.resolveCallee(node.expression);
      const summary = candidate
        ? foreignAnalysis.projectors.find((item) =>
            item.symbolKey === candidate.symbolKey)
        : null;
      if (summary && candidate) {
        const transactionIndex = candidate._node.parameters.indexOf(candidate._parameter);
        const rowsIndex = candidate._node.parameters.findIndex((parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === "rows");
        const initializerPlan =
          transactionIndex >= 0
            ? parameterInitializerExecutionPlan(
                node,
                candidate._node,
                new Set([transactionParameter.name]),
                foreignAnalysis._aliasState.lexicalBindings,
                {
                  exactCapabilityArgumentIndexes: new Set([transactionIndex]),
                  assigned: foreignAnalysis._aliasState.assigned,
                },
              )
            : null;
        if (
          summary._structurallyEligible &&
          initializerPlan &&
          classifyFunctionInvocation(candidate, initializerPlan) === "READ_ONLY" &&
          transactionIndex >= 0 &&
          rowsIndex >= 0 &&
          exactArgumentBinding(node.arguments[transactionIndex], foreignAnalysis) ===
            transactionParameter.name &&
          singletonMutationIssue(node.arguments[rowsIndex], mutationBinding)
        ) {
          projectorCall = node;
          projector = summary;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(member.body);
  if (!projectorCall || !projector) return null;
  const awaited = projectorCall.parent;
  const declaration =
    ts.isAwaitExpression(awaited) &&
    ts.isVariableDeclaration(awaited.parent) &&
    awaited.parent.initializer === awaited &&
    isConstDeclaration(awaited.parent) &&
    ts.isVariableDeclarationList(awaited.parent.parent) &&
    awaited.parent.parent.declarations.length === 1 &&
    ts.isArrayBindingPattern(awaited.parent.name) &&
    awaited.parent.name.elements.length === 1
      ? awaited.parent
      : null;
  const element = declaration?.name.elements[0];
  if (
    !declaration ||
    !element ||
    !ts.isBindingElement(element) ||
    element.dotDotDotToken ||
    element.propertyName ||
    element.initializer ||
    !ts.isIdentifier(element.name)
  ) {
    return null;
  }
  const returns = directFunctionReturns(member);
  const directReturn = returns.find((expression) =>
    ts.isIdentifier(unwrap(expression)) &&
    foreignAnalysis._aliasState.lexicalBindings.declarationFor(
      unwrap(expression),
    ) === element.name);
  if (
    !directReturn ||
    returns.filter((expression) =>
      expression.pos > helperGuard.pos &&
      expression.pos < projectorCall.pos &&
      !(expression.pos >= helperGuard.pos && expression.end <= helperGuard.end))
      .length > 0
  ) {
    return null;
  }
  const returnStatement = directReturn.parent;
  if (
    !ts.isReturnStatement(returnStatement) ||
    !isExactConsecutiveStatementSequence(member, [
      helperCall,
      helperGuard,
      projectorCall,
      returnStatement,
    ])
  ) {
    return null;
  }
  return {
    call: projectorCall,
    summary: projector,
    declaration,
    returnStatement,
    proofNodes: [
      nodeKey(foreignAnalysis.path, projectorCall),
      nodeKey(foreignAnalysis.path, declaration),
      nodeKey(foreignAnalysis.path, returnStatement),
      ...projector.proofNodes,
    ],
  };
}

function resolveLiteralImportedFactoryMember(
  memberCall,
  transactionBinding,
  scope,
  analysis,
) {
  const memberExpression = unwrap(memberCall.expression);
  if (
    !ts.isPropertyAccessExpression(memberExpression) ||
    memberExpression.questionDotToken ||
    !ts.isCallExpression(unwrap(memberExpression.expression)) ||
    memberCall.questionDotToken ||
    memberCall.arguments.some((argument) => ts.isSpreadElement(argument))
  ) {
    return null;
  }
  const factoryCall = unwrap(memberExpression.expression);
  const factoryCallee = unwrap(factoryCall.expression);
  if (
    !ts.isIdentifier(factoryCallee) ||
    factoryCall.questionDotToken ||
    factoryCall.arguments.some((argument) => ts.isSpreadElement(argument))
  ) {
    return null;
  }
  const imported = dynamicImportFactoryBinding(factoryCallee, analysis);
  if (!imported) return null;
  let bindingUsesValid = true;
  function scanUses(node) {
    if (!bindingUsesValid) return;
    if (
      ts.isIdentifier(node) &&
      node !== imported.binding &&
      analysis._aliasState.lexicalBindings.declarationFor(node) === imported.binding &&
      node !== factoryCallee
    ) {
      bindingUsesValid = false;
      return;
    }
    ts.forEachChild(node, scanUses);
  }
  scanUses(analysis._sourceFile);
  if (!bindingUsesValid) return null;
  const sourceFile = ts.createSourceFile(
    imported.modulePath,
    imported.moduleSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const exported = exportedExecutable({ sourceFile }, imported.binding.text);
  if (
    !exported ||
    hasSyntheticThisParameter(exported) !== false ||
    factoryCall.arguments.length > exported.parameters.length ||
    factoryCall.arguments.some((argument) =>
      capabilityIdentifiers(
        argument,
        new Set([transactionBinding]),
        analysis._aliasState.lexicalBindings,
      ).length > 0)
  ) {
    return null;
  }
  const factoryInitializerPlan = parameterInitializerExecutionPlan(
    factoryCall,
    exported,
    new Set([transactionBinding]),
    analysis._aliasState.lexicalBindings,
  );
  if (!factoryInitializerPlan) return null;
  const returns = directFunctionReturns(exported);
  if (returns.length !== 1) return null;
  const returnObject = unwrap(returns[0]);
  if (!ts.isObjectLiteralExpression(returnObject)) return null;
  const memberName = memberExpression.name.text;
  const memberProperties = returnObject.properties.filter((property) =>
    !ts.isSpreadAssignment(property) &&
    property.name &&
    !ts.isComputedPropertyName(property.name) &&
    literalName(property.name) === memberName);
  if (
    memberProperties.length !== 1 ||
    returnObject.properties.some((property) =>
      ts.isSpreadAssignment(property) ||
      !property.name ||
      ts.isComputedPropertyName(property.name) ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property))
  ) {
    return null;
  }
  const memberProperty = memberProperties[0];
  const member =
    ts.isMethodDeclaration(memberProperty)
      ? memberProperty
      : ts.isPropertyAssignment(memberProperty)
        ? resolveExecutableFunctionLike(memberProperty)
        : null;
  if (
    !member ||
    !member.body ||
    hasSyntheticThisParameter(member) !== false ||
    memberCall.arguments.length > member.parameters.length
  ) {
    return null;
  }
  const capabilityIndexes = memberCall.arguments
    .map((argument, index) => ({
      index,
      identifiers: capabilityIdentifiers(
        argument,
        new Set([transactionBinding]),
        analysis._aliasState.lexicalBindings,
      ),
    }))
    .filter((candidate) => candidate.identifiers.length > 0);
  const transactionIndex =
    capabilityIndexes.length === 1 &&
    ts.isIdentifier(unwrap(memberCall.arguments[capabilityIndexes[0].index])) &&
    analysis._aliasState.lexicalBindings.declarationFor(
      unwrap(memberCall.arguments[capabilityIndexes[0].index]),
    ) === transactionBinding
      ? capabilityIndexes[0].index
      : -1;
  const issueIndex = memberCall.arguments.findIndex(
    (argument) => exactIssueIdentity(argument, analysis) === scope.key,
  );
  if (
    transactionIndex < 0 ||
    issueIndex < 0 ||
    transactionIndex === issueIndex ||
    !member.parameters[transactionIndex] ||
    !member.parameters[issueIndex] ||
    !ts.isIdentifier(member.parameters[transactionIndex].name) ||
    !ts.isIdentifier(member.parameters[issueIndex].name) ||
    member.parameters[issueIndex].initializer ||
    member.parameters[issueIndex].questionToken ||
    member.parameters[issueIndex].dotDotDotToken ||
    member.parameters[transactionIndex].questionToken ||
    member.parameters[transactionIndex].dotDotDotToken
  ) {
    return null;
  }
  const memberInitializerPlan = parameterInitializerExecutionPlan(
    memberCall,
    member,
    new Set([transactionBinding]),
    analysis._aliasState.lexicalBindings,
    { exactCapabilityArgumentIndexes: new Set([transactionIndex]) },
  );
  if (!memberInitializerPlan) return null;
  const foreignAnalysis = analyzeTransactionSourceFile(
    imported.modulePath,
    sourceFile,
    {
      resolveNamedImport: analysis._resolveNamedImport,
      resolveModuleSource: analysis._resolveModuleSource,
    },
  );
  const foreignFactoryRecord = foreignAnalysis._registry.records.find(
    (record) =>
      record.symbolKey ===
      symbolKey(imported.modulePath, functionDeclarationNode(exported)),
  );
  const foreignMemberRecord = foreignAnalysis._registry.records.find(
    (record) =>
      record.symbolKey ===
      symbolKey(imported.modulePath, functionDeclarationNode(member)),
  );
  if (
    !activeParameterInitializersAreReadOnly(
      foreignFactoryRecord,
      factoryInitializerPlan,
    ) ||
    !activeParameterInitializersAreReadOnly(
      foreignMemberRecord,
      memberInitializerPlan,
    )
  ) {
    return null;
  }
  const foreignMember = foreignMemberRecord._node;
  const foreignIssueParameter = foreignMember.parameters[issueIndex];
  const foreignTransactionParameter = foreignMember.parameters[transactionIndex];
  const helperCalls = [];
  function collectHelper(node) {
    if (node !== foreignMember.body && ts.isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      trustedHelperResolution(node, foreignAnalysis, "runIssueMutation")
    ) {
      helperCalls.push(node);
    }
    ts.forEachChild(node, collectHelper);
  }
  collectHelper(foreignMember.body);
  if (helperCalls.length !== 1) return null;
  const helperCall = helperCalls[0];
  let unknownSetup = false;
  function inspectSetup(node) {
    if (
      unknownSetup ||
      node.pos >= helperCall.pos ||
      (node !== foreignMember.body && ts.isFunctionLike(node))
    ) {
      return;
    }
    if (ts.isCallExpression(node)) {
      unknownSetup = true;
      return;
    }
    ts.forEachChild(node, inspectSetup);
  }
  inspectSetup(foreignMember.body);
  if (unknownSetup) return null;
  const helperObject = helperCall.arguments[1] &&
    unwrap(helperCall.arguments[1]);
  const helperIssue = helperObject &&
    exactObjectPropertyValue(helperObject, "issueId");
  const mutate = helperObject &&
    exactObjectPropertyValue(helperObject, "mutate");
  if (
    helperCall.arguments.length < 2 ||
    exactArgumentBinding(helperCall.arguments[0], foreignAnalysis) !==
      foreignTransactionParameter.name ||
    !helperIssue ||
    exactArgumentBinding(helperIssue, foreignAnalysis) !==
      foreignIssueParameter.name ||
    !mutate ||
    (!ts.isArrowFunction(unwrap(mutate)) &&
      !ts.isFunctionExpression(unwrap(mutate)))
  ) {
    return null;
  }
  const helperAwait = helperCall.parent;
  const helperDeclaration =
    ts.isAwaitExpression(helperAwait) &&
    ts.isVariableDeclaration(helperAwait.parent) &&
    helperAwait.parent.initializer === helperAwait &&
    ts.isIdentifier(helperAwait.parent.name) &&
    isConstDeclaration(helperAwait.parent)
      ? helperAwait.parent
      : null;
  if (!helperDeclaration) return null;
  const helperGuard = terminatingNonNullGuard(
    foreignMember,
    helperDeclaration.name,
    helperCall.end,
  );
  if (!helperGuard) return null;
  const projector = exactForeignProjector(
    foreignMember,
    helperCall,
    helperGuard,
    helperDeclaration.name,
    foreignTransactionParameter,
    foreignAnalysis,
  );
  const mutateCallback = unwrap(mutate);
  const helperTransactionUse = unwrap(helperCall.arguments[0]);
  const helperIssueUse = unwrap(helperIssue);
  const projectorTransactionUses = projector
    ? projector.call.arguments
        .map((argument) => unwrap(argument))
        .filter((argument) =>
          ts.isIdentifier(argument) &&
          foreignAnalysis._aliasState.lexicalBindings.declarationFor(argument) ===
            foreignTransactionParameter.name)
    : [];
  if (
    !projector ||
    !bindingStableInRegion(
      foreignTransactionParameter.name,
      foreignMember.body,
      foreignAnalysis,
      {
        allowedUses: [helperTransactionUse, ...projectorTransactionUses],
        allowOrdinaryReads: true,
        ignoredNestedFunctions: [mutateCallback],
      },
    ) ||
    !bindingStableInRegion(
      foreignIssueParameter.name,
      foreignMember.body,
      foreignAnalysis,
      {
        allowedUses: [helperIssueUse],
        allowOrdinaryReads: true,
        ignoredNestedFunctions: [mutateCallback],
      },
    )
  ) {
    return null;
  }
  const inner = foreignHelperHasInnerPatch(
    {
      path: imported.modulePath,
      sourceFile,
    },
    foreignAnalysis,
  );
  if (!inner) return null;
  return {
    memberCall,
    imported,
    sourceFile,
    exported,
    returnObject,
    member: foreignMember,
    issueIndex,
    transactionIndex,
    helperCall,
    helperGuard,
    projector,
    inner,
    helperPath: inner.path,
    proofNodes: [
      nodeKey(analysis.path, imported.declaration),
      nodeKey(analysis.path, imported.importCall),
      nodeKey(imported.modulePath, exported),
      nodeKey(imported.modulePath, returnObject),
      nodeKey(imported.modulePath, foreignMember),
      nodeKey(imported.modulePath, helperCall),
      nodeKey(imported.modulePath, helperGuard),
      ...projector.proofNodes,
      ...inner.proofNodes,
      nodeKey(analysis.path, memberCall),
    ],
  };
}

function completionFlagCertificate(
  write,
  writes,
  callback,
  transactionBinding,
  scope,
  analysis,
) {
  if (scope.kind !== "ExactIssue" || !isJoinedWrite(write._node, callback)) {
    return null;
  }
  const flags = [];
  function collectFlags(node) {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      !isConstDeclaration(node) &&
      node.initializer?.kind === ts.SyntaxKind.FalseKeyword
    ) {
      flags.push(node);
    }
    ts.forEachChild(node, collectFlags);
  }
  collectFlags(callback.body);
  for (const flag of flags) {
    const assignments = [];
    const uses = [];
    function collect(node) {
      if (node !== callback.body && ts.isFunctionLike(node)) return;
      if (
        ts.isIdentifier(node) &&
        node !== flag.name &&
        analysis._aliasState.lexicalBindings.declarationFor(node) === flag.name
      ) {
        if (
          ts.isBinaryExpression(node.parent) &&
          node.parent.left === node &&
          node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          assignments.push(node.parent);
        } else {
          uses.push(node);
        }
      }
      ts.forEachChild(node, collect);
    }
    collect(callback.body);
    if (
      assignments.length !== 1 ||
      unwrap(assignments[0].right).kind !== ts.SyntaxKind.TrueKeyword ||
      assignments[0].pos >= write._node.pos
    ) {
      continue;
    }
    const assignmentStatement = directStatement(assignments[0]);
    const assignmentBlock = assignmentStatement?.parent;
    if (!assignmentBlock || !ts.isBlock(assignmentBlock)) continue;
    const assignmentIndex = assignmentBlock.statements.indexOf(assignmentStatement);
    let memberDeclaration = null;
    let callerGuard = null;
    for (let index = assignmentIndex - 1; index >= 0; index -= 1) {
      const statement = assignmentBlock.statements[index];
      if (ts.isIfStatement(statement) && !callerGuard) {
        callerGuard = statement;
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        const declarations = statement.declarationList.declarations.filter((declaration) =>
          ts.isIdentifier(declaration.name) && immediateAwaitedCall(declaration));
        if (declarations.length === 1) {
          memberDeclaration = declarations[0];
          break;
        }
      }
    }
    if (!memberDeclaration || !callerGuard) continue;
    const memberCall = immediateAwaitedCall(memberDeclaration);
    const exactCallerGuard = terminatingNonNullGuard(
      callback,
      memberDeclaration.name,
      memberCall.end,
      assignments[0].pos,
    );
    if (exactCallerGuard !== callerGuard) continue;
    const memberStatement = directStatement(memberDeclaration);
    const guardStatement = directStatement(callerGuard);
    if (
      memberStatement?.parent !== assignmentBlock ||
      guardStatement?.parent !== assignmentBlock ||
      assignmentBlock.statements.indexOf(guardStatement) !==
        assignmentBlock.statements.indexOf(memberStatement) + 1 ||
      assignmentIndex !== assignmentBlock.statements.indexOf(guardStatement) + 1
    ) {
      continue;
    }
    const foreign = resolveLiteralImportedFactoryMember(
      memberCall,
      transactionBinding,
      scope,
      analysis,
    );
    const local = foreign
      ? null
      : memberCompletionProof(memberCall, transactionBinding, analysis);
    if (!foreign && !local) continue;
    let fallback = null;
    let flagGuard = null;
    for (const candidate of writes) {
      const patchScope = directPatchScope(
        candidate,
        callback,
        transactionBinding,
        analysis,
      );
      if (!patchScope || patchScope.key !== scope.key || candidate._node.pos <= write._node.pos) {
        continue;
      }
      for (let current = candidate._node.parent; current && current !== callback; current = current.parent) {
        if (!ts.isIfStatement(current)) continue;
        const condition = unwrap(current.expression);
        const exactNegation =
          ts.isPrefixUnaryExpression(condition) &&
          condition.operator === ts.SyntaxKind.ExclamationToken &&
          ts.isIdentifier(unwrap(condition.operand)) &&
          analysis._aliasState.lexicalBindings.declarationFor(
            unwrap(condition.operand),
          ) === flag.name;
        const exactFalse =
          ts.isBinaryExpression(condition) &&
          condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ts.isIdentifier(unwrap(condition.left)) &&
          analysis._aliasState.lexicalBindings.declarationFor(
            unwrap(condition.left),
          ) === flag.name &&
          unwrap(condition.right).kind === ts.SyntaxKind.FalseKeyword;
        if (exactNegation || exactFalse) {
          fallback = { write: candidate, scope: patchScope };
          flagGuard = current;
          break;
        }
      }
      if (fallback) break;
    }
    if (!fallback || !flagGuard) continue;
    const fallbackRelation = commonBlockRelation(
      write._node,
      fallback.write._node,
      callback,
    );
    if (
      !fallbackRelation ||
      fallbackRelation.firstIndex >= fallbackRelation.secondIndex ||
      fallbackRelation.block.statements
        .slice(fallbackRelation.firstIndex + 1, fallbackRelation.secondIndex)
        .some((statement) =>
          hasNormalReturn(statement) ||
          statementInvalidatesTransaction(
            statement,
            transactionBinding,
            analysis,
          ))
    ) {
      continue;
    }
    if (
      uses.length !== 1 ||
      uses[0].pos < flagGuard.expression.pos ||
      uses[0].end > flagGuard.expression.end
    ) {
      continue;
    }
    const exits = normalExitKeys(callback, analysis.path, write._node.pos);
    const completion = foreign ?? local;
    return {
      coverageKind: "parent_or_patch_flag",
      coverageScopeKeys: [scope.key],
      normalExitKeys: exits,
      proofNodes: [
        ...scope.proofNodes,
        nodeKey(analysis.path, flag),
        ...(completion.proofNodes ?? []),
        nodeKey(analysis.path, callerGuard),
        nodeKey(analysis.path, assignments[0]),
        nodeKey(analysis.path, write._node),
        nodeKey(analysis.path, flagGuard),
        ...fallback.scope.proofNodes,
        ...exits,
      ],
      proofRoles: foreign
        ? [
            "dynamic_import",
            "module",
            "export",
            "factory",
            "return_object",
            "member",
            "factory_map",
            "member_map",
            "runIssueMutation",
            "inner_versionedIssuePatch",
            "member_guard",
            "projector",
            "direct_return",
            "ParentCoverage",
            "flag_assignment",
            "pending_obligation",
            "fallback_patch",
            "normal_exit",
          ]
        : [
            "local_member",
            "ParentCoverage",
            "flag_assignment",
            "pending_obligation",
            "fallback_patch",
            "normal_exit",
          ],
      memberArgumentMap: foreign
        ? {
            issueIndex: foreign.issueIndex,
            transactionIndex: foreign.transactionIndex,
          }
        : undefined,
      callSite: nodeKey(analysis.path, memberCall),
      edgeNode: memberCall,
      helperPath: fallback.write.versionedHelperPath,
      flowCoverageNodes: [assignments[0], fallback.write._node],
      flowAllowedCalls: [memberCall],
      flowPendingImpliesGuards: [flagGuard],
    };
  }
  return null;
}

function patchAuthorityCertificate(write, callback, transaction, scope, coverage, analysis) {
  const caller = analysis._registry.byExecutable.get(callback);
  const sinkOwner = enclosingFunctionRecord(write._node, analysis) ?? caller;
  if (!caller || !sinkOwner) return null;
  const transactionRoot = symbolKey(analysis.path, transaction);
  const obligationKey =
    `${transactionRoot}|${write.sinkKey}|${scope.kind}|${scope.key}`;
  return canonicalCertificate({
    edgeKey:
      `${caller.symbolKey}|${nodeKey(analysis.path, coverage.edgeNode)}|` +
      `${sinkOwner.symbolKey}`,
    sinkKey: write.sinkKey,
    callerSymbolKey: caller.symbolKey,
    calleeSymbolKey: sinkOwner.symbolKey,
    callSite: coverage.callSite,
    table: write.table,
    operation: write.operation,
    authority: "versionedIssuePatch:same_transaction",
    transactionRoot,
    issueKeyEvidence: scope.key,
    helperExport: "versionedIssuePatch",
    helperPath: coverage.helperPath,
    obligationKey,
    scopeKind: scope.kind,
    coverageKind: coverage.coverageKind,
    coverageScopeKeys: coverage.coverageScopeKeys,
    normalExitKeys: coverage.normalExitKeys,
    proofNodes: coverage.proofNodes,
    proofRoles: coverage.proofRoles,
    ...(coverage.orderedPredicateKinds
      ? { orderedPredicateKinds: coverage.orderedPredicateKinds }
      : {}),
    ...(coverage.memberProofNodes
      ? { memberProofNodes: coverage.memberProofNodes }
      : {}),
    ...(coverage.memberArgumentMap
      ? { memberArgumentMap: coverage.memberArgumentMap }
      : {}),
  });
}

function certificateForVersionedTransaction(write, writes, analysis) {
  const callback = write.transactionCallback;
  if (!callback) return null;
  const transactionBinding = transactionReceiverBinding(write, analysis);
  const transaction = callback.parameters.find((parameter) =>
    ts.isIdentifier(parameter.name) && parameter.name === transactionBinding);
  const scope = commentScope(write, analysis);
  if (!transaction || !scope) return null;
  const coverage =
    directPatchCertificate(
      write,
      writes,
      callback,
      transactionBinding,
      scope,
      analysis,
    ) ??
    accumulatorPatchCertificate(
      write,
      writes,
      callback,
      transactionBinding,
      scope,
      analysis,
    ) ??
    wrapperPatchCertificate(
      write,
      callback,
      transactionBinding,
      scope,
      analysis,
    ) ??
    carrierWrapperPatchCertificate(
      write,
      callback,
      transactionBinding,
      scope,
      analysis,
    ) ??
    predicatePartitionCertificate(
      write,
      writes,
      callback,
      transactionBinding,
      scope,
      analysis,
    ) ??
    completionFlagCertificate(
      write,
      writes,
      callback,
      transactionBinding,
      scope,
      analysis,
    );
  if (!coverage) return null;
  const flow = obligationFlowProof(
    write,
    callback,
    transactionBinding,
    coverage,
    analysis,
  );
  Object.defineProperty(write, "_patchFlow", {
    value: flow,
    configurable: true,
  });
  if (!flow?.valid) return null;
  coverage.normalExitKeys = flow.normalExitKeys;
  coverage.proofNodes = [
    ...coverage.proofNodes,
    ...flow.normalExitKeys,
  ];
  return patchAuthorityCertificate(
    write,
    callback,
    transaction,
    coverage.scope ?? scope,
    coverage,
    analysis,
  );
}

function sinkHasAuthorityEscape(sinkRecord, incoming, analysis) {
  const declaration = sinkRecord?._declaration;
  const binding =
    ts.isFunctionDeclaration(declaration) && declaration.name
      ? declaration.name
      : ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
        ? declaration.name
        : null;
  if (!binding) return false;

  for (
    let current = declaration;
    current && !ts.isSourceFile(current) && !ts.isFunctionLike(current.parent);
    current = current.parent
  ) {
    if (
      current.modifiers?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return true;
    }
  }

  const exactCalleeUses = new Set(
    incoming
      .map((call) => unwrap(call.expression))
      .filter((callee) => ts.isIdentifier(callee)),
  );
  let escaped = false;
  function visit(node) {
    if (escaped) return;
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      analysis._aliasState.lexicalBindings.declarationFor(node) === binding
    ) {
      if (exactCalleeUses.has(node) || isDeclarationIdentifier(node)) return;
      escaped = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(analysis._sourceFile);
  return escaped;
}

function collectFiniteArraySummaries(analysis) {
  const summaries = [];
  function visit(node) {
    if (ts.isArrayLiteralExpression(node)) {
      const array = node;
      const declaration =
        ts.isVariableDeclaration(array.parent) &&
        array.parent.initializer === array &&
        ts.isIdentifier(array.parent.name) &&
        isConstDeclaration(array.parent) &&
        !analysis._aliasState.assigned.has(array.parent.name)
          ? array.parent
          : null;
      const elements = [];
      let exact = true;
      for (const element of array.elements) {
        if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) {
          exact = false;
          break;
        }
        const scope = exactIssueIdentity(element, analysis);
        if (!scope) {
          exact = false;
          break;
        }
        elements.push({
          issueKey: scope,
          nodeKey: nodeKey(analysis.path, element),
        });
      }
      if (
        exact &&
        (!declaration ||
          finiteArrayBindingStable(declaration.name, null, analysis))
      ) {
        summaries.push({
          setKey: declaration
            ? `SET:${symbolKey(analysis.path, declaration.name)}`
            : `SETEXPR:${nodeKey(analysis.path, array)}`,
          origin: "EXACT_ARRAY",
          constructionNode: nodeKey(analysis.path, array),
          memberFacts: elements,
          proofNodes: [
            ...(declaration ? [nodeKey(analysis.path, declaration)] : []),
            nodeKey(analysis.path, array),
            ...elements.map((element) => element.nodeKey),
          ].sort(),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(analysis._sourceFile);
  return summaries.sort((left, right) =>
    left.constructionNode.localeCompare(right.constructionNode));
}

function certificatesForSource(writes, analysis) {
  const certificates = [];
  const patchObligations = [];
  const commentWrites = writes.filter((write) => write.table === "issueComments");
  const calls = [];
  function collect(node) {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  }
  collect(analysis._sourceFile);

  for (const write of commentWrites) {
    const sinkRecord = enclosingFunctionRecord(write._node, analysis);
    const incoming = sinkRecord
      ? calls.filter((call) => analysis._registry.resolveCallee(call.expression) === sinkRecord)
      : [];
    const requiredEdges = [];
    let unknownAuthorityEdge =
      !sinkRecord ||
      sinkHasAuthorityEscape(sinkRecord, incoming, analysis);
    if (incoming.length > 0) {
      for (const call of incoming) {
        const caller = enclosingFunctionRecord(call, analysis);
        if (!caller) {
          unknownAuthorityEdge = true;
        }
        const edgeKey = caller
          ? `${caller.symbolKey}|${nodeKey(analysis.path, call)}|${sinkRecord.symbolKey}`
          : nodeKey(analysis.path, call);
        requiredEdges.push(edgeKey);
        const certificate =
          certificateForLexicalCall(call, write, sinkRecord, analysis) ??
          certificateForSequentialCall(call, write, sinkRecord, analysis);
        if (certificate) certificates.push(certificate);
      }
    } else {
      const direct =
        certificateForDirectTrustedSink(write, analysis) ??
        certificateForVersionedTransaction(write, writes, analysis);
      if (direct) {
        requiredEdges.push(direct.edgeKey);
        certificates.push(direct);
      }
    }
    if (write.transactionCallback) {
      const scope = commentScope(write, analysis);
      const patch = certificates.find((certificate) =>
        certificate.sinkKey === write.sinkKey &&
        certificate.authority === "versionedIssuePatch:same_transaction");
      patchObligations.push({
        sinkKey: write.sinkKey,
        scopeKind: scope?.kind ?? "UNKNOWN_SCOPE",
        issueKeyEvidence: scope?.key ?? null,
        obligationKey: patch?.obligationKey ?? null,
        coverageKind: patch?.coverageKind ?? null,
        status: patch ? "ACCEPT" : "REJECT",
        normalExitKeys: write._patchFlow?.normalExitKeys ?? [],
        pendingExitKeys: write._patchFlow?.pendingExitKeys ?? [],
        invalidatedExitKeys: write._patchFlow?.invalidatedExitKeys ?? [],
        unseenExitKeys: write._patchFlow?.unseenExitKeys ?? [],
        invalidationNodeKeys: write._patchFlow?.invalidationNodeKeys ?? [],
      });
    }
    Object.defineProperties(write, {
      requiredEdgeKeys: {
        value: [...new Set(requiredEdges)].sort(),
        enumerable: false,
      },
      unknownAuthorityEdge: {
        value:
          unknownAuthorityEdge ||
          (
            requiredEdges.length === 0 &&
            !writes.some((candidate) =>
              candidate.table === "issues" &&
              candidate.operation === "delete" &&
              candidate.transactionCallback &&
              candidate.transactionCallback === write.transactionCallback)
          ),
        enumerable: false,
      },
    });
  }
  const unique = new Map();
  for (const certificate of certificates) {
    unique.set(JSON.stringify(certificate), certificate);
  }
  analysis.patchObligations = patchObligations.sort((left, right) =>
    left.sinkKey.localeCompare(right.sinkKey));
  analysis.setSummaries = collectFiniteArraySummaries(analysis);
  return [...unique.values()].sort(certificateSort);
}

export function collectIssueWritesFromSource(
  filePath,
  source,
  { resolveNamedImport = null, resolveModuleSource = null } = {},
) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const {
    aliases,
    namespaces,
    helperAliases,
    unresolvedAliases,
    lexicalBindings,
    assigned,
  } = collectTableAliases(sourceFile, filePath, resolveNamedImport);
  const writes = [];

  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const operation = staticOperation(node.expression, lexicalBindings, assigned);
      const argument = unwrap(node.arguments[0]);
      const isWrite = operation
        ? WRITE_OPERATIONS.has(operation)
        : isDynamicElementAccess(node.expression);
      const directTable = isWrite
        ? directTableReference(
            argument,
            aliases,
            namespaces,
            helperAliases,
            unresolvedAliases,
            lexicalBindings,
            true,
          )
        : null;
      const references = !isWrite
        ? new Set()
        : directTable
          ? new Set([directTable])
          : tableReferences(
              argument,
              aliases,
              namespaces,
              helperAliases,
              unresolvedAliases,
              lexicalBindings,
            );

      if (
        references.size > 0 &&
        operation === null &&
        isDynamicElementAccess(node.expression)
      ) {
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
          tableToken: argument.getText(sourceFile),
        };
        Object.defineProperty(entry, "versionedBy", {
          value: directTable === "issues" && operation === "update"
            ? versionedUpdateWrapper(
                node,
                aliases,
                namespaces,
                helperAliases,
                unresolvedAliases,
                lexicalBindings,
              )
            : null,
          enumerable: false,
        });
        Object.defineProperties(entry, {
          _node: {
            value: node,
            enumerable: false,
          },
          versionedHelperPath: {
            value:
              directTable === "issues" && operation === "update"
                ? versionedUpdateHelperResolution(
                    node,
                    aliases,
                    namespaces,
                    helperAliases,
                    unresolvedAliases,
                    lexicalBindings,
                  )?.helperPath ?? null
                : null,
            enumerable: false,
          },
          sinkKey: {
            value: `${nodeKey(filePath, node)}|${directTable}|${operation}`,
            enumerable: false,
          },
          functionName: {
            value: enclosingFunctionName(node),
            enumerable: false,
          },
          sourceFileSha256: {
            value: canonicalSourceSha256(source),
            enumerable: false,
          },
          insideRunIssueMutation: {
            value: isInsideRunIssueMutation(
              node,
              aliases,
              namespaces,
              helperAliases,
              unresolvedAliases,
              lexicalBindings,
            ),
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
  const sorted = writes.sort(sortWrites);
  const analysis = analyzeTransactionSourceFile(filePath, sourceFile, {
    resolveNamedImport,
    resolveModuleSource,
    aliasState: {
      aliases,
      namespaces,
      helperAliases,
      unresolvedAliases,
      lexicalBindings,
      assigned,
    },
  });
  Object.defineProperty(analysis, "_allWrites", {
    value: sorted,
    enumerable: false,
  });
  const authorityCertificates = certificatesForSource(sorted, analysis);
  Object.defineProperties(sorted, {
    authorityCertificates: {
      value: authorityCertificates,
      enumerable: false,
    },
    contractAnalysis: {
      value: analysis,
      enumerable: false,
    },
  });
  return sorted;
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
          !entry.name.endsWith(".d.ts") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".spec.ts")
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
  const authorityCertificates = [];
  const contractAnalyses = [];
  const resolveNamedImport = createTableImportResolver(repoRoot);
  const resolveModuleSource = createSourceModuleResolver(repoRoot);
  for (const absolute of listTypeScriptFiles(repoRoot)) {
    const relative = normalizePath(path.relative(repoRoot, absolute));
    const collected = collectIssueWritesFromSource(
      relative,
      fs.readFileSync(absolute, "utf8"),
      { resolveNamedImport, resolveModuleSource },
    );
    writes.push(...collected);
    authorityCertificates.push(...collected.authorityCertificates);
    contractAnalyses.push(collected.contractAnalysis);
  }
  const sorted = writes.sort(sortWrites);
  const uniqueCertificates = new Map();
  for (const certificate of authorityCertificates) {
    uniqueCertificates.set(JSON.stringify(certificate), certificate);
  }
  Object.defineProperties(sorted, {
    authorityCertificates: {
      value: [...uniqueCertificates.values()].sort(certificateSort),
      enumerable: false,
    },
    contractAnalyses: {
      value: contractAnalyses.sort((left, right) => left.path.localeCompare(right.path)),
      enumerable: false,
    },
  });
  return sorted;
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
      classification: entry.classification,
      state: entry.state,
      resolution: entry.resolution,
    }),
  );
  return sha256(JSON.stringify(projection));
}

function trustedHelperKey(record) {
  return `${record?.path ?? ""}\0${record?.export ?? ""}\0${record?.kind ?? ""}`;
}

export function canonicalTrustedHelperDigest(records) {
  const projection = [...records]
    .sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.export.localeCompare(right.export) ||
      left.kind.localeCompare(right.kind))
    .map(canonicalize);
  return sha256(JSON.stringify(projection));
}

function validateCatalog(catalog) {
  const errors = [];
  if (catalog?.schemaVersion !== "paperclip_issue_version_write_catalog_v2") {
    errors.push("unsupported issue-version catalog schema");
    return errors;
  }
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  const expectedEntryCount = catalog.baseline?.counts?.total;
  if (!Number.isInteger(expectedEntryCount) || entries.length !== expectedEntryCount) {
    errors.push(
      `catalog entry count is ${entries.length}, expected ${expectedEntryCount ?? "a pinned total"}`,
    );
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    errors.push("catalog entry IDs are not unique");
  }
  const acceptedEntryDigest = catalog.baseline?.acceptedEntryDigestSha256;
  if (
    typeof acceptedEntryDigest !== "string" ||
    !/^[A-F0-9]{64}$/.test(acceptedEntryDigest)
  ) {
    errors.push("catalog accepted-entry digest is missing or invalid");
  } else if (catalogEntryDigest(entries) !== acceptedEntryDigest) {
    errors.push("catalog accepted-entry digest differs");
  }
  return errors;
}

function namedImportSpecifiers(sourceFile, moduleName, exportName) {
  const matches = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      if ((specifier.propertyName?.text ?? specifier.name.text) === exportName) {
        matches.push(specifier);
      }
    }
  }
  return matches;
}

function staticPropertyName(property) {
  if (
    !property.name ||
    ts.isComputedPropertyName(property.name) ||
    !(
      ts.isIdentifier(property.name) ||
      ts.isStringLiteral(property.name) ||
      ts.isNumericLiteral(property.name)
    )
  ) {
    return null;
  }
  return property.name.text;
}

function validateVersionedIssuePatchImplementation(source, helperPath) {
  const error = (reason) =>
    `versionedIssuePatch implementation contract: ${reason} (${helperPath})`;
  const sourceFile = ts.createSourceFile(
    helperPath,
    canonicalSourceText(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "versionedIssuePatch",
  );
  if (declarations.length !== 1 || !declarations[0].body) {
    return [error("expected one body-bearing function")];
  }
  const declaration = declarations[0];
  const modifiers = ts.canHaveModifiers(declaration)
    ? ts.getModifiers(declaration) ?? []
    : [];
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return [error("function must be exported directly")];
  }
  for (const statement of sourceFile.statements) {
    if (
      statement !== declaration &&
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (specifier) => specifier.name.text === "versionedIssuePatch",
      )
    ) {
      return [error("export must be unique")];
    }
  }
  if (
    declaration.parameters.length !== 2 ||
    !ts.isIdentifier(declaration.parameters[0].name) ||
    declaration.parameters[0].name.text !== "patch" ||
    declaration.parameters[0].dotDotDotToken ||
    declaration.parameters[0].questionToken ||
    declaration.parameters[0].initializer ||
    !ts.isIdentifier(declaration.parameters[1].name) ||
    declaration.parameters[1].name.text !== "now" ||
    declaration.parameters[1].dotDotDotToken ||
    declaration.parameters[1].questionToken
  ) {
    return [error("parameters must bind patch and now")];
  }
  const nowInitializer = declaration.parameters[1].initializer &&
    unwrap(declaration.parameters[1].initializer);
  if (
    !nowInitializer ||
    !ts.isNewExpression(nowInitializer) ||
    !ts.isIdentifier(nowInitializer.expression) ||
    nowInitializer.expression.text !== "Date" ||
    (nowInitializer.arguments?.length ?? 0) !== 0
  ) {
    return [error("now must default to new Date()")];
  }
  const lexicalBindings = createLexicalBindings(sourceFile);
  const assigned = collectAssignments(sourceFile, lexicalBindings);
  if (
    assigned.has(declaration.parameters[0].name) ||
    assigned.has(declaration.parameters[1].name)
  ) {
    return [error("parameters must be immutable")];
  }
  if (
    declaration.body.statements.length !== 1 ||
    !ts.isReturnStatement(declaration.body.statements[0]) ||
    !declaration.body.statements[0].expression
  ) {
    return [error("body must contain one return")];
  }
  const returned = unwrap(declaration.body.statements[0].expression);
  if (!ts.isObjectLiteralExpression(returned) || returned.properties.length !== 3) {
    return [error("return must be the exact patch object")];
  }
  const [spreadProperty, updatedAtProperty, versionProperty] = returned.properties;
  if (
    !ts.isSpreadAssignment(spreadProperty) ||
    !ts.isPropertyAssignment(updatedAtProperty) ||
    !ts.isIdentifier(updatedAtProperty.name) ||
    updatedAtProperty.name.text !== "updatedAt" ||
    !ts.isPropertyAssignment(versionProperty) ||
    !ts.isIdentifier(versionProperty.name) ||
    versionProperty.name.text !== "version"
  ) {
    return [error("return properties must be ordered as patch, updatedAt, version")];
  }
  const spreads = returned.properties.filter(ts.isSpreadAssignment);
  const namedProperties = returned.properties.filter((property) =>
    !ts.isSpreadAssignment(property));
  if (
    spreads.length !== 1 ||
    !ts.isIdentifier(spreads[0].expression) ||
    lexicalBindings.declarationFor(spreads[0].expression) !==
      declaration.parameters[0].name
  ) {
    return [error("return must spread the patch binding once")];
  }
  const propertyGroups = new Map();
  for (const property of namedProperties) {
    const name = staticPropertyName(property);
    if (!name) return [error("computed return properties are forbidden")];
    const group = propertyGroups.get(name) ?? [];
    group.push(property);
    propertyGroups.set(name, group);
  }
  if (
    propertyGroups.size !== 2 ||
    propertyGroups.get("updatedAt")?.length !== 1 ||
    propertyGroups.get("version")?.length !== 1
  ) {
    return [error("updatedAt and version must each occur once")];
  }
  const updatedAt = propertyGroups.get("updatedAt")[0];
  if (
    !ts.isPropertyAssignment(updatedAt) ||
    !ts.isIdentifier(unwrap(updatedAt.initializer)) ||
    lexicalBindings.declarationFor(unwrap(updatedAt.initializer)) !==
      declaration.parameters[1].name
  ) {
    return [error("updatedAt must use the now binding")];
  }
  const version = propertyGroups.get("version")[0];
  if (!ts.isPropertyAssignment(version)) {
    return [error("version must be a property assignment")];
  }
  const versionExpression = unwrap(version.initializer);
  const sqlImports = namedImportSpecifiers(sourceFile, "drizzle-orm", "sql");
  const issueImports = namedImportSpecifiers(
    sourceFile,
    "./schema/issues.js",
    "issues",
  );
  if (
    sqlImports.length !== 1 ||
    sqlImports[0].name.text !== "sql" ||
    issueImports.length !== 1 ||
    issueImports[0].name.text !== "issues" ||
    assigned.has(sqlImports[0].name) ||
    assigned.has(issueImports[0].name) ||
    !ts.isTaggedTemplateExpression(versionExpression) ||
    !ts.isIdentifier(versionExpression.tag) ||
    lexicalBindings.declarationFor(versionExpression.tag) !== sqlImports[0].name ||
    !ts.isTemplateExpression(versionExpression.template) ||
    versionExpression.template.head.text !== "" ||
    versionExpression.template.templateSpans.length !== 1
  ) {
    return [error("version must use the imported sql tag exactly")];
  }
  const [span] = versionExpression.template.templateSpans;
  const column = unwrap(span.expression);
  if (
    !ts.isPropertyAccessExpression(column) ||
    column.name.text !== "version" ||
    !ts.isIdentifier(column.expression) ||
    lexicalBindings.declarationFor(column.expression) !== issueImports[0].name ||
    span.literal.text !== " + 1"
  ) {
    return [error("version must be exactly issues.version + 1")];
  }
  return [];
}

function validateVersionedIssuePatchReexport(source, helperPath, moduleName) {
  const error = (reason) =>
    `versionedIssuePatch re-export contract: ${reason} (${helperPath})`;
  const sourceFile = ts.createSourceFile(
    helperPath,
    canonicalSourceText(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = namedImportSpecifiers(
    sourceFile,
    moduleName,
    "versionedIssuePatch",
  ).filter((specifier) => !specifier.isTypeOnly);
  const exports = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const specifier of statement.exportClause.elements) {
      if (specifier.name.text === "versionedIssuePatch" && !specifier.isTypeOnly) {
        exports.push({
          module:
            statement.moduleSpecifier &&
            ts.isStringLiteral(statement.moduleSpecifier)
              ? statement.moduleSpecifier.text
              : null,
          sourceName: specifier.propertyName?.text ?? specifier.name.text,
        });
      }
    }
  }
  if (
    imports.length !== 1 ||
    imports[0].name.text !== "versionedIssuePatch" ||
    exports.length !== 1 ||
    exports[0].module !== moduleName ||
    exports[0].sourceName !== "versionedIssuePatch"
  ) {
    return [error(`must import and re-export from ${moduleName}`)];
  }
  return [];
}

function validateBodyBearingExport(source, helperPath, exportName) {
  const sourceFile = ts.createSourceFile(
    helperPath,
    canonicalSourceText(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const matches = sourceFile.statements.filter((statement) => {
    if (
      !ts.isFunctionDeclaration(statement) ||
      statement.name?.text !== exportName ||
      !statement.body
    ) {
      return false;
    }
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement) ?? []
      : [];
    return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  });
  return matches.length === 1
    ? []
    : [`trusted helper implementation export is missing or ambiguous: ${helperPath}#${exportName}`];
}

function validateTrustedHelperAuthority(catalog, repoRoot) {
  const errors = [];
  const records = catalog?.baseline?.trustedHelpers;
  const usesTrustedHelpers = (catalog?.entries ?? []).some(
    (entry) => entry?.resolution?.kind === "versioned_helper",
  );
  if (records === undefined) {
    if (repoRoot && usesTrustedHelpers) {
      errors.push("trusted helper records are missing");
    }
    return errors;
  }
  if (!Array.isArray(records)) {
    return ["trusted helper records must be an array"];
  }
  const expectedByKey = new Map(
    TRUSTED_HELPER_SPECS.map((spec) => [trustedHelperKey(spec), spec]),
  );
  const keys = records.map(trustedHelperKey);
  if (
    records.length !== TRUSTED_HELPER_SPECS.length ||
    new Set(keys).size !== records.length ||
    keys.some((key) => !expectedByKey.has(key)) ||
    [...expectedByKey].some(([key]) => !keys.includes(key))
  ) {
    errors.push("trusted helper records are not exact, unique, and complete");
  }
  for (const record of records) {
    const expected = expectedByKey.get(trustedHelperKey(record));
    const expectedFields = expected?.kind === "reexport"
      ? ["export", "kind", "module", "path", "sourceFileSha256"]
      : ["export", "kind", "path", "sourceFileSha256"];
    if (
      !expected ||
      JSON.stringify(Object.keys(record).sort()) !==
        JSON.stringify(expectedFields) ||
      (expected.module !== undefined && record.module !== expected.module) ||
      typeof record.sourceFileSha256 !== "string" ||
      !/^[A-F0-9]{64}$/.test(record.sourceFileSha256)
    ) {
      errors.push(
        `trusted helper records contain invalid metadata: ${record?.path ?? "<unknown>"}#${record?.export ?? "<unknown>"}`,
      );
    }
  }
  const acceptedDigest = catalog?.baseline?.acceptedTrustedHelperDigestSha256;
  if (
    typeof acceptedDigest !== "string" ||
    !/^[A-F0-9]{64}$/.test(acceptedDigest)
  ) {
    errors.push("trusted helper records digest is missing or invalid");
  } else if (canonicalTrustedHelperDigest(records) !== acceptedDigest) {
    errors.push("trusted helper records digest differs");
  }
  if (!repoRoot) return errors;

  const sources = new Map();
  for (const record of records) {
    if (!expectedByKey.has(trustedHelperKey(record))) continue;
    const absolute = path.resolve(
      repoRoot,
      ...normalizePath(record.path).split("/"),
    );
    const relative = path.relative(repoRoot, absolute);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fs.existsSync(absolute)
    ) {
      errors.push(`trusted helper source file is missing: ${record.path}#${record.export}`);
      continue;
    }
    let source = sources.get(record.path);
    if (source === undefined) {
      source = fs.readFileSync(absolute, "utf8");
      sources.set(record.path, source);
    }
    if (canonicalSourceSha256(source) !== record.sourceFileSha256) {
      errors.push(`trusted helper source hash differs: ${record.path}#${record.export}`);
    }
  }
  const packageSource = sources.get("packages/db/src/issue-versioning.ts");
  if (packageSource !== undefined) {
    errors.push(
      ...validateVersionedIssuePatchImplementation(
        packageSource,
        "packages/db/src/issue-versioning.ts",
      ),
    );
  }
  const serverSource = sources.get("server/src/services/issue-versioning.ts");
  if (serverSource !== undefined) {
    errors.push(
      ...validateVersionedIssuePatchReexport(
        serverSource,
        "server/src/services/issue-versioning.ts",
        "@paperclipai/db",
      ),
      ...validateBodyBearingExport(
        serverSource,
        "server/src/services/issue-versioning.ts",
        "runIssueMutation",
      ),
    );
  }
  return errors;
}

function validateCatalogSources(catalog, repoRoot) {
  const errors = [];
  const hashesByPath = new Map();
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  for (const entry of entries) {
    if (
      typeof entry?.path !== "string" ||
      typeof entry?.sourceFileSha256 !== "string" ||
      !/^[A-F0-9]{64}$/.test(entry.sourceFileSha256)
    ) {
      errors.push(`catalog source metadata is missing or invalid: ${entry?.id ?? "<unknown>"}`);
      continue;
    }
    if (!hashesByPath.has(entry.path)) hashesByPath.set(entry.path, new Set());
    hashesByPath.get(entry.path).add(entry.sourceFileSha256);
  }
  for (const [entryPath, expectedHashes] of hashesByPath) {
    if (expectedHashes.size !== 1) {
      errors.push(`catalog source hashes disagree: ${entryPath}`);
      continue;
    }
    const absolute = path.resolve(repoRoot, ...normalizePath(entryPath).split("/"));
    const relative = path.relative(repoRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
      errors.push(`catalog source file is missing: ${entryPath}`);
      continue;
    }
    const expectedHash = [...expectedHashes][0];
    const actualHash = canonicalSourceSha256(fs.readFileSync(absolute, "utf8"));
    if (expectedHash !== actualHash) {
      errors.push(`catalog source hash differs: ${entryPath}`);
    }
  }
  return errors;
}

function exactCatalogEntry(entry, catalog) {
  return catalog.entries.find((candidate) => identity(candidate) === identity(entry)) ?? null;
}

function stableCatalogEntry(entry, catalog) {
  const matches = catalog.entries.filter(
    (candidate) =>
      validResolution(candidate) &&
      stableIdentity(candidate) === stableIdentity(entry),
  );
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

function entryCounts(entries) {
  return {
    total: entries.length,
    issues: entries.filter((entry) => entry.table === "issues").length,
    issueComments: entries.filter((entry) => entry.table === "issueComments").length,
    insert: entries.filter((entry) => entry.operation === "insert").length,
    update: entries.filter((entry) => entry.operation === "update").length,
    delete: entries.filter((entry) => entry.operation === "delete").length,
    files: new Set(entries.map((entry) => entry.path)).size,
    unresolvedContainingFunctions: entries.filter((entry) => !entry.functionName).length,
  };
}

function identityCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = identity(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function validateBaseline(observed, catalog, { repoRoot = null } = {}) {
  if (!Array.isArray(observed)) {
    return { ok: false, errors: ["observed writes must be an array"] };
  }

  const errors = validateStrict(observed, catalog, { repoRoot }).errors;
  const observedIdentities = identityCounts(observed);
  const catalogIdentities = identityCounts(catalog.entries);
  for (const entry of observed) {
    const key = identity(entry);
    const remaining = catalogIdentities.get(key) ?? 0;
    if (remaining === 0) {
      errors.push(`observed write is absent from catalog: ${key}`);
    } else {
      catalogIdentities.set(key, remaining - 1);
    }
  }
  for (const entry of catalog.entries) {
    const key = identity(entry);
    const remaining = observedIdentities.get(key) ?? 0;
    if (remaining === 0) {
      errors.push(`catalog entry has no observed write: ${entry.id}`);
    } else {
      observedIdentities.set(key, remaining - 1);
    }
  }

  const digest = canonicalObservedDigest(observed);
  if (catalog.baseline?.observedDigestSha256 !== digest) {
    errors.push(
      `observed write digest is ${digest}, expected ${catalog.baseline?.observedDigestSha256 ?? "a pinned digest"}`,
    );
  }
  const counts = entryCounts(observed);
  for (const [name, actual] of Object.entries(counts)) {
    const expected = catalog.baseline?.counts?.[name];
    if (expected !== actual) {
      errors.push(`${name} write count is ${actual}, expected ${expected ?? "a pinned count"}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function compatibleClassification(entry) {
  if (entry.classification === "versioned") {
    return (
      (entry.table === "issues" && entry.operation === "update") ||
      entry.table === "issueComments"
    );
  }
  if (entry.classification === "issue_created_at_version_1") {
    return entry.table === "issues" && entry.operation === "insert";
  }
  if (entry.classification === "issue_deleted_same_transaction") {
    return (
      (entry.table === "issues" || entry.table === "issueComments") &&
      entry.operation === "delete"
    );
  }
  return false;
}

function validResolution(entry) {
  if (!compatibleClassification(entry)) return false;
  if (entry.classification === "versioned") {
    return (
      entry.state === "versioned" &&
      entry.resolution?.kind === "versioned_helper" &&
      HELPER_EXPORTS.has(entry.resolution.export) &&
      HELPER_PATHS.get(entry.resolution.export)?.has(entry.resolution.path)
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

function certificateCompatible(certificate, entry, catalogEntry) {
  if (
    !certificate ||
    certificate.sinkKey !== entry.sinkKey ||
    certificate.table !== entry.table ||
    certificate.operation !== entry.operation ||
    !isTrustedHelperPair(certificate) ||
    catalogEntry.classification !== "versioned" ||
    catalogEntry.resolution?.kind !== "versioned_helper" ||
    certificate.helperExport !== catalogEntry.resolution.export ||
    certificate.helperPath !== catalogEntry.resolution.path
  ) {
    return false;
  }
  if (certificate.helperExport === "runIssueMutation") {
    return (
      entry.table === "issueComments" &&
      ["insert", "update", "delete"].includes(entry.operation) &&
      (
        certificate.authority === "runIssueMutation:lexical" ||
        certificate.authority === "runIssueMutation:same_transaction"
      )
    );
  }
  if (!(
    certificate.helperExport === "versionedIssuePatch" &&
    entry.table === "issueComments" &&
    ["insert", "update", "delete"].includes(entry.operation) &&
    certificate.authority === "versionedIssuePatch:same_transaction"
  )) {
    return false;
  }
  const canonicalScope =
    certificate.scopeKind === "ExactIssue"
      ? /^(?:LIT:|SYM:|MEM:)/
      : certificate.scopeKind === "ExactIssueSet"
        ? /^(?:SET:|SETEXPR:)/
        : certificate.scopeKind === "ExactPredicate"
          ? /^PRED:/
          : null;
  const exactObligation =
    `${certificate.transactionRoot}|${certificate.sinkKey}|` +
    `${certificate.scopeKind}|${certificate.issueKeyEvidence}`;
  const canonicalArray = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string") &&
    JSON.stringify(value) === JSON.stringify([...new Set(value)].sort());
  return Boolean(
    canonicalScope?.test(certificate.issueKeyEvidence) &&
    certificate.obligationKey === exactObligation &&
    [
      "direct_patch",
      "accumulator_bulk_patch",
      "derived_patch_wrapper",
      "predicate_partition",
      "parent_or_patch_flag",
    ].includes(certificate.coverageKind) &&
    canonicalArray(certificate.coverageScopeKeys) &&
    canonicalArray(certificate.normalExitKeys) &&
    canonicalArray(certificate.proofNodes),
  );
}

function helperExports(repoRoot, helperPath) {
  if (!repoRoot) return new Set();
  const absoluteHelperPath = path.join(repoRoot, ...helperPath.split("/"));
  if (!fs.existsSync(absoluteHelperPath)) return new Set();
  const sourceFile = ts.createSourceFile(
    absoluteHelperPath,
    fs.readFileSync(absoluteHelperPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const specifier of statement.exportClause.elements) {
        names.add(specifier.name.text);
      }
      continue;
    }
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
  if (repoRoot) errors.push(...validateCatalogSources(catalog, repoRoot));
  errors.push(...validateTrustedHelperAuthority(catalog, repoRoot));
  const exportsByPath = new Map(
    [...INTERNAL_HELPER_PATHS].map((helperPath) => [
      helperPath,
      helperExports(repoRoot, helperPath),
    ]),
  );
  for (const entry of catalog.entries) {
    if (table && entry.table !== table) continue;
    if (!compatibleClassification(entry)) {
      errors.push(`incompatible catalog classification: ${entry.id}`);
    } else if (!validResolution(entry)) {
      errors.push(`unresolved catalog entry: ${entry.id}`);
    } else if (
      entry.classification === "versioned" &&
      repoRoot &&
      !exportsByPath.get(entry.resolution.path)?.has(entry.resolution.export)
    ) {
      errors.push(`missing helper export ${entry.resolution.export}: ${entry.id}`);
    }
  }

  for (const entry of observed) {
    if (table && entry.table !== table) continue;
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
          const certificates = (observed.authorityCertificates ?? []).filter(
            (certificate) => certificateCompatible(certificate, entry, catalogEntry),
          );
          const certifiedEdges = new Set(certificates.map((certificate) => certificate.edgeKey));
          if (
            entry.unknownAuthorityEdge ||
            !entry.requiredEdgeKeys?.length ||
            entry.requiredEdgeKeys.some((edgeKey) => !certifiedEdges.has(edgeKey))
          ) {
            errors.push(`comment write is outside runIssueMutation: ${catalogEntry.id}`);
          }
        } else if (resolutionExport === "versionedIssuePatch") {
          const certificates = (observed.authorityCertificates ?? []).filter(
            (certificate) => certificateCompatible(certificate, entry, catalogEntry),
          );
          const certifiedEdges = new Set(certificates.map((certificate) => certificate.edgeKey));
          if (
            entry.unknownAuthorityEdge ||
            !entry.requiredEdgeKeys?.length ||
            entry.requiredEdgeKeys.some((edgeKey) => !certifiedEdges.has(edgeKey))
          ) {
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
  const result = options.mode === "--verify-baseline"
    ? validateBaseline(observed, catalog, { repoRoot })
    : validateStrict(observed, catalog, { table: options.table, repoRoot });
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
