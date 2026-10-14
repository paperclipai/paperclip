import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runnerBinaryTarget } from "./runner-binary.js";

/** Release-owned identity for the pack already installed in the Daytona image. */
export function bundledRemoteProviderPackManifestPath(moduleUrl = import.meta.url): string {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Bundled remote provider pack requires a package file layout");
  if (/\/src\/live\/bundled-remote-provider-pack\.ts$/.test(url.pathname)) {
    return fileURLToPath(new URL("../../dist/remote-provider-packs/linux-x64/provider-pack.json", url));
  }
  if (/\/dist\/(?:vendor\/paperclip-runner\/)?live\/bundled-remote-provider-pack\.js$/.test(url.pathname)) {
    return fileURLToPath(new URL("../remote-provider-packs/linux-x64/provider-pack.json", url));
  }
  throw new Error("Bundled remote provider pack requires a package file layout");
}

/** A macOS controller must authorize Linux bytes for its Daytona daemon. */
export function bundledRemoteRunnerBinary(moduleUrl = import.meta.url): string {
  const manifestPath = bundledRemoteProviderPackManifestPath(moduleUrl);
  const outputRoot = resolve(dirname(manifestPath), "../..");
  const release = JSON.parse(readFileSync(join(outputRoot, "bin/release-manifest.json"), "utf8"));
  const artifact = release?.platforms?.["linux-x64"];
  if (release?.schema !== "paperclip.runner.release-binaries.v1" || !/^[a-f0-9]{40}$/.test(release.sourceRevision ?? "") ||
      artifact?.path !== "linux-x64/paperclip-runnerd" || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
    throw new Error("runner_remote_artifact_unavailable: install the complete Paperclip release with its Linux daemon");
  }
  const binary = join(outputRoot, "bin", artifact.path);
  const bytes = readFileSync(binary);
  if (runnerBinaryTarget(bytes) !== "linux-x64" || "sha256:" + createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error("runner_remote_artifact_incompatible: packaged Linux daemon identity mismatch");
  }
  return binary;
}
