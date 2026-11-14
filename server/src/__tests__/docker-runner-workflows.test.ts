import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNNER_IMAGE_WAIT_MINUTES } from "../../../scripts/runner-image-resolve.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (name: string) => readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");
const jobsOf = (workflow: string) => Object.fromEntries(workflow.slice(workflow.indexOf("\njobs:\n")).split(/\n(?= {2}[a-z_-]+:\n)/).slice(1)
  .map((text) => [/^ {2}([a-z_-]+):/.exec(text)![1], text]));
const permissions = (job: string) =>
  [.../\n {4}permissions:\n((?: {6}.+\n)+)/.exec(job)![1].matchAll(/^ {6}([a-z-]+): (\w+)/gm)].map((match) => `${match[1]}: ${match[2]}`);
const steps = (job: string) => job.slice(job.indexOf("\n    steps:\n")).split(/\n(?= {6}- )/).slice(1);
const scripts = (text: string) => [...text.matchAll(/^( +)run: (\|\n((?:\1 {2,}.*\n|\n)+)|.+\n)/gm)].map((match) => match[3] ?? match[2]);
const credential = /github\.token|secrets\.|GITHUB_TOKEN|GH_TOKEN|REGISTRY_PASSWORD/;
const registryWrite = /docker\/login-action|skopeo|imagetools create|actions\/attest|--push|push=true|cache-to/;

function expectPinnedAndExpressionFree(text: string) {
  const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((match) => match[1]);
  expect(uses.length).toBeGreaterThanOrEqual(4);
  for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  const shell = scripts(text);
  expect(shell.length).toBeGreaterThanOrEqual(2);
  for (const script of shell) expect(script).not.toContain("${{");
}

