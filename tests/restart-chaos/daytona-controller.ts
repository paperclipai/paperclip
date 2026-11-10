import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { assertControllerMatchesImage, defaultDaytonaImageCacheRoot, prepareDaytonaImageArtifacts } from "./daytona-image.js";
import { PLUGIN_BUILD_STAMP, pluginBuildState } from "./plugin-build.js";
import type { Timeline } from "./timeline.js";

function run(command: string, args: string[], cwd: string, label: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed (${command} ${args.join(" ")})`);
}

/**
 * Mirrors restart-chaos main.ts's Daytona preparation for the TTFT driver.
 * The bundled Daytona plugin is outside the root workspace; prepare it as CI
 * does, and rebuild it whenever its sources (or the plugin SDK's) changed since
 * the last build, so a worktree that moved to a new master tests that master's
 * plugin rather than an older build.
 */
export function ensureDaytonaPlugin(repositoryRoot: string, timeline: Timeline) {
  const root = path.join(repositoryRoot, "packages/plugins/sandbox-providers/daytona");
  // Inputs outside the plugin directory: the linked plugin SDK and the tsconfig chain both packages extend.
  const extraInputs = [
    ...["src", "package.json", "tsconfig.json"].map(file => path.join(repositoryRoot, "packages/plugins/sdk", file)),
    ...["tsconfig.json", "tsconfig.base.json"].map(file => path.join(repositoryRoot, file)),
  ];
  const state = pluginBuildState(root, extraInputs);
  timeline.add("daytona_plugin_build_state", { reason: state.reason, inputHash: state.inputHash });
  if (!state.needsBuild) return;
  run("pnpm", ["install", "--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"], root, "Daytona plugin install");
  run(process.execPath, [path.join(repositoryRoot, "scripts/link-plugin-dev-sdk.mjs")], repositoryRoot, "Plugin SDK link");
  run("pnpm", ["--dir", root, "build"], repositoryRoot, "Daytona plugin build");
  writeFileSync(path.join(root, PLUGIN_BUILD_STAMP), `${state.inputHash}\n`);
  timeline.add("daytona_plugin_built", { inputHash: state.inputHash });
}

/**
 * Controller environment for `--env daytona`: extract the image's Linux runnerd
 * and provider pack (cached per image digest, no Docker), refuse a controller
 * whose runner source differs from the image, and build the Daytona plugin.
 */
export async function prepareDaytonaController(input: { image: string; repositoryRoot: string; timeline: Timeline }):
  Promise<Record<string, string>> {
  const artifacts = await prepareDaytonaImageArtifacts({ image: input.image, cacheRoot: defaultDaytonaImageCacheRoot(),
    log: line => console.info(`[daytona-image] ${line}`) });
  const { localContentId } = await assertControllerMatchesImage(artifacts, input.repositoryRoot);
  input.timeline.add("daytona_image_matched", { image: input.image, contentId: artifacts.contentId, localContentId, sourceRevision: artifacts.sourceRevision,
    runnerdSha256: artifacts.runnerdSha256, providerPackDigest: artifacts.providerPackDigest, platformManifestDigest: artifacts.platformManifestDigest });
  ensureDaytonaPlugin(input.repositoryRoot, input.timeline);
  return { PAPERCLIP_RUNNER_REMOTE_BINARY_PATH: artifacts.runnerdPath, PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH: artifacts.providerPackPath };
}
