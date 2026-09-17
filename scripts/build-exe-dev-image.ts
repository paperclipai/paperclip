import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { computeDaytonaImageContentId, DAYTONA_IMAGE_INPUT_PATHS, extractDaytonaDockerfileFrontendDigest } from "../tests/runner-e2e/daytona-image-content.js";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const dockerfile = await readFile(path.join(root, "docker/exe-dev-runner/Dockerfile"), "utf8");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
if (dirty && process.env.PAPERCLIP_IMAGE_ALLOW_DIRTY !== "1") throw new Error("Commit the image inputs before building, or explicitly set PAPERCLIP_IMAGE_ALLOW_DIRTY=1 for a development image");
// COPY packages includes the workspace graph. Hash every source-owned package
// input so changes outside the runner can never reuse an old content tag.
const packageInputs = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "packages"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const contentId = await computeDaytonaImageContentId({
  repositoryRoot: root,
  inputPaths: [...new Set([...DAYTONA_IMAGE_INPUT_PATHS.filter((p) => p !== "docker/daytona-runner/Dockerfile" && !p.startsWith("packages/")), ...packageInputs, "server/package.json", "ui/package.json", "cli/package.json", "docker/exe-dev-runner", "scripts/build-exe-dev-image.ts"])].sort(),
  baseImages: [...dockerfile.matchAll(/^FROM (\S+@sha256:[a-f0-9]{64})/gm)].map((match) => match[1]),
  frontendDigest: extractDaytonaDockerfileFrontendDigest(dockerfile),
});
if (args.includes("--content-id")) { console.log(contentId); process.exit(0); }
const tag = option("--tag") ?? `ghcr.io/paperclipai/paperclip-exe-runner:experimental-${contentId}`;
const build = spawnSync("docker", ["buildx", "build", "--platform", "linux/amd64", "--file", "docker/exe-dev-runner/Dockerfile",
  "--build-arg", `PAPERCLIP_RUNNER_SOURCE_REVISION=${revision}`,
  "--build-arg", `PAPERCLIP_RUNNER_CONTENT_ID=${contentId}`,
  "--tag", tag, ...(args.includes("--push") ? ["--push"] : ["--load"]),
  ...(option("--metadata-file") ? ["--metadata-file", option("--metadata-file")!] : []), "."], { cwd: root, stdio: "inherit" });
if (build.error) throw build.error;
process.exitCode = build.status ?? 1;
