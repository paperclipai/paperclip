import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runnerBinaryTarget } from "./runner-binary.js";

/** Release-owned identity for the pack already installed in the Daytona image. */
export type BundledRemoteProviderPackTarget = "linux-x64" | "linux-arm64";

export function bundledRemoteProviderPackManifestPath(moduleUrl = import.meta.url, target: BundledRemoteProviderPackTarget = "linux-x64"): string {
  if (target !== "linux-x64" && target !== "linux-arm64") throw new Error("Bundled remote provider pack target is unsupported");
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Bundled remote provider pack requires a package file layout");
  if (/\/src\/live\/bundled-remote-provider-pack\.ts$/.test(url.pathname)) {
    return fileURLToPath(new URL(`../../dist/remote-provider-packs/${target}/provider-pack.json`, url));
  }
  if (/\/dist\/(?:vendor\/paperclip-runner\/)?live\/bundled-remote-provider-pack\.js$/.test(url.pathname)) {
    return fileURLToPath(new URL(`../remote-provider-packs/${target}/provider-pack.json`, url));
  }
  throw new Error("Bundled remote provider pack requires a package file layout");
}

/** A macOS controller must authorize Linux bytes for its Daytona daemon. */
export function bundledRemoteRunnerBinary(moduleUrl = import.meta.url, target: BundledRemoteProviderPackTarget = "linux-x64"): string {
  const manifestPath = bundledRemoteProviderPackManifestPath(moduleUrl, target);
  const outputRoot = resolve(dirname(manifestPath), "../..");
  const release = JSON.parse(readFileSync(join(outputRoot, "bin/release-manifest.json"), "utf8"));
  const artifact = release?.platforms?.[target];
  if (release?.schema !== "paperclip.runner.release-binaries.v1" || !/^[a-f0-9]{40}$/.test(release.sourceRevision ?? "") ||
      artifact?.path !== `${target}/paperclip-runnerd` || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
    throw new Error("runner_remote_artifact_unavailable: install the complete Paperclip release with its Linux daemon");
  }
  const binary = join(outputRoot, "bin", artifact.path);
  const bytes = readFileSync(binary);
  if (runnerBinaryTarget(bytes) !== target || "sha256:" + createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error("runner_remote_artifact_incompatible: packaged Linux daemon identity mismatch");
  }
  return binary;
}
