import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/cloud-readiness.yml", import.meta.url), "utf8");

test("retirement preserves exact-source verification without issuing legacy deployment readiness", () => {
  assert.match(workflow, /push:\s*\n\s*branches: \[master\]/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release-verify.yml\s+with:\s+ref: \$\{\{ github.sha \}\}/);
  const proof = workflow.split("  source_verified:")[1];
  assert.ok(proof);
  assert.match(proof, /name: Cloud source verified v1/);
  assert.match(proof, /needs: \[verify\]/);
  assert.match(proof, /if: github.repository == 'paperclipai\/paperclip' && github.ref == 'refs\/heads\/master'/);
  assert.doesNotMatch(proof, /^\s*(?:if:.*always\(|continue-on-error:)/m);
  assert.doesNotMatch(workflow, /Cloud deployable v1|docker-cloud.yml|cloud-readiness.mjs|^  (image|artifacts|ready):/m);
  assert.doesNotMatch(workflow, /packages: write|secrets: inherit|id-token: write|actions: write|checks: write|uses: .*@v\d\b/);
  assert.equal(existsSync(new URL("../../workflows/docker-cloud.yml", import.meta.url)), false);
});

// Owner decision (2026-11-12): the Runner chaos evals run on every admitted
// master commit and report, but are not a prerequisite of the source proof
// that image publication and Cloud discovery wait for.
test("Runner chaos evals still run but stay out of the publication gate", async () => {
  const { runnerChaosEvalsJob } = await import("../../../scripts/cloud-source-verification.mjs");
  const jobs = Object.fromEntries([...workflow.split(/^jobs:\n/m)[1].matchAll(/^  ([a-z_]+):\n([\s\S]*?)(?=^  [a-z_]+:\n|(?![\s\S]))/gm)]
    .map(([, name, body]) => [name, body]));
  assert.deepEqual(Object.keys(jobs), ["admission", "verify", "runner_chaos_evals", "source_verified"]);

  const chaos = jobs.runner_chaos_evals;
  assert.match(chaos, new RegExp(`^    name: ${runnerChaosEvalsJob.replace(/[()]/g, "\\$&")}$`, "m"));
  assert.match(chaos, /^    needs: admission$/m);
  assert.match(chaos, /needs\.admission\.outputs\.admitted == 'true'/);
  assert.match(chaos, /uses: \.\/\.github\/workflows\/runner-chaos-evals.yml\s+with:\s+ref: \$\{\{ github.sha \}\}/);
  assert.doesNotMatch(chaos, /continue-on-error/);

  // The proof needs exactly the source checks; re-adding chaos must fail here.
  assert.deepEqual(jobs.source_verified.match(/^    needs: (.+)$/m)?.[1], "[verify]");
  assert.match(jobs.verify, /runner_chaos_evals: false/);

  // Release callers keep the evals as a gate through the default.
  const releaseVerify = readFileSync(new URL("../../workflows/release-verify.yml", import.meta.url), "utf8");
  assert.match(releaseVerify, /runner_chaos_evals:\n\s+description: [^\n]+\n\s+required: false\n\s+default: true\n\s+type: boolean/);
  assert.match(releaseVerify, /^  runner_chaos_evals:\n(?:    #[^\n]*\n)*    if: \$\{\{ !inputs.runner_binaries_only && inputs.runner_chaos_evals \}\}$/m);
  for (const file of ["release.yml", "release-smoke.yml"]) {
    const caller = readFileSync(new URL(`../../workflows/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(caller, /runner_chaos_evals:\s*false/, file);
  }
});

test("standard image provenance and independent exact-source migrators remain available", () => {
  const docker = readFileSync(new URL("../../workflows/docker.yml", import.meta.url), "utf8");
  assert.match(docker, /target: production/);
  assert.match(docker, /type=raw,value=sha-\$\{\{ github.sha \}\}/);
  assert.match(docker, /run: node scripts\/standard-image-contract.mjs --resolve "\$GITHUB_SHA"/);
  assert.match(docker, /subject-digest: \$\{\{ steps.standard.outputs.digest \}\}/);
  const migrator = readFileSync(new URL("../../workflows/cloud-migrator-artifacts.yml", import.meta.url), "utf8");
  assert.match(migrator, /push:\s*\n\s*branches: \[master\]/);
  assert.match(migrator, /uses: actions\/attest@/);
  assert.doesNotMatch(docker, /build-and-push-cloud|docker-cloud.yml|canary-cloud/);
});
