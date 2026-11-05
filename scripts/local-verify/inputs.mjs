import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "../ci/execution-plan.mjs";
import { productInputs } from "../../.github/scripts/ci-inputs.mjs";

export const protocolVersion = 1;

export function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] });
}

export function localEnvironment(env = process.env) {
  const result = { ...env };
  delete result.GITHUB_WORKFLOW;
  delete result.PAPERCLIP_CI_TEST_SELECTION;
  delete result.PAPERCLIP_CI_SELECTION_HASH;
  return result;
}

export function comparison(root, requestedBase) {
  let base;
  for (const ref of requestedBase ? [requestedBase] : ["origin/master", "master"]) {
    try {
      const commit = git(root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
      base = git(root, "merge-base", "HEAD", commit).trim();
      break;
    } catch {}
  }
  if (!base) throw new Error("Cannot resolve a base. Pass --base <ref>.");
  const changed = [...new Set([
    ...git(root, "diff", "--name-only", "--no-renames", "-z", base, "--").split("\0"),
    ...git(root, "diff", "--cached", "--name-only", "--no-renames", "-z", base, "--").split("\0"),
    ...git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ].filter(Boolean))].sort();
  return { base, head: git(root, "rev-parse", "HEAD").trim(), changed };
}

function version(root, env, command, args) {
  try { return execFileSync(command, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return "unavailable"; }
}

export function snapshot(root, env = localEnvironment()) {
  root = realpathSync(root);
  const files = sourceFiles(root);
  const hash = createHash("sha256");
  const append = record => hash.update(`${JSON.stringify(record)}\n`);
  const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  let cacheable = true;
  const addFile = file => {
    const absolute = path.join(root, file);
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(absolute);
        if (!target.startsWith(`${root}${path.sep}`)) cacheable = false;
        const regular = lstatSync(target).isFile();
        if (!regular) cacheable = false;
        append(["link", file, stat.mode, readlinkSync(absolute), target, regular ? digest(target) : null]);
      } else if (stat.isFile()) append(["file", file, stat.mode, digest(absolute)]);
      else { cacheable = false; append(["special", file, stat.mode]); }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      append(["missing", file]);
    }
  };
  productInputs(files).forEach(addFile);
  const directories = new Set(["", ...files.filter(file => path.basename(file) === "package.json").map(path.dirname)]);
  for (const directory of [...directories].sort()) {
    for (const name of [".env", ".env.local", ".env.test", ".env.test.local"]) addFile(path.join(directory, name));
    const installed = path.join(directory, "node_modules");
    const bindings = relative => {
      let entries;
      try { entries = readdirSync(path.join(root, relative), { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") && entry.name !== ".bin") continue;
        const name = path.join(relative, entry.name), absolute = path.join(root, name);
        append(["binding", name, entry.isSymbolicLink() ? "link" : entry.isFile() ? "file" : "directory"]);
        if (entry.name.startsWith("@") || entry.name === ".bin") bindings(name);
        else if (entry.isSymbolicLink()) append(["target", name, readlinkSync(absolute)]);
        else if (entry.isFile()) append(["contents", name, digest(absolute)]);
        try { append(["package", name, digest(path.join(absolute, "package.json"))]); }
        catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
          append(["package-missing", name]);
        }
      }
    };
    bindings(installed);
  }
  for (const file of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"]) addFile(file);
  const environment = Object.fromEntries(Object.keys(env).sort().map(name => [name, env[name]]));
  if (Object.entries(env).some(([name, value]) => value?.trim() && (
    name === "DATABASE_URL" || name === "PAPERCLIP_TEST_POSTGRES_ADMIN_URL"
    || /^PAPERCLIP_.*_TEST_DATABASE_URL$/.test(name)
    || /^(?:PAPERCLIP|TEST)_.*(?:LIVE|E2E_LIVE)$/.test(name) && /^(?:1|true)$/i.test(value)
  ))) cacheable = false;
  const context = { version: protocolVersion, root, node: process.version, executable: realpathSync(process.execPath),
    platform: process.platform, arch: process.arch, environment,
    pnpm: version(root, env, "pnpm", ["--version"]),
    rust: version(root, env, "rustc", ["--version", "--verbose"]),
    cargo: version(root, env, "cargo", ["--version"]) };
  append(["context", context]);
  return { hash: hash.digest("hex"), cacheable };
}

export function requestKey(inputs, diff, full) {
  return createHash("sha256").update(JSON.stringify({ version: protocolVersion, inputs: inputs.hash,
    base: diff.base, changed: diff.changed, full })).digest("hex");
}
