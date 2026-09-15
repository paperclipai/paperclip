#!/usr/bin/env node
// Trusted release tooling. Packaging runs without publish credentials; publishing
// accepts only the two fixed package artifacts and never executes their scripts.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, renameSync, appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { materializePublishManifest, prepareBundledPackage } from "./prepare-bundled-package.mjs";

export const versionFor = (sha) => {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("Preview builds require a full immutable commit SHA.");
  return `0.0.0-preview.g${sha}`;
};
export function validateRequest(sha, requestId) {
  versionFor(sha);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId ?? "")) throw new Error("A correlation UUID is required.");
}

export function previewManifest(pkg, sha) {
  if (!["@paperclipai/shared", "@paperclipai/db"].includes(pkg.name)) throw new Error("Unexpected preview package.");
  const version = versionFor(sha);
  const exact = structuredClone(pkg);
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(exact[section] ?? {})) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) exact[section][name] = version;
    }
  }
  const result = materializePublishManifest({ ...exact, version });
  result.gitHead = sha;
  result.paperclipPreviewCommit = sha;
  if (pkg.name === "@paperclipai/db") result.dependencies = { ...result.dependencies, "@paperclipai/shared": version };
  return result;
}

export function assertMetadata(pkg, name, sha) {
  if (pkg?.publishConfig !== undefined || pkg?.name !== name || pkg.version !== versionFor(sha) || pkg.gitHead !== sha || pkg.paperclipPreviewCommit !== sha ||
      (name === "@paperclipai/db" && pkg.dependencies?.["@paperclipai/shared"] !== versionFor(sha))) {
    throw new Error("Preview package identity or dependency pin mismatch.");
  }
}

export function tarManifest(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  let manifest;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((v) => v === 0)) break;
    const field = (start, size) => h.subarray(start, start + size).toString("utf8").split("\0")[0].trim();
    const sizeText = field(124, 12);
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid package archive.");
    const size = Number.parseInt(sizeText, 8);
    if (offset + 512 + size > tar.length) throw new Error("Truncated package archive.");
    const name = `${field(345, 155) ? field(345, 155) + "/" : ""}${field(0, 100)}`;
    if (!name.startsWith("package/") || name.split("/").some((part) => part === "." || part === "..") || ![0, 48, 53].includes(h[156])) throw new Error("Unsupported package archive entry.");
    if (name === "package/package.json") {
      if (manifest || ![0, 48].includes(h[156])) throw new Error("Invalid package manifest entry.");
      manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!manifest) throw new Error("Missing package manifest.");
  return manifest;
}

