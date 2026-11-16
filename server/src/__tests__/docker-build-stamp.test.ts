import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runnerImageExpectationProblem } from "../../../scripts/check-runner-image-expectation.mjs";

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
const previewWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
const mergeGroupWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker-merge-group.yml"), "utf8");
const appCheckWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker-app-check.yml"), "utf8");

/**
 * Return the text of the Dockerfile stage that starts at the named target.
 * A stage runs from its `FROM ... AS <name>` line to the next `FROM` line.
 */
function stageBody(source: string, stageName: string): string {
  const froms = [...source.matchAll(/^FROM .*$/gm)];
  const startIdx = froms.findIndex((m) => new RegExp(`\\bAS ${stageName}\\s*$`).test(m[0]));
  expect(startIdx, `Dockerfile must declare a '${stageName}' stage`).toBeGreaterThanOrEqual(0);
  const start = froms[startIdx].index ?? 0;
  const end = froms[startIdx + 1]?.index ?? source.length;
  return source.slice(start, end);
}

it("keeps per-build runtime metadata out of the weekly CLI-install cache", () => {
  const production = stageBody(dockerfile, "production");
  const tools = production.search(/^RUN echo "cli-tools-epoch:/m);
  const entrypoint = production.search(/^RUN chmod \+x \/usr\/local\/bin\/docker-entrypoint\.sh/m);
  const runtime = production.search(/^ENV NODE_ENV=production/m);
  const epoch = production.search(/^ARG CLI_TOOLS_CACHE_EPOCH\b/m);
  expect(tools).toBeGreaterThanOrEqual(0);
  expect(entrypoint).toBeGreaterThan(tools);
  expect(epoch).toBeGreaterThanOrEqual(0);
  expect(epoch).toBeLessThan(tools);
  for (const name of ["PAPERCLIP_BUILD_VERSION", "PAPERCLIP_BUILD_COMMIT"]) {
    const declarations = [...production.matchAll(new RegExp(`^ARG ${name}\\b`, "gm"))];
    expect(declarations).toHaveLength(1);
    expect(declarations[0].index).toBeGreaterThan(entrypoint);
    expect(declarations[0].index).toBeLessThan(runtime);
    expect(production.slice(runtime)).toContain(`${name}=\${${name}}`);
  }
});

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

  it("passes PAPERCLIP_BUILD_COMMIT as a build-arg for standard and explicit preview builds", () => {
    for (const [name, source] of [["standard", workflow], ["preview", previewWorkflow]]) {
      expect(source, `${name} must pass the source commit into the image build`)
        .toMatch(/^\s*PAPERCLIP_BUILD_COMMIT=\$\{\{ (?:github.sha|inputs.source_ref) \}\}$/m);
    }
  });
});


