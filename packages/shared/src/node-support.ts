import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type ParsedNodeVersion = {
  raw: string;
  major: number;
  minor: number;
  patch: number;
};

type ParsedComparator = {
  operator: "<=" | ">=" | "<" | ">" | "=";
  version: ParsedNodeVersion;
};

export function parseNodeVersion(raw: string): ParsedNodeVersion {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim());
  if (!match) {
    throw new Error(`Unsupported Node version format: ${raw}`);
  }

  return {
    raw: raw.startsWith("v") ? raw : `v${raw}`,
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
  };
}

function compareNodeVersions(left: ParsedNodeVersion, right: ParsedNodeVersion) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function parseComparator(raw: string): ParsedComparator {
  const match = /^(<=|>=|<|>|=)?\s*(v?\d+(?:\.\d+){0,2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`Unsupported engine comparator: ${raw}`);
  }

  return {
    operator: (match[1] ?? "=") as ParsedComparator["operator"],
    version: parseNodeVersion(match[2] ?? ""),
  };
}

function matchesComparator(version: ParsedNodeVersion, comparator: ParsedComparator) {
  const result = compareNodeVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">":
      return result > 0;
    case ">=":
      return result >= 0;
    case "<":
      return result < 0;
    case "<=":
      return result <= 0;
    case "=":
      return result === 0;
    default:
      throw new Error(`Unsupported engine operator: ${comparator.operator satisfies never}`);
  }
}

export function satisfiesNodeVersionRange(version: ParsedNodeVersion, range: string) {
  const disjuncts = range
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/).filter(Boolean).map(parseComparator));

  if (disjuncts.length === 0) {
    throw new Error(`Unsupported empty engines.node range: ${range}`);
  }

  return disjuncts.some((comparators) => comparators.every((comparator) => matchesComparator(version, comparator)));
}

export function formatNodeCommandContext(rawContext: string) {
  const context = rawContext.trim();
  if (!context) return "this Paperclip command";
  return context.startsWith("pnpm ") || context.startsWith("paperclipai ")
    ? `\`${context}\``
    : `\`pnpm ${context}\``;
}

export function buildUnsupportedNodeMessage({
  expectedRange,
  currentVersion,
  commandContext,
}: {
  expectedRange: string;
  currentVersion: string;
  commandContext: string;
}) {
  return [
    `[paperclip] Unsupported Node.js runtime for ${formatNodeCommandContext(commandContext)}.`,
    `[paperclip] Expected: ${expectedRange}`,
    `[paperclip] Current: ${currentVersion}`,
    "[paperclip] Use Node 20.19+ LTS or Node 24+, then rerun the command.",
    "[paperclip] Odd-numbered releases like Node 21 are intentionally unsupported in local dev.",
  ].join("\n");
}

export function findNearestPackageJson(startModuleUrl: string) {
  let currentDirectory = path.dirname(fileURLToPath(startModuleUrl));

  while (true) {
    const packageJsonPath = path.join(currentDirectory, "package.json");
    if (existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error(`Could not find package.json for module ${startModuleUrl}`);
    }

    currentDirectory = parentDirectory;
  }
}

export function readExpectedNodeRangeForModule(startModuleUrl: string) {
  const packageJsonPath = findNearestPackageJson(startModuleUrl);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    engines?: { node?: string };
  };
  const expectedRange = packageJson.engines?.node?.trim();

  if (!expectedRange) {
    throw new Error(`Missing engines.node in ${packageJsonPath}`);
  }

  return expectedRange;
}

export function isSupportedNodeVersion({
  expectedRange,
  currentVersion,
}: {
  expectedRange: string;
  currentVersion: string;
}) {
  return satisfiesNodeVersionRange(parseNodeVersion(currentVersion), expectedRange);
}

export function assertSupportedNodeVersionForModule(startModuleUrl: string, commandContext: string) {
  const expectedRange = readExpectedNodeRangeForModule(startModuleUrl);
  const currentVersion = `v${process.versions.node}`;

  if (isSupportedNodeVersion({ expectedRange, currentVersion })) {
    return;
  }

  process.stderr.write(
    `${buildUnsupportedNodeMessage({ expectedRange, currentVersion, commandContext })}\n`,
  );
  process.exit(1);
}