export async function packageExists(name, sha, fetchImpl = fetch) {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/${versionFor(sha)}`, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`npm lookup failed: HTTP ${response.status}`);
  const pkg = await response.json();
  assertMetadata(pkg, name, sha);
  if (!pkg.dist?.integrity || !pkg.dist?.tarball) throw new Error("Published preview has no immutable distribution pin.");
  return true;
}

export async function planArtifacts(sha, { migrator = false, image = true, fetchImpl = fetch } = {}) {
  versionFor(sha);
  return {
    image: image && !await imageExists(sha, fetchImpl),
    packages: migrator && !(await packageExists("@paperclipai/shared", sha, fetchImpl) && await packageExists("@paperclipai/db", sha, fetchImpl)),
  };
}

export async function imageExists(sha, fetchImpl = fetch) {
  versionFor(sha);
  const tokenRes = await fetchImpl("https://ghcr.io/token?service=ghcr.io&scope=repository:paperclipai/paperclip:pull", { signal: AbortSignal.timeout(30_000) });
  if (!tokenRes.ok) throw new Error(`GHCR lookup failed: HTTP ${tokenRes.status}`);
  const { token } = await tokenRes.json();
  if (typeof token !== "string") throw new Error("GHCR did not return a pull token.");
  const base = "https://ghcr.io/v2/paperclipai/paperclip";
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" };
  const get = (url) => fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  let res = await get(`${base}/manifests/sha-${sha}-cloud`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GHCR lookup failed: HTTP ${res.status}`);
  let manifest = await res.json();
  const digest = (value) => {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error("Invalid image digest.");
    return value;
  };
  if (Array.isArray(manifest.manifests)) {
    const amd64 = manifest.manifests.find((entry) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64");
    if (!amd64) throw new Error("Cloud image has no Linux amd64 manifest.");
    res = await get(`${base}/manifests/${digest(amd64.digest)}`);
    if (!res.ok) throw new Error(`GHCR manifest lookup failed: HTTP ${res.status}`);
    manifest = await res.json();
  }
  res = await fetchImpl(`${base}/blobs/${digest(manifest.config?.digest)}`, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  // Registry blob storage may redirect to its signed storage URL. Follow only
  // with no Authorization header, so the GHCR token cannot leave the registry.
  if ([301, 302, 307, 308].includes(res.status)) {
    const location = new URL(res.headers.get("location"));
    if (location.protocol !== "https:" || location.username || location.password) throw new Error("Invalid registry blob redirect.");
    res = await fetchImpl(location.href, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  }
  if (!res.ok) throw new Error(`GHCR config lookup failed: HTTP ${res.status}`);
  const config = await res.json();
  if (config.config?.Labels?.["org.opencontainers.image.revision"] !== sha) throw new Error("Existing SHA image tag does not match the requested full commit.");
  return true;
}

/** Publication loads image data, but never runs a container or source scripts. */
export async function publishImage(file, sha, { exec = execFileSync, fetchImpl = fetch } = {}) {
  versionFor(sha);
  const image = `ghcr.io/paperclipai/paperclip:sha-${sha}-cloud`;
  if (await imageExists(sha, fetchImpl)) { console.log("Reusing the verified SHA cloud image."); return; }
  exec("docker", ["load", "--input", path.resolve(file)], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const [metadata] = JSON.parse(exec("docker", ["image", "inspect", image], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  if (metadata?.Config?.Labels?.["org.opencontainers.image.revision"] !== sha || metadata.Os !== "linux" || metadata.Architecture !== "amd64" ||
      !/^sha256:[0-9a-f]{64}$/.test(metadata.Id ?? "")) throw new Error("Built image identity or platform does not match the request.");
  // Push only this verified image ID under the one permitted tag, regardless
  // of any additional tag names present in the untrusted Docker archive.
  exec("docker", ["tag", metadata.Id, image], { stdio: "inherit" });
  exec("docker", ["push", image], { stdio: "inherit" });
}

export function packPreview(source, output, sha, { exec = execFileSync } = {}) {
  versionFor(sha);
  source = path.resolve(source); output = path.resolve(output);
  if (exec("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() !== sha) throw new Error("Source checkout differs from the requested commit.");
  mkdirSync(output, { recursive: true });
  for (const short of ["shared", "db"]) {
    exec("pnpm", ["--filter", `@paperclipai/${short}`, "build"], { cwd: source, stdio: "inherit" });
    const packageDir = path.join(source, "packages", short);
    const originalText = readFileSync(path.join(packageDir, "package.json"), "utf8");
    const original = JSON.parse(originalText);
    const pkg = previewManifest(original, sha);
    const staging = path.join(output, `package-${short}`);
    if ((pkg.bundleDependencies ?? []).length) {
      // The established helper materializes patched embedded-postgres instead
      // of publishing pnpm's dependency symlinks.
      writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(pkg));
      try { prepareBundledPackage(packageDir, staging, { sourceRoot: source }); }
      finally { writeFileSync(path.join(packageDir, "package.json"), originalText); }
    } else {
      mkdirSync(staging, { recursive: true });
      cpSync(path.join(packageDir, "dist"), path.join(staging, "dist"), { recursive: true });
      writeFileSync(path.join(staging, "package.json"), JSON.stringify(pkg));
    }
    const packed = JSON.parse(exec("npx", ["--yes", "npm@10.9.7", "pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: staging, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    renameSync(path.join(output, path.basename(packed[0].filename)), path.join(output, `${short}.tgz`));
    assertMetadata(tarManifest(readFileSync(path.join(output, `${short}.tgz`))), `@paperclipai/${short}`, sha);
  }
}

export async function publishPreview(dir, sha, { fetchImpl = fetch, exec = execFileSync, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (const short of ["shared", "db"]) {
    const name = `@paperclipai/${short}`;
    const file = path.resolve(dir, `${short}.tgz`);
    const bytes = readFileSync(file);
    assertMetadata(tarManifest(bytes), name, sha);
    if (await packageExists(name, sha, fetchImpl)) { console.log(`Reusing ${name}@${versionFor(sha)}`); continue; }
    console.log(`Publishing ${name}@${versionFor(sha)} (${createHash("sha256").update(bytes).digest("hex").slice(0, 12)})`);
    // No package checkout, lifecycle scripts, npmrc, or branch code runs here.
    exec("npm", ["publish", file, "--tag", "preview", "--access", "public", "--ignore-scripts", "--provenance", "--registry", "https://registry.npmjs.org"], { stdio: "inherit" });
    let published = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await packageExists(name, sha, fetchImpl)) { published = true; break; }
      await sleep(10_000);
    }
    if (!published) throw new Error("npm accepted the preview but it is not yet visible. Retry reuses published packages.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "plan" || command === "plan-migrator") {
      const [sha, requestId, migrator] = args;
      validateRequest(sha, requestId);
      if (process.env.GITHUB_REF !== "refs/heads/master") throw new Error("Preview workflow definitions must run from master.");
      const { image, packages } = await planArtifacts(sha, {
        image: command === "plan", migrator: command === "plan-migrator" || migrator === "true",
      });
      appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\npackages=${packages}\n`);
    } else if (command === "pack") packPreview(...args);
    else if (command === "publish") await publishPreview(...args);
    else if (command === "publish-image") await publishImage(...args);
    else if (command === "result") {
      const [sha, requestId] = args;
      validateRequest(sha, requestId);
      if (!await imageExists(sha)) throw new Error("Cloud image is still missing.");
      if (process.env.PREVIEW_MIGRATOR === "true" && !(await packageExists("@paperclipai/shared", sha) && await packageExists("@paperclipai/db", sha))) throw new Error("Preview packages are still missing.");
      mkdirSync("stack-deploy-result", { recursive: true });
      writeFileSync("stack-deploy-result/result.json", JSON.stringify({ version: 1, stage: "build", requestId, sha, status: "ready" }) + "\n");
    } else throw new Error("Expected plan, plan-migrator, pack, publish, publish-image, or result.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
