#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializePublishManifest, prepareBundledPackage } from "./prepare-bundled-package.mjs";

export function previewIdentity(sha, date, artifactBaseUrl) {
  if (!/^[a-f0-9]{40}$/.test(sha) || Number.isNaN(date.getTime())) throw new Error("Invalid preview commit");
  const base = new URL(artifactBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Invalid staging artifact base URL");
  const day = `${date.getUTCMonth() + 1}${String(date.getUTCDate()).padStart(2, "0")}`;
  const second = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds() + 1;
  return { tag: `preview/${sha}`, version: `${date.getUTCFullYear()}.${day}.${second}-preview.sha${sha}`,
    baseUrl: `${base.href.replace(/\/$/, "")}/${sha}` };
}

export function assertPreviewSourceClean(repo) {
  // Repository policy regenerates the lock in CI for manifest-only branches.
  // That generated input is allowed; every tracked source input must still
  // match the commit identifying both the app image and migrator artifact.
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", ".", ":(exclude)pnpm-lock.yaml"], { cwd: repo });
}

export function buildPreviewMigrator(outputDirectory, artifactBaseUrl) {
  const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const sha = git("rev-parse", "HEAD");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) throw new Error("Preview checkout differs from the workflow commit");
  assertPreviewSourceClean(repo);
  const identity = previewIdentity(sha, new Date(git("show", "-s", "--format=%cI", "HEAD")), artifactBaseUrl);
  execFileSync("pnpm", ["--filter", "@paperclipai/db...", "build"], { cwd: repo, stdio: "inherit" });
  const output = path.resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(path.join(os.tmpdir(), "paperclip-preview-migrator-"));
  try {
    for (const name of ["shared", "db"]) {
      const source = path.join(repo, "packages", name);
      const staged = path.join(temporary, name);
      if (name === "db") prepareBundledPackage(source, staged);
      else { mkdirSync(staged); cpSync(path.join(source, "dist"), path.join(staged, "dist"), { recursive: true }); }
      const manifest = name === "db" ? JSON.parse(readFileSync(path.join(staged, "package.json"), "utf8"))
        : materializePublishManifest(JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")));
      manifest.version = identity.version;
      manifest.gitHead = sha;
      delete manifest.devDependencies;
      delete manifest.scripts;
      if (name === "db") manifest.dependencies["@paperclipai/shared"] = `${identity.baseUrl}/paperclipai-shared.tgz`;
      writeFileSync(path.join(staged, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      for (const file of ["LICENSE", "README.md"]) {
        if (existsSync(path.join(source, file))) cpSync(path.join(source, file), path.join(staged, file));
      }
      const result = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: staged, encoding: "utf8" }));
      const destination = path.join(output, `paperclipai-${name}.tgz`);
      if (existsSync(destination)) throw new Error("Refusing to overwrite a preview artifact");
      renameSync(path.join(temporary, result[0].filename), destination);
    }
    const integrity = (name) => `sha512-${createHash("sha512").update(readFileSync(path.join(output, `paperclipai-${name}.tgz`))).digest("base64")}`;
    const manifest = { version: 1, githubSha: sha, dbPackageVersion: identity.version,
      dbPackageIntegrity: integrity("db"), dbPackageTarballUrl: `${identity.baseUrl}/paperclipai-db.tgz`,
      sharedPackageIntegrity: integrity("shared"), sharedPackageTarballUrl: `${identity.baseUrl}/paperclipai-shared.tgz` };
    writeFileSync(path.join(output, "preview-migrator.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return manifest;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: build-preview-migrator.mjs <new output directory> <staging artifact base URL>");
  console.log(JSON.stringify(buildPreviewMigrator(process.argv[2], process.argv[3])));
}
