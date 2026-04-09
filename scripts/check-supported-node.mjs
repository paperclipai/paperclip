#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseVersion(raw) {
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

function compareVersions(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function parseComparator(raw) {
  const match = /^(<=|>=|<|>|=)?\s*(v?\d+(?:\.\d+){0,2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`Unsupported engine comparator: ${raw}`);
  }

  return {
    operator: match[1] ?? "=",
    version: parseVersion(match[2] ?? ""),
  };
}

function matchesComparator(version, comparator) {
  const result = compareVersions(version, comparator.version);
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
      throw new Error(`Unsupported engine operator: ${comparator.operator}`);
  }
}

function satisfiesRange(version, range) {
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

function readExpectedNodeRange() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const expected = packageJson?.engines?.node;
  if (typeof expected !== "string" || expected.trim().length === 0) {
    throw new Error("Root package.json is missing engines.node");
  }
  return expected.trim();
}

function formatCommandContext(rawContext) {
  const context = rawContext.trim();
  if (!context) return "this Paperclip command";
  return context.startsWith("pnpm ") || context.startsWith("paperclipai ")
    ? `\`${context}\``
    : `\`pnpm ${context}\``;
}

function failUnsupportedNode({ expectedRange, currentVersion, commandContext }) {
  const lines = [
    `[paperclip] Unsupported Node.js runtime for ${formatCommandContext(commandContext)}.`,
    `[paperclip] Expected: ${expectedRange}`,
    `[paperclip] Current: ${currentVersion}`,
    "[paperclip] Use Node 20.19+ LTS or Node 24+, then rerun the command.",
    "[paperclip] Odd-numbered releases like Node 21 are intentionally unsupported in local dev.",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
}

const expectedRange = readExpectedNodeRange();
const currentVersion = `v${process.versions.node}`;
const commandContext = process.argv.slice(2).join(" ");

if (!satisfiesRange(parseVersion(currentVersion), expectedRange)) {
  failUnsupportedNode({ expectedRange, currentVersion, commandContext });
}