describe("Application image Runner", () => {
  it("takes the Runner build and its stamp from runner-artifacts, and checks them before any application build", () => {
    const build = stageBody(dockerfile, "build");
    expect(build).toContain("FROM base AS build");
    const source = build.search(/^COPY \. \.$/m);
    const output = build.search(/^COPY --from=runner-artifacts \/runner-package\/dist \/app\/packages\/paperclip-runner\/dist$/m);
    const stamp = build.search(
      /^COPY --from=runner-artifacts \/runner-package\/node_modules\/\.cache\/paperclip-runner-build-inputs\.json \/app\/packages\/paperclip-runner\/node_modules\/\.cache\/paperclip-runner-build-inputs\.json$/m,
    );
    const required = build.search(/^ENV PAPERCLIP_RUNNER_VENDOR_REQUIRE_CURRENT=1$/m);
    const check = build.search(/^RUN node server\/scripts\/prepare-runner-vendor\.mjs$/m);
    const firstBuild = build.search(/^RUN pnpm /m);
    expect(source).toBeGreaterThanOrEqual(0);
    expect(output).toBeGreaterThan(source);
    expect(stamp).toBeGreaterThan(source);
    expect(required).toBeGreaterThan(Math.max(output, stamp));
    expect(check).toBeGreaterThan(required);
    expect(firstBuild).toBeGreaterThan(check);
  });

  it("checks the Runner against the inputs digest a build names, before it vendors the Runner", () => {
    const build = stageBody(dockerfile, "build");
    const stamp = build.search(/^COPY --from=runner-artifacts \/runner-package\/node_modules\//m);
    const argument = build.search(/^ARG PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST=""$/m);
    const check = build.indexOf(
      "RUN --mount=type=bind,from=runner-artifacts,source=/runner-image.json,target=/tmp/runner-image.json \\\n"
        + "  node scripts/check-runner-image-expectation.mjs /tmp/runner-image.json\n",
    );
    const vendor = build.search(/^ENV PAPERCLIP_RUNNER_VENDOR_REQUIRE_CURRENT=1$/m);
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(argument).toBeGreaterThan(stamp);
    expect(check).toBeGreaterThan(argument);
    expect(vendor).toBeGreaterThan(check);
    expect(dockerfile.match(/PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST/g)).toHaveLength(1);
    expect(dockerfile).toMatch(/^ARG PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST(?:=.*)?$/m);
  });

  const inputs = "1".repeat(64);
  const other = "2".repeat(64);
  const published = { publication: true, inputsDigest: { digest: inputs } };
  const inline = { publication: false, inputsDigest: { digest: inputs } };

  it.each<[string, object | null, string, RegExp | null]>([
    ["no expectation and an inline Runner", inline, "", null],
    ["no expectation and a published Runner", published, "", null],
    ["the published Runner of the expected inputs", published, inputs, null],
    ["an inline Runner, even of the expected inputs", inline, inputs, /^PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST is 1{64}, but the runner-artifacts of this build are not a published Runner image\. Pass /],
    ["a published Runner of other inputs", published, other, /^PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST is 2{64}, but the runner-artifacts of this build have the inputs 1{64}\. Pass /],
    ["a published Runner that names no inputs", { publication: true }, inputs, /have the inputs \(none\)/],
    ["a record that is not an object", null, inputs, /are not a published Runner image/],
    ["an expectation that is not a digest", published, "inputs-latest", /must be the 64 hexadecimal characters of a Runner inputs digest, not "inputs-latest"/],
  ])("answers for %s", (_label, image, expected, problem) => {
    const answer = runnerImageExpectationProblem(image, expected);
    if (problem === null) expect(answer).toBeNull();
    else expect(answer).toMatch(problem);
  });

  it("runs as the build runs it: nothing is read without an expectation, and a mismatch fails with the reason", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "runner-image-expectation-"));
    try {
      const file = path.join(directory, "runner-image.json");
      const run = (expected: string | null, target = file) => spawnSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "check-runner-image-expectation.mjs"), target],
        { encoding: "utf8", env: expected === null ? {} : { PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST: expected } },
      );
      expect(run(null, path.join(directory, "absent.json")).status).toBe(0);
      expect(run("", path.join(directory, "absent.json")).status).toBe(0);
      writeFileSync(file, JSON.stringify(inline));
      expect(run(inputs)).toMatchObject({ status: 1, stderr: expect.stringMatching(/^ERROR: PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST is 1{64}, but .* are not a published Runner image/) });
      writeFileSync(file, JSON.stringify(published));
      expect(run(inputs)).toMatchObject({ status: 0, stderr: "" });
      expect(run(other).status).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compiles the Runner only in the runner-artifacts stages", () => {
    const names = [...dockerfile.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((match) => match[1]);
    const application = names.filter((name) => !name.startsWith("runner-artifacts"));
    expect(application).toEqual(["base", "tailscale-client", "runner-lockfile", "deps", "build", "runner-provider-pack", "production", "cloud-plugins", "cloud-server-deps", "cloud"]);
    for (const name of application) {
      expect(stageBody(dockerfile, name), name).not.toMatch(/\b(?:cargo|rustup|rustc|gcc)\b/);
    }
  });

  it("gives an inline Runner the build commit as its revision and no publication argument", () => {
    const runner = stageBody(dockerfile, "runner-artifacts-build");
    expect(runner).toContain('revision="${PAPERCLIP_RUNNER_SOURCE_REVISION:-${PAPERCLIP_BUILD_COMMIT}}";');
    for (const [name, source] of [["standard", workflow], ["preview", previewWorkflow], ["merge group", mergeGroupWorkflow], ["pull request", appCheckWorkflow]]) {
      expect(source, name).toContain("PAPERCLIP_BUILD_COMMIT=");
      expect(source, name).not.toMatch(/PAPERCLIP_RUNNER_(?:SOURCE_REVISION|IMAGE_PUBLICATION)/);
      if (name !== "standard") expect(source, name).not.toMatch(/runner-artifacts|build-contexts?\b/);
    }
    expect(workflow.match(/runner-artifacts|build-contexts?\b/g)).toEqual(["runner-artifacts", "build-contexts"]);
  });
});


