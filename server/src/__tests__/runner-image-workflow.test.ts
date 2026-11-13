import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNNER_IMAGE_CONTEXT_INPUTS } from "../../../scripts/runner-image-identity.mjs";

/**
 * Security properties of the Runner image workflow. The build runs dependency
 * lifecycle scripts, so what the jobs may do matters more than how their
 * steps are worded: these tests pin permissions, credentials and triggers,
 * not step names or order.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "runner-image.yml"), "utf8");
const mergeReview = readFileSync(path.join(repoRoot, ".github", "workflows", "pr-merge-review.yml"), "utf8");
const smoke = readFileSync(path.join(repoRoot, "docker", "runner-image", "Dockerfile.smoke"), "utf8");

/** Each job's text, by name. */
const jobs = Object.fromEntries(workflow.slice(workflow.indexOf("\njobs:\n")).split(/\n(?= {2}[a-z_-]+:\n)/).slice(1)
  .map((text) => [/^ {2}([a-z_-]+):/.exec(text)![1], text]));
const permissions = (job: string) =>
  [.../\n {4}permissions:\n((?: {6}.+\n)+)/.exec(job)![1].matchAll(/^ {6}([a-z-]+): (\w+)/gm)].map((match) => `${match[1]}: ${match[2]}`);
/** The shell of every `run:`, block or single line. */
const scripts = [...workflow.matchAll(/^( +)run: (\|\n((?:\1 {2,}.*\n|\n)+)|.+\n)/gm)].map((match) => match[3] ?? match[2]);

describe("Runner image workflow", () => {
  it("grants nothing at the workflow level and only read access to contents in each job", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(Object.keys(jobs)).toEqual(["identity", "build"]);
    for (const job of Object.values(jobs)) expect(permissions(job)).toEqual(["contents: read"]);
  });

  it("has no credential, no registry access and no way to publish", () => {
    expect(workflow).not.toMatch(/github\.token|secrets\.|GITHUB_TOKEN|docker\/login-action|packages:|id-token|attestations/);
    expect(workflow).not.toMatch(/--push|push=true|skopeo|imagetools|type=image|type=registry|cache-to|cache-from|type=gha/);
    const triggers = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect([...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1])).toEqual(["pull_request", "workflow_dispatch"]);
  });

  it("pins every action by commit and keeps expressions out of shell scripts", () => {
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(5);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    // An expression in a script is substituted before the shell parses it.
    expect(scripts.length).toBeGreaterThan(5);
    for (const script of scripts) expect(script).not.toContain("${{");
  });

  it("runs for a pull request that changes any input of the image identity", () => {
    const paths = [...workflow.matchAll(/^ {6}- (\S+)$/gm)].map((match) => match[1]);
    const covered = (file: string) => paths.some((pattern) => pattern === file
      || (pattern.endsWith("/**") && (file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2)))));
    // .dockerignore is not in the identity, but it decides which files the build receives.
    for (const input of ["Dockerfile", ".dockerignore", ".github/workflows/runner-image.yml", "docker/runner-image/Dockerfile.smoke",
      ...RUNNER_IMAGE_CONTEXT_INPUTS]) {
      expect(covered(input), input).toBe(true);
    }
  });

  it("is registered with the merge-review notifier under its own name", () => {
    const name = /^name: (.+)$/m.exec(workflow)![1];
    const listed = /workflow_run:\n {4}workflows:\n((?: {6}- .+\n)+)/.exec(mergeReview)![1].split("\n").filter(Boolean).map((line) => line.trim().slice(2));
    expect(listed).toContain(name);
  });
});

describe("Runner image smoke matrix", () => {
  it("runs the daemon on every consumer base, each pinned by digest", () => {
    const bases = [...smoke.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map((match) => match[1]).filter((base) => base !== "scratch");
    expect(bases.map((base) => base.slice(0, base.indexOf("@")))).toEqual([
      "debian:bookworm-slim",
      "debian:trixie-slim",
      "node:24-trixie-slim",
      "python:3.13-slim-trixie",
      "daytonaio/sandbox:0.8.0",
    ]);
    for (const base of bases) expect(base).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(smoke.match(/^RUN paperclip-runnerd --build-metadata /gm)).toHaveLength(bases.length);
    // The final stage reads a result from every base, so none can be skipped.
    expect(smoke.slice(smoke.indexOf("FROM scratch AS smoke")).match(/^COPY --from=smoke-/gm)).toHaveLength(bases.length);
  });

  it("reads the Runner image only the way a consumer may", () => {
    const copies = [...smoke.matchAll(/^COPY --from=runner-artifacts (.+)$/gm)].map((match) => match[1]);
    expect(new Set(copies)).toEqual(new Set(["/paperclip-runnerd /usr/local/bin/paperclip-runnerd"]));
    expect(smoke).not.toMatch(/^FROM runner-artifacts/m);
  });
});