const named = (job: string, name: string) => {
  const found = steps(job).filter((step) => step.startsWith(`      - name: ${name}\n`));
  expect(found, name).toHaveLength(1);
  return found[0];
};
const shell = (step: string) => scripts(`${step}\n`)[0].trimEnd();
const condition = (text: string, indent: number) => new RegExp(`^ {${indent}}if: (.+)$`, "m").exec(text)?.[1] ?? "";
const minutes = (text: string, indent: number) => Number(new RegExp(`^ {${indent}}timeout-minutes: (\\d+)$`, "m").exec(text)![1]);
function runStep(step: string, env: Record<string, string>, stubs: Record<string, string>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "docker-runner-workflows-"));
  try {
    for (const [name, body] of Object.entries(stubs)) writeFileSync(path.join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    for (const file of ["output", "summary", "calls"]) writeFileSync(path.join(directory, file), "");
    const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", shell(step)], {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: `${directory}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: directory, CALLS: path.join(directory, "calls"),
        GITHUB_OUTPUT: path.join(directory, "output"), GITHUB_STEP_SUMMARY: path.join(directory, "summary"), ...env,
      },
    });
    const text = (file: string) => readFileSync(path.join(directory, file), "utf8");
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, output: text("output"), calls: text("calls").trimEnd().split("\n").filter(Boolean) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function outputs(text: string) {
  const values: Record<string, string> = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const block = /^([a-z_]+)<<(.+)$/.exec(lines[index]);
    if (block) {
      const end = lines.indexOf(block[2], index + 1);
      values[block[1]] = lines.slice(index + 1, end).join("\n");
      index = end;
    } else if (lines[index].includes("=")) {
      values[lines[index].slice(0, lines[index].indexOf("="))] = lines[index].slice(lines[index].indexOf("=") + 1);
    }
  }
  return values;
}
function listInputs(step: string, source: string, resolved: Record<string, string>) {
  const rendered = `${step}\n`.replace(new RegExp(`\\$\\{\\{ ${source.replaceAll(".", "\\.")}\\.([a-z_]+) \\}\\}`, "g"), (_match, name: string) =>
    (resolved[name] ?? "").split("\n").join(`\n${" ".repeat(12)}`));
  const list = (input: string) => {
    const found = new RegExp(`^ {10}${input}: (?:\\|\\n((?: {12}.*\\n)+)|(.*)\\n)`, "m").exec(rendered);
    return (found?.[1] ?? found?.[2] ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  };
  return { buildArgs: list("build-args"), buildContexts: list("build-contexts"), labels: list("labels") };
}
const IMAGE = `ghcr.io/paperclipai/paperclip-runner@sha256:${"c".repeat(64)}`;
const INPUTS = "1".repeat(64);
const LABELS = `io.paperclip.runner.image=${IMAGE}\nio.paperclip.runner.inputs-digest=${INPUTS}`;
const BUILD_ARGS = `PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST=${INPUTS}`;
const published = { mode: "published", build_contexts: `runner-artifacts=docker-image://${IMAGE}`, labels: LABELS, build_args: BUILD_ARGS };
const canonical = "github.repository == 'paperclipai/paperclip' && github.repository_id == '1170821064'";
const VERIFY = "Verify the attestation of the Runner image";

describe("the Runner image an application image build copies in docker.yml", () => {
  const workflow = read("docker.yml");
  const jobs = jobsOf(workflow);
  const resolver = jobs.runner_image;
  const legs = jobs["build-and-push"];
  const masterPush = "github.event_name == 'push' && github.ref == 'refs/heads/master'";
  const buildInputs = (resolved: Record<string, string>) => listInputs(named(legs, "Build and push by digest"), "needs.runner_image.outputs", resolved);
  const inlineBuild = {
    buildArgs: [
      "PAPERCLIP_BUILD_VERSION=${{ steps.build-version.outputs.version }}",
      "PAPERCLIP_BUILD_COMMIT=${{ github.sha }}",
      "CLI_TOOLS_CACHE_EPOCH=${{ steps.tools-epoch.outputs.epoch }}",
    ],
    buildContexts: [],
    labels: ["${{ steps.meta.outputs.labels }}"],
  };

  it("runs only when the repository variable has the enabling value, in the canonical repository, and not otherwise", () => {
    expect(condition(resolver, 4)).toBe(`vars.RUNNER_IMAGE_CONSUME_ENABLED == 'true' && ${canonical}`);
    expect(workflow.match(/RUNNER_IMAGE_CONSUME_ENABLED/g)).toHaveLength(1);
    expect(Object.keys(jobs).filter((name) => jobs[name].includes("runner-image-resolve.mjs"))).toEqual(["runner_image"]);
    for (const name of ["docker-merge-group.yml", "docker-app-check.yml"]) {
      expect(read(name)).not.toMatch(/runner-image-resolve|RUNNER_IMAGE_CONSUME_ENABLED|build-contexts|--build-context|io\.paperclip\.runner|runner_image/);
    }
  });

  it("gives a build with no answer exactly the build arguments, contexts and labels it had before", () => {
    expect(buildInputs({})).toEqual(inlineBuild);
    expect(buildInputs({ mode: "inline" })).toEqual(inlineBuild);
  });

  it("gives both architectures the one answer: the context, the labels and the expected inputs of the verified image", () => {
    expect(/^ {4}needs: \[(.+)\]$/m.exec(legs)![1].split(", ")).toContain("runner_image");
    const reads = [...legs.matchAll(/needs\.runner_image\.[a-z_.]+/g)].map((match) => match[0]);
    expect(new Set(reads)).toEqual(new Set(["mode", "build_args", "build_contexts", "labels"].map((name) => `needs.runner_image.outputs.${name}`)));
    for (const line of legs.split("\n").filter((entry) => entry.includes("needs.runner_image"))) expect(line).not.toContain("matrix.");
    expect(buildInputs(published)).toEqual({
      buildArgs: [...inlineBuild.buildArgs, BUILD_ARGS],
      buildContexts: [`runner-artifacts=docker-image://${IMAGE}`],
      labels: [...inlineBuild.labels, ...LABELS.split("\n")],
    });
  });

  it("hands a build only what the attestation step wrote, and that step fails and writes nothing for an image that does not verify", () => {
    const declared = /\n {4}outputs:\n((?: {6}.+\n)+)/.exec(resolver)![1].trimEnd().split("\n").map((line) => line.trim());
    expect(declared).toEqual([
      "mode: ${{ steps.verify.outputs.mode || 'inline' }}",
      "build_contexts: ${{ steps.verify.outputs.build_contexts }}",
      "labels: ${{ steps.verify.outputs.labels }}",
      "build_args: ${{ steps.verify.outputs.build_args }}",
    ]);
    const verify = named(resolver, VERIFY);
    expect(verify).toContain("\n        id: verify\n");
    expect(condition(verify, 8)).toBe("steps.resolve.outputs.mode == 'published'");
    const env = { IMAGE, LABELS, BUILD_ARGS, GH_TOKEN: "token-for-the-test" };
    const gh = (status: number) => ({ gh: `printf '%s\\n' "$*" >> "$CALLS"\nexit ${status}` });

    const verified = runStep(verify, env, gh(0));
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.calls).toEqual([
      `attestation verify oci://${IMAGE} --repo paperclipai/paperclip --signer-workflow paperclipai/paperclip/.github/workflows/runner-image.yml --source-ref refs/heads/master`,
    ]);
    expect(outputs(verified.output)).toEqual(published);
    expect(verified.stdout).not.toContain("::warning");

    for (const status of [1, 4]) {
      const refused = runStep(verify, env, gh(status));
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.calls).toHaveLength(1);
      expect(refused.output).toBe("");
      expect(refused.stdout).toContain("::warning title=Runner image not verified::");
    }
    expect(verify).not.toMatch(/continue-on-error/);
    expect(resolver).toContain("\n    continue-on-error: true\n");
    expect(condition(legs, 4)).not.toMatch(/runner_image|success\(\)/);
  });

  it("builds the committed lockfile when it copies the published Runner, and refreshes it for every other build", () => {
    const refresh = named(legs, "Refresh lockfile for Docker build context");
    expect(condition(refresh, 8)).toBe("needs.runner_image.outputs.mode != 'published'");
    expect(legs.match(/pnpm install/g)).toHaveLength(1);
    expect(refresh).toContain("pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile");
    const order = ["Refresh lockfile for Docker build context", "Build and push by digest"].map((name) => steps(legs).indexOf(named(legs, name)));
    expect(order[0]).toBeLessThan(order[1]);
  });

  it("waits only for a master push, and gives the token to the lookup only then", () => {
    const resolve = named(resolver, "Find the published Runner image of these inputs");
    expect(resolve).toContain("\n        id: resolve\n");
    expect(resolve).toContain(`          WAIT: \${{ ${masterPush} }}\n`);
    expect(resolve).toContain(`          GITHUB_TOKEN: \${{ ${masterPush} && github.token || '' }}\n`);
    const node = { node: `printf '%s\\n' "$*" >> "$CALLS"` };
    const command = (wait: string) => runStep(resolve, { WAIT: wait }, node).calls;
    const waiting = command("true");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatch(/^scripts\/runner-image-resolve\.mjs resolve --dir \S+\/runner-image-resolve --wait$/);
    for (const wait of ["false", ""]) {
      const once = command(wait);
      expect(once).toHaveLength(1);
      expect(once[0]).toMatch(/^scripts\/runner-image-resolve\.mjs resolve --dir \S+\/runner-image-resolve$/);
    }
  });

  it("holds no credential where it builds, can write nothing, and reads only what the wait and the verification need", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(permissions(resolver)).toEqual(["contents: read", "actions: read", "attestations: read"]);
    expect(resolver.slice(0, resolver.indexOf("\n    steps:\n"))).not.toMatch(credential);
    expect(steps(resolver).filter((step) => credential.test(step)).map((step) => /- name: (.+)/.exec(step)![1])).toEqual([
      "Find the published Runner image of these inputs",
      "Verify the attestation of the Runner image",
    ]);
    const building = steps(resolver).filter((step) => /runner-image-resolve\.mjs inputs|docker buildx|setup-buildx/.test(step));
    expect(building).toHaveLength(2);
    for (const step of building) expect(step).not.toMatch(/\n {8}env:\n/);
    expect(resolver).not.toMatch(/github\.actor|REGISTRY_USERNAME|REGISTRY_PASSWORD/);
    expect(resolver).not.toMatch(registryWrite);
    expect(resolver).toContain("persist-credentials: false");
    expectPinnedAndExpressionFree(resolver);
  });

  it("does not promote a merge-queue image for a commit that copies a published Runner", () => {
    const find = named(legs, "Find the merge-queue build of this commit");
    expect(condition(find, 8)).toBe(`needs.runner_image.outputs.mode != 'published' && ${canonical} && ${masterPush}`);
    for (const name of ["Download the merge-queue image", "Promote the merge-queue image"]) {
      expect(condition(named(legs, name), 8)).toBe("steps.find.outputs.run_id != ''");
    }
    expect(legs.match(/steps\.find\.outputs\.run_id/g)).toHaveLength(3);
    expect(condition(named(legs, "Build and push by digest"), 8)).toBe("steps.promote.outputs.digest == ''");
  });

  it("cannot fail or block an image build, and ends its own wait before any time limit of the workflow", () => {
    expect(resolver).toContain("\n    continue-on-error: true\n");
    expect(condition(legs, 4).startsWith("${{ !cancelled() && ")).toBe(true);
    expect(condition(legs, 4)).not.toContain("runner_image");
    const limits = ["Compute the Runner inputs of this commit", "Find the published Runner image of these inputs", "Verify the attestation of the Runner image"]
      .map((name) => minutes(named(resolver, name), 8));
    expect(limits[1]).toBeGreaterThanOrEqual(RUNNER_IMAGE_WAIT_MINUTES + 15);
    expect(minutes(resolver, 4)).toBeGreaterThanOrEqual(limits.reduce((sum, limit) => sum + limit, 0) + 5);
  });
});

describe("the pull-request check of the application image's Runner path", () => {
  const workflow = read("docker-app-check.yml");
  const jobs = jobsOf(workflow);

  it("runs a contributor's code with no credential and no way to publish", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n/m);
    expect(workflow).not.toMatch(/pull_request_target|workflow_run|workflow_dispatch|\n {2}push:/);
    expect(Object.keys(jobs)).toEqual(["runner_path"]);
    expect(permissions(jobs.runner_path)).toEqual(["contents: read"]);
    expect(workflow).not.toMatch(credential);
    expect(workflow).not.toMatch(registryWrite);
    expect(workflow).toContain("persist-credentials: false");
    expectPinnedAndExpressionFree(workflow);
  });

  it("bounds every image build and exports nothing from it", () => {
    const building = steps(jobs.runner_path).filter((step) => step.includes("docker buildx build"));
    expect(building).toHaveLength(1);
    expect(building[0]).toMatch(/^ {8}timeout-minutes: \d+$/m);
    expect(building[0].match(/--output /g)).toEqual(["--output "]);
    expect(building[0]).toContain("--output type=cacheonly");
  });
});
