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
