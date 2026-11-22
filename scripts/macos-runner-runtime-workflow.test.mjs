import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the macOS producer builds the pinned executable on its native target and tests the real server", () => {
  const workflow = YAML.parse(read(".github/workflows/macos-runner-runtime.yml"));
  assert.equal(workflow.jobs.build["runs-on"], "macos-15");
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  const steps = workflow.jobs.build.steps;
  assert.equal(steps.find(step => step.uses?.startsWith("actions/setup-node@")).with["node-version"], "24.21.0");
  assert.equal(workflow.jobs.verify_linux_controller.steps.find(step => step.uses?.startsWith("actions/setup-node@")).with["node-version"], 24);
  assert.ok(steps.some(step => step.run?.includes("build:binary")));
  assert.ok(steps.some(step => step.run?.includes("qualify-opencode-runtime.test.mjs") && step.env?.PAPERCLIP_OPENCODE_QUALIFY === "1"));
  assert.ok(steps.some(step => step.run?.includes("macos-runner-runtime.mjs package") && step.run.includes('"$GITHUB_SHA"')));
  assert.ok(steps.some(step => step.run?.includes("macos-runner-runtime.mjs install") && step.run.includes("await verifyRemoteProviderPack")));
  assert.equal(JSON.parse(read("packages/paperclip-runner/package.json")).dependencies["opencode-ai"], "1.18.34");
});

test("downloaded runtime inputs keep the image checkout clean", () => {
  const paths = ["docker/remote-runtimes/darwin-arm64.json", "docker/remote-runtimes/darwin-arm64.tar.gz"];
  const ignored = execFileSync("git", ["check-ignore", "--no-index", ...paths], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.deepEqual(ignored.trim().split("\n"), paths);
});

for (const [path, job] of [[".github/workflows/docker.yml", "build-and-push"], [".github/workflows/docker-merge-group.yml", "build"]]) {
  test(`${path} includes the native runtime in the source image and merge-queue image`, () => {
    const workflow = YAML.parse(read(path));
    assert.equal(workflow.jobs.macos_runner_runtime.uses, "./.github/workflows/macos-runner-runtime.yml");
    const build = workflow.jobs[job];
    assert.ok([build.needs].flat().includes("macos_runner_runtime"));
    const download = build.steps.find(step => step.name === "Download the native macOS SSH runtime");
    assert.equal(download.with.name, "${{ needs.macos_runner_runtime.outputs.artifact_name }}");
    assert.equal(download.with.path, "docker/remote-runtimes/");
  });
}

test("Core installs the additional Mac runtime without replacing the Linux pack contract", () => {
  const docker = read("Dockerfile");
  assert.match(docker, /COPY --exclude=docker\/remote-runtimes \. \./);
  assert.match(docker, /macos-runner-runtime\.mjs install .* "\$\{PAPERCLIP_BUILD_COMMIT\}"/);
  assert.match(docker, /ENV PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH=\/opt\/paperclip-runner\/provider-pack/);
});
