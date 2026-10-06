#!/usr/bin/env node
/** Read-only translation review queue, including source edits under existing keys. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localeKeyReferences } from "../ui/src/i18n/locale-structure.ts";

function flatten(value, prefix = "", output = Object.create(null)) {
  if (typeof value === "string") output[prefix] = value;
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function targetReferences(source, locale, prefix = "", output = new Map()) {
  for (const [targetKey, sourceKey] of localeKeyReferences(source, locale)) {
    const targetPath = prefix ? `${prefix}.${targetKey}` : targetKey;
    const sourcePath = prefix ? `${prefix}.${sourceKey}` : sourceKey;
    if (typeof source[sourceKey] === "string") {
      const targets = output.get(sourcePath) ?? [];
      targets.push(targetPath);
      output.set(sourcePath, targets);
    } else if (source[sourceKey] && typeof source[sourceKey] === "object" && !Array.isArray(source[sourceKey])) {
      targetReferences(source[sourceKey], locale, targetPath, output);
    }
  }
  return output;
}

export function collectLocaleChanges({ previousSource, source, previousTarget, target, locale }) {
  const oldSource = flatten(previousSource), newSource = flatten(source);
  const oldTarget = flatten(previousTarget), newTarget = flatten(target);
  const references = targetReferences(source, locale);
  return [...new Set([...Object.keys(oldSource), ...Object.keys(newSource)])].sort().flatMap((key) => {
    if (oldSource[key] === newSource[key]) return [];
    const kind = !Object.hasOwn(newSource, key) ? "removed" : !Object.hasOwn(oldSource, key) ? "added" : "changed";
    return [{
      key,
      kind,
      previousSource: oldSource[key] ?? null,
      source: newSource[key] ?? null,
      translations: (references.get(key) ?? []).map((targetKey) => ({
        key: targetKey,
        previous: oldTarget[targetKey] ?? null,
        current: newTarget[targetKey] ?? null,
        status: !Object.hasOwn(newTarget, targetKey) ? "missing"
          : newTarget[targetKey] === newSource[key] ? "matches-source"
          : newTarget[targetKey] === oldTarget[targetKey] ? "unchanged"
          : "edited",
      })),
    }];
  });
}

function readAtCommit(rootDir, commit, file) {
  const listed = execFileSync("git", ["ls-tree", "--name-only", commit, "--", file], { cwd: rootDir, encoding: "utf8" }).trim();
  if (!listed) return {};
  return JSON.parse(execFileSync("git", ["show", `${commit}:${file}`], {
    cwd: rootDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  }));
}

export function runLocaleChanges(args = process.argv.slice(2)) {
  const options = { base: null, locale: "ru", json: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--json") options.json = true;
    else if (args[i] === "--base" || args[i] === "--locale") {
      const key = args[i].slice(2), value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      options[key] = value;
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!options.base) throw new Error("Usage: node scripts/locale-changes.mjs --base <reviewed-commit-or-tag> [--locale ru] [--json]");
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(options.locale) || options.locale === "en") {
    throw new Error("--locale must name a target locale, for example ru or pt-BR.");
  }
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  // Resolve the ref before using it in object paths; never interpret it as an option.
  const baseCommit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`], {
    cwd: rootDir, encoding: "utf8",
  }).trim();
  const sourcePath = "ui/src/i18n/locales/en.json";
  const targetPath = `ui/src/i18n/locales/${options.locale}.json`;
  const changes = collectLocaleChanges({
    previousSource: readAtCommit(rootDir, baseCommit, sourcePath),
    source: JSON.parse(readFileSync(join(rootDir, sourcePath), "utf8")),
    previousTarget: readAtCommit(rootDir, baseCommit, targetPath),
    target: JSON.parse(readFileSync(join(rootDir, targetPath), "utf8")),
    locale: options.locale,
  });
  const report = {
    baseCommit, locale: options.locale,
    summary: Object.fromEntries(["added", "changed", "removed"].map((kind) => [kind, changes.filter((change) => change.kind === kind).length])),
    changes,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Source changes since ${baseCommit} (${options.locale}): ${JSON.stringify(report.summary)}`);
    for (const change of changes) {
      console.log(`${change.kind}: ${change.key}`);
      for (const translation of change.translations) console.log(`  ${translation.status}: ${translation.key}`);
    }
    console.log("Review every added/changed source message, even when its translation was edited. matches-source may be an intentional brand or technical term; it is not an automatic error. This command does not approve or rewrite translations.");
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runLocaleChanges(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
