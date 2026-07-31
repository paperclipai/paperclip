#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const PROPOSED_TELEMETRY_SCHEMA_VERSION = "proposed-telemetry-extractor.v2";

const DEFAULT_EVENTS_FILE = "packages/shared/src/telemetry/events.ts";
const EVENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,63}$/;
const ISSUE_PATTERN = /^(PAP-\d+|https:\/\/github\.com\/paperclipai\/paperclip\/issues\/\d+)$/;

export function assertRepoRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("provenance.file must be a non-empty repo-relative path");
  }
  if (value.startsWith("/") || isAbsolute(value)) {
    throw new Error(`provenance.file must be repo-relative: ${value}`);
  }
  if (/^[A-Za-z]:/.test(value)) {
    throw new Error(`provenance.file must not use a drive-letter path: ${value}`);
  }
  if (value.includes("\\")) {
    throw new Error(`provenance.file must use forward slashes: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`provenance.file contains an unsafe path segment: ${value}`);
  }
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(value)) {
    throw new Error(`provenance.file contains unsupported characters: ${value}`);
  }
  return value;
}

export function toRepoRelativePath(repoRoot, filePath) {
  const absoluteRoot = resolve(repoRoot);
  const absoluteFile = resolve(filePath);
  const repoRelative = relative(absoluteRoot, absoluteFile).split(sep).join("/");
  if (repoRelative === "" || repoRelative === ".." || repoRelative.startsWith("../")) {
    throw new Error(`events file must be inside repo root: ${filePath}`);
  }
  return assertRepoRelativePath(repoRelative);
}

export function parseProposedTelemetryDirective(commentText) {
  const normalized = normalizeComment(commentText);
  if (!normalized.includes("@ts-expect-error")) return null;

  const marker = normalized.match(/@ts-expect-error\b(?:\s*--\s*)?(?:proposed-telemetry\(([^)]+)\):\s*(.*))?/s);
  if (!marker) return null;

  const issue = marker[1]?.trim() || null;
  const text = marker[2]?.trim() || null;

  if (issue && !ISSUE_PATTERN.test(issue)) {
    throw new Error(
      `proposed telemetry rationale issue must be PAP-<digits> or a paperclipai/paperclip GitHub issue URL: ${issue}`,
    );
  }

  return {
    issue,
    text,
    missingIssue: issue === null,
    missingRationale: text === null,
  };
}

export function extractProposedEvents(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const eventsFile = resolve(repoRoot, options.eventsFile ?? DEFAULT_EVENTS_FILE);
  const provenanceFile = toRepoRelativePath(repoRoot, eventsFile);
  const sourceText = readFileSync(eventsFile, "utf8");
  const sourceFile = ts.createSourceFile(eventsFile, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const proposals = new Map();

  function recordProposal(wrapper, wrapperName, eventNameNode, directive) {
    const name = eventNameNode.text;
    assertEventName(name, "event name");
    const position = sourceFile.getLineAndCharacterOfPosition(eventNameNode.getStart(sourceFile));
    const dimensions = extractWrapperDimensions(wrapper, sourceFile, wrapperName);

    let proposal = proposals.get(name);
    if (!proposal) {
      proposal = {
        name,
        dimensions: new Map(),
        rationale: { issue: null, text: null },
        provenance: [],
      };
      proposals.set(name, proposal);
    }

    mergeRationale(proposal.rationale, directive, name);
    for (const dimension of dimensions) {
      const existing = proposal.dimensions.get(dimension.name);
      if (existing && existing.type !== dimension.type) {
        throw new Error(
          `conflicting inferred types for dimension ${dimension.name} on proposed event ${name}: ${existing.type} vs ${dimension.type}`,
        );
      }
      proposal.dimensions.set(dimension.name, dimension);
    }
    proposal.provenance.push({
      file: provenanceFile,
      line: position.line + 1,
      column: position.character,
      wrapper: wrapperName,
    });
  }

  function visitWrapper(wrapper, wrapperName = wrapper.name?.text ?? "<anonymous>") {
    if (!wrapper.body) return;

    function visit(node) {
      if (ts.isCallExpression(node) && isIdentifierTrackCall(node)) {
        const eventNameNode = node.arguments[0];
        if (eventNameNode && ts.isStringLiteral(eventNameNode)) {
          const directive = findDirectiveForNode(sourceText, eventNameNode);
          if (directive) recordProposal(wrapper, wrapperName, eventNameNode, directive);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(wrapper.body);
  }

  function visit(node) {
    if (ts.isFunctionDeclaration(node)) {
      visitWrapper(node);
    } else if (ts.isVariableDeclaration(node)) {
      visitVariableWrapper(node);
    }
    ts.forEachChild(node, visit);
  }

  function visitVariableWrapper(node) {
    if (!ts.isIdentifier(node.name)) return;
    const initializer = node.initializer;
    if (!initializer || (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))) return;
    visitWrapper(initializer, node.name.text);
  }

  visit(sourceFile);

  return {
    schemaVersion: PROPOSED_TELEMETRY_SCHEMA_VERSION,
    source: buildSource(options),
    proposals: [...proposals.values()]
      .map(formatProposal)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function buildSource(options) {
  const source = {
    repo: options.repo ?? "paperclipai/paperclip",
    ref: options.ref ?? process.env.GITHUB_SHA ?? process.env.PAPERCLIP_WORKSPACE_REPO_REF ?? "unknown",
  };
  const baseRef = options.baseRef ?? process.env.GITHUB_BASE_REF;
  if (baseRef) source.baseRef = baseRef;
  return source;
}

function isIdentifierTrackCall(node) {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "track" &&
    ts.isIdentifier(callee.expression)
  );
}

function findDirectiveForNode(sourceText, node) {
  const ranges = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];
  for (const range of ranges) {
    const directive = parseProposedTelemetryDirective(sourceText.slice(range.pos, range.end));
    if (directive) return directive;
  }
  return null;
}

function normalizeComment(commentText) {
  return commentText
    .replace(/^\s*\/\//, "")
    .replace(/^\s*\/\*/, "")
    .replace(/\*\/\s*$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .join(" ")
    .trim();
}

function extractWrapperDimensions(wrapper, sourceFile, wrapperName = wrapper.name?.text ?? "<anonymous>") {
  const dimsParam = wrapper.parameters.find(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "dims",
  );
  if (!dimsParam) return [];
  if (!dimsParam.type) {
    throw new Error(`wrapper ${wrapperName} has an untyped dims parameter`);
  }
  const typeNode = unwrapTypeNode(dimsParam.type);
  if (!ts.isTypeLiteralNode(typeNode)) {
    throw new Error(`wrapper ${wrapperName} dims parameter must be a type literal`);
  }

  return typeNode.members.map((member) => extractDimension(member, sourceFile));
}

function extractDimension(member, sourceFile) {
  if (!ts.isPropertySignature(member) || !member.type) {
    throw new Error("dims parameter type may contain only typed property signatures");
  }
  const name = propertyNameText(member.name);
  assertEventName(name, "dimension name");
  return {
    name,
    type: classifyTypeNode(member.type, sourceFile),
  };
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error("dimension names must be literal identifiers or string literals");
}

function classifyTypeNode(typeNode, sourceFile) {
  const node = unwrapTypeNode(typeNode);

  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";

  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal) || literal.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return "string";
    if (ts.isNumericLiteral(literal)) return "number";
    if (literal.kind === ts.SyntaxKind.TrueKeyword || literal.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  }

  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "RawDimension") {
    const inner = node.typeArguments?.[0];
    if (!inner) throw new Error(`RawDimension is missing a type argument at ${node.getText(sourceFile)}`);
    return classifyTypeNode(inner, sourceFile);
  }

  if (ts.isUnionTypeNode(node)) {
    const primitiveTypes = new Set();
    for (const member of node.types) {
      const unwrapped = unwrapTypeNode(member);
      if (unwrapped.kind === ts.SyntaxKind.UndefinedKeyword) continue;
      if (unwrapped.kind === ts.SyntaxKind.NullKeyword) continue;
      if (ts.isLiteralTypeNode(unwrapped) && unwrapped.literal.kind === ts.SyntaxKind.NullKeyword) continue;
      primitiveTypes.add(classifyTypeNode(unwrapped, sourceFile));
    }
    if (primitiveTypes.size !== 1) {
      throw new Error(`dimension union must resolve to one primitive type: ${node.getText(sourceFile)}`);
    }
    return [...primitiveTypes][0];
  }

  throw new Error(`unsupported dimension type: ${node.getText(sourceFile)}`);
}

function unwrapTypeNode(typeNode) {
  let node = typeNode;
  while (ts.isParenthesizedTypeNode(node)) {
    node = node.type;
  }
  return node;
}

function assertEventName(value, label) {
  if (!EVENT_NAME_PATTERN.test(value)) {
    throw new Error(`${label} must match ${EVENT_NAME_PATTERN}: ${value}`);
  }
}

function mergeRationale(target, incoming, eventName) {
  mergeRationaleField(target, incoming, "issue", eventName);
  mergeRationaleField(target, incoming, "text", eventName);
}

function mergeRationaleField(target, incoming, key, eventName) {
  const value = incoming[key];
  if (!value) return;
  if (target[key] && target[key] !== value) {
    throw new Error(`conflicting rationale ${key} for proposed event ${eventName}`);
  }
  target[key] = value;
}

function formatProposal(proposal) {
  const provenance = proposal.provenance
    .map((item) => ({
      file: assertRepoRelativePath(item.file),
      line: item.line,
      column: item.column,
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  return {
    name: proposal.name,
    dimensions: [...proposal.dimensions.values()].sort((a, b) => a.name.localeCompare(b.name)),
    rationale: {
      issue: proposal.rationale.issue,
      text: proposal.rationale.text,
      missingIssue: proposal.rationale.issue === null,
      missingRationale: proposal.rationale.text === null,
    },
    provenance,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--repo-root") options.repoRoot = next;
    else if (arg === "--events-file") options.eventsFile = next;
    else if (arg === "--repo") options.repo = next;
    else if (arg === "--ref") options.ref = next;
    else if (arg === "--base-ref") options.baseRef = next;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/extract-proposed-events.mjs [options]\n\nOptions:\n  --repo-root <path>    Repository root. Defaults to cwd.\n  --events-file <path>  events.ts path, absolute or repo-relative.\n  --repo <slug>         Source repository slug. Defaults to paperclipai/paperclip.\n  --ref <ref>           Source ref/SHA for the extractor envelope.\n  --base-ref <ref>      Optional base ref for diff-oriented inventory jobs.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    process.stdout.write(`${JSON.stringify(extractProposedEvents(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
