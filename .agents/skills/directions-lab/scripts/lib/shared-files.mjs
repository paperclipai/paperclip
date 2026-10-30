import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const GITIGNORE_ANCHOR = "dist-flow-preview/";

function readOriginal(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function launchJsonWithEntries(original, entries) {
  const parsed = original ? JSON.parse(original) : { version: "0.0.1", configurations: [] };
  const configurations = Array.isArray(parsed.configurations) ? parsed.configurations : [];
  for (const entry of entries) {
    const index = configurations.findIndex((existing) => existing.name === entry.name);
    if (index === -1) configurations.push(entry);
    else configurations[index] = entry;
  }
  return `${JSON.stringify({ ...parsed, configurations }, null, 2)}\n`;
}

export function launchJsonWithoutEntries(original, names) {
  const parsed = JSON.parse(original);
  const configurations = (parsed.configurations ?? []).filter((entry) => !names.includes(entry.name));
  return `${JSON.stringify({ ...parsed, configurations }, null, 2)}\n`;
}

export function gitignoreWithLine(original, line) {
  const text = original ?? "";
  const lines = text.split("\n");
  if (lines.includes(line)) return text;
  const anchor = lines.indexOf(GITIGNORE_ANCHOR);
  if (anchor !== -1) {
    lines.splice(anchor + 1, 0, line);
    return lines.join("\n");
  }
  const trimmed = text.endsWith("\n") || text === "" ? text : `${text}\n`;
  return `${trimmed}${line}\n`;
}

export function gitignoreWithoutLine(original, line) {
  return original
    .split("\n")
    .filter((existing) => existing !== line)
    .join("\n");
}

export function addLaunchEntries(root, entries) {
  const file = path.join(root, ".claude/launch.json");
  const original = readOriginal(file);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, launchJsonWithEntries(original, entries));
  return { file, original };
}

export function addGitignoreLine(root, line) {
  const file = path.join(root, ".gitignore");
  const original = readOriginal(file);
  writeFileSync(file, gitignoreWithLine(original, line));
  return { file, original };
}

export function removeLaunchEntries(root, names) {
  const file = path.join(root, ".claude/launch.json");
  const original = readOriginal(file);
  if (original === null) return { file, original };
  writeFileSync(file, launchJsonWithoutEntries(original, names));
  return { file, original };
}

export function removeGitignoreLine(root, line) {
  const file = path.join(root, ".gitignore");
  const original = readOriginal(file);
  if (original === null) return { file, original };
  writeFileSync(file, gitignoreWithoutLine(original, line));
  return { file, original };
}

export function restoreShared(records) {
  for (const { file, original } of records) {
    if (original === null) {
      if (existsSync(file)) unlinkSync(file);
    } else writeFileSync(file, original);
  }
}