describe("Standard image remote provider pack", () => {
  it("ships the build-owned pack in the production base used by downstream images", () => {
    const pack = stageBody(dockerfile, "runner-provider-pack");
    const production = stageBody(dockerfile, "production");
    const runner = stageBody(dockerfile, "runner-artifacts-build");
    expect(pack).toContain("FROM base AS runner-provider-pack");
    expect(pack).toContain("RUN --mount=type=bind,from=runner-artifacts,target=/runner-artifacts \\\n");
    expect(pack).toContain("if [ -f /runner-artifacts/provider-pack/provider-pack.json ]; then");
    expect(pack).toContain("cp -a /runner-artifacts/provider-pack/. /provider-pack/");
    expect(pack).toContain("cp -a /runner-artifacts/provider-pack.archives /runner-artifacts/provider-pack.archive.json /provider-pack-transport/;");
    expect(pack).toContain("mkdir -p /provider-pack");
    expect(pack).toContain("Skipping remote provider pack");
    expect(production.match(/^COPY .*--from=runner-provider-pack .*$/gm)).toEqual([
      "COPY --link --chown=0:0 --from=runner-provider-pack /provider-pack-large/ /opt/paperclip-runner/provider-pack/",
      "COPY --chown=0:0 --from=runner-provider-pack /provider-pack /opt/paperclip-runner/provider-pack",
      "COPY --from=runner-provider-pack /provider-pack-transport/ /opt/paperclip-runner/",
    ]);
    expect(production).toContain("--from=runner-provider-pack /provider-pack /opt/paperclip-runner/provider-pack");
    expect(production).not.toContain("--chown=node:node --from=runner-provider-pack");
    // Modes are granted in the layer that writes the pack. A recursive chmod
    // after the COPY duplicates every changed file into another image layer.
    expect(runner).toMatch(/build-provider-pack\.mjs \/out\/provider-pack;[\s\S]*chmod -R a\+rX \/out;/);
    expect(pack).not.toContain("chmod");
    expect(production).not.toMatch(/chmod -R [^\n]*\/opt\/paperclip-runner\/provider-pack/);
    expect(production).toContain("gosu 65534:65534 node");
    expect(production).toContain("Object.values(manifest.payload.artifacts)");
    expect(production).toContain("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH=/opt/paperclip-runner/provider-pack");
    expect(workflow).toMatch(/^\s*target: production$/m);
    expect(dockerfile).not.toContain("provision-grok.mjs");
  });

  it("lets explicit cloud preview builds inherit the same pack and configuration", () => {
    const cloud = stageBody(dockerfile, "cloud");
    expect(cloud).toContain("FROM production AS cloud");
    expect(cloud).not.toContain("/opt/paperclip-runner/provider-pack");
    expect(cloud).not.toContain("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH");
    expect(dockerfile.match(/build-provider-pack\.mjs/g)).toHaveLength(1);
    expect(previewWorkflow).toMatch(/^\s*target: cloud$/m);
  });
});
