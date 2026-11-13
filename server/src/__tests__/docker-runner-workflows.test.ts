import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("the report-only Runner image job in docker.yml", () => {
  const workflow = read("docker.yml");
  const jobs = jobsOf(workflow);
  const report = jobs.runner_image_report;

  it("holds no credential, can only read the repository, and cannot write to a registry or sign", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(permissions(report)).toEqual(["contents: read"]);
    expect(report).not.toMatch(credential);
    expect(report).not.toMatch(/github\.actor|REGISTRY_USERNAME/);
    expect(report).not.toMatch(registryWrite);
    expect(report).toContain("persist-credentials: false");
    expectPinnedAndExpressionFree(report);
  });

  it("bounds the step that builds and the lookup", () => {
    for (const command of ["runner-image-resolve.mjs inputs", "runner-image-resolve.mjs resolve"]) {
      const running = steps(report).filter((step) => step.includes(command));
      expect(running).toHaveLength(1);
      expect(running[0]).toMatch(/^ {8}timeout-minutes: \d+$/m);
    }
  });

  it("cannot fail the run or feed another job", () => {
    expect(report).toContain("\n    continue-on-error: true\n");
    expect(report).toMatch(/^ {4}timeout-minutes: \d+$/m);
    expect(report).not.toMatch(/^ {4}(?:needs|outputs):/m);
    expect(workflow).not.toContain("needs.runner_image_report");
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== "runner_image_report") expect(/^ {4}needs: .*$/m.exec(job)?.[0] ?? "").not.toContain("runner_image_report");
    }
    expect(/^ {4}if: (.+)$/m.exec(report)![1]).toBe(
      "github.repository == 'paperclipai/paperclip' && github.repository_id == '1170821064' && github.event_name == 'push' && github.ref == 'refs/heads/master'",
    );
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
