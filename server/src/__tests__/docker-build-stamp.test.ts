import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the Docker build-stamp wiring.
 *
 * The server build runs scripts/write-build-stamp.mjs, which stamps the built
 * commit into dist/build-info.json. The build context has no .git, so the
 * script reads PAPERCLIP_BUILD_COMMIT instead. Docker exposes an ARG to the
 * next RUN as an environment variable, but an ARG goes out of scope at the end
 * of its stage. So the build stage must declare `ARG PAPERCLIP_BUILD_COMMIT`
 * before the server build; the production ARG alone stamps nothing, because
 * the server build already ran in the earlier stage.
 *
 * This guard fails if a refactor drops the build-stage ARG, moves it after the
 * server build, or removes the build-arg the docker workflow passes.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker.yml"), "utf8");

/**
 * Return the text of the Dockerfile stage that starts at the named target.
 * A stage runs from its `FROM ... AS <name>` line to the next `FROM` line.
 */
function stageBody(source: string, stageName: string): string {
  const froms = [...source.matchAll(/^FROM .*$/gm)];
  const startIdx = froms.findIndex((m) => new RegExp(`\\bAS ${stageName}\\b`).test(m[0]));
  expect(startIdx, `Dockerfile must declare a '${stageName}' stage`).toBeGreaterThanOrEqual(0);
  const start = froms[startIdx].index ?? 0;
  const end = froms[startIdx + 1]?.index ?? source.length;
  return source.slice(start, end);
}

describe("docker build-stamp wiring", () => {
  it("declares PAPERCLIP_BUILD_COMMIT in the build stage before the server build", () => {
    const build = stageBody(dockerfile, "build");
    const argIdx = build.search(/^ARG PAPERCLIP_BUILD_COMMIT\b/m);
    const serverBuildIdx = build.search(/^RUN pnpm --filter @paperclipai\/server build\b/m);
    expect(argIdx, "build stage must declare ARG PAPERCLIP_BUILD_COMMIT").toBeGreaterThanOrEqual(0);
    expect(serverBuildIdx, "build stage must run the server build").toBeGreaterThanOrEqual(0);
    expect(
      argIdx,
      "ARG PAPERCLIP_BUILD_COMMIT must precede the server build so the stamp script reads it",
    ).toBeLessThan(serverBuildIdx);
  });

  it("passes PAPERCLIP_BUILD_COMMIT as a build-arg for both image targets", () => {
    const argLines = [...workflow.matchAll(/^\s*PAPERCLIP_BUILD_COMMIT=.*$/gm)];
    expect(
      argLines.length,
      "the docker workflow must pass PAPERCLIP_BUILD_COMMIT for the production and cloud builds",
    ).toBeGreaterThanOrEqual(2);
  });
});
