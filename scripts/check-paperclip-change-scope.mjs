#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function runGit(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function parseArgs(argv) {
  const result = {
    base: null,
    head: null,
    files: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") {
      result.base = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--head") {
      result.head = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    result.files.push(arg);
  }

  return result;
}

function parseGithubEventRange() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    if (event.pull_request?.base?.sha && event.pull_request?.head?.sha) {
      return {
        base: event.pull_request.base.sha,
        head: event.pull_request.head.sha,
      };
    }
    if (event.before && event.after) {
      return { base: event.before, head: event.after };
    }
  } catch {
    return null;
  }
  return null;
}

function toLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getChangedFiles(parsed) {
  if (parsed.files.length > 0) {
    return [...new Set(parsed.files)];
  }

  if (parsed.base && parsed.head) {
    return toLines(runGit(["diff", "--name-only", parsed.base, parsed.head]));
  }

  const eventRange = parseGithubEventRange();
  if (eventRange) {
    return toLines(runGit(["diff", "--name-only", eventRange.base, eventRange.head]));
  }

  const staged = toLines(runGit(["diff", "--name-only", "--cached"]));
  if (staged.length > 0) {
    return staged;
  }

  const tracked = toLines(runGit(["diff", "--name-only", "HEAD"]));
  const untracked = toLines(runGit(["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])];
}

function formatList(items) {
  return items.map((item) => `  - ${item}`).join("\n");
}

const parsed = parseArgs(process.argv.slice(2));
const changedFiles = getChangedFiles(parsed);

if (changedFiles.length === 0) {
  console.log("[paperclip-change-scope] No changed files detected. Scope gate skipped.");
  process.exit(0);
}

const schemaFiles = changedFiles.filter(
  (file) => file.startsWith("packages/db/src/schema/") && file !== "packages/db/src/schema/index.ts",
);
const schemaIndexChanged = changedFiles.includes("packages/db/src/schema/index.ts");
const migrationFiles = changedFiles.filter((file) => file.startsWith("packages/db/src/migrations/"));

const sharedFiles = changedFiles.filter((file) => file.startsWith("packages/shared/src/"));
const serverOrUiFiles = changedFiles.filter(
  (file) => file.startsWith("server/src/") || file.startsWith("ui/src/"),
);

const errors = [];

if (schemaFiles.length > 0) {
  if (!schemaIndexChanged) {
    errors.push(
      [
        "Schema change detected without schema index update.",
        "Touched schema files:",
        formatList(schemaFiles),
        "Required follow-up:",
        "  - update packages/db/src/schema/index.ts",
        "  - run pnpm db:generate if a migration is needed",
        "  - run pnpm -r typecheck",
      ].join("\n"),
    );
  }

  if (migrationFiles.length === 0) {
    errors.push(
      [
        "Schema change detected without any migration file change.",
        "Touched schema files:",
        formatList(schemaFiles),
        "Required follow-up:",
        "  - run pnpm db:generate when this schema change needs a migration",
        "  - include the generated files under packages/db/src/migrations/",
        "  - if this slice is intentionally docs-only, do not include schema file edits",
      ].join("\n"),
    );
  }
}

if (sharedFiles.length > 0 && serverOrUiFiles.length === 0) {
  errors.push(
    [
      "Shared contract change detected without matching server/ui implementation updates.",
      "Touched shared files:",
      formatList(sharedFiles),
      "Required follow-up:",
      "  - include the directly impacted files under server/src/ or ui/src/",
      "  - confirm db/shared/server/ui contract sync",
      "  - run pnpm run check:paperclip:fast and pnpm -r typecheck",
    ].join("\n"),
  );
}

if (errors.length > 0) {
  console.error("[paperclip-change-scope] Scope gate failed.\n");
  console.error(errors.join("\n\n"));
  process.exit(1);
}

console.log("[paperclip-change-scope] Scope gate passed.");
console.log(
  [
    `  changed files: ${changedFiles.length}`,
    schemaFiles.length > 0 ? `  schema files: ${schemaFiles.length}` : "  schema files: 0",
    sharedFiles.length > 0 ? `  shared files: ${sharedFiles.length}` : "  shared files: 0",
    serverOrUiFiles.length > 0 ? `  server/ui files: ${serverOrUiFiles.length}` : "  server/ui files: 0",
  ].join("\n"),
);
