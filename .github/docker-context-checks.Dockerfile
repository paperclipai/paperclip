# Runs the runner's generated-file drift checks against the EXACT build
# context the image builds see — same .dockerignore semantics — so a
# context-slimming change that strips a committed build input fails the
# pull request instead of every post-merge image build. (2026-09-04: a new
# `packages/paperclip-runner/**/*.md` ignore rule stripped the committed
# capability contract out of the context; every Docker build on master then
# failed its drift check, and no cloud image published for eight hours
# while PR CI stayed green.)
#
# Only checks whose compared output is independent of dependency versions
# run here: ajv is installed for schema VALIDATION only (pinned to the
# runner's declared range), while codegen checks like
# generate-protocol-schema-module stay out — their emitted bytes vary with
# the ajv release, so running them against a fresh install would raise
# false drift alarms. Those still run inside the real image build, which
# installs the locked dependency tree; the existence assertions below keep
# their committed inputs and outputs covered by this probe regardless.
#
# node:24-slim — the runner requires Node >= 24.11 and the production
# image builds on Node 24; the digest pin keeps the security gate's own
# runtime immutable.
FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /context
COPY . .
# Committed artifacts the image build reads whose drift checks cannot run
# here (they need the locked dependency tree or compiled dist/). Existence
# in the context is the property this probe guards; content correctness is
# the real build's job. If a path is intentionally removed from the repo,
# update this list in the same PR.
RUN test -f packages/paperclip-runner/generated/capability/semantic-tool-contracts.json \
 && test -f packages/paperclip-runner/generated/semantic-action-catalog.json \
 && test -f packages/paperclip-runner/spec/evals/stress-workflow-traceability.json \
 && test -d packages/paperclip-runner/protocol/fixtures/replay
# check:runner-workflow-traceability access()es every regression test its
# spec names (it needs dist/ to RUN, so it cannot run here) — replicate
# exactly its existence walk, driven by the spec itself so this never
# needs a hand-maintained path list. (2026-09-04, second unmasking: the
# *.test.ts ignore rule stripped src/contracts/native-execution.test.ts
# and the image build failed there once the capability checks were fixed.)
RUN node -e ' \
  const manifest = require("/context/packages/paperclip-runner/spec/evals/stress-workflow-traceability.json"); \
  const { accessSync } = require("node:fs"); \
  const { resolve } = require("node:path"); \
  let count = 0; \
  for (const finding of manifest.findings) \
    for (const path of finding.regressionTests) { \
      accessSync(resolve("/context/packages/paperclip-runner", path)); \
      count += 1; \
    } \
  console.log(`traceability regression-test paths present: ${count}`);'
# ajv is installed in an isolated directory (the runner's own package.json
# uses workspace: ranges npm cannot install from) and symlinked in so ESM
# resolution finds it from the scripts' location.
RUN AJV_RANGE="$(node -p "require('/context/packages/paperclip-runner/package.json').dependencies.ajv")" \
 && mkdir /probe-deps && cd /probe-deps && npm init -y >/dev/null \
 && npm install --ignore-scripts --no-audit --no-fund "ajv@${AJV_RANGE}" \
 && ln -s /probe-deps/node_modules /context/packages/paperclip-runner/node_modules \
 && cd /context/packages/paperclip-runner \
 && node scripts/generate-capability-contract.mjs --check \
 && node scripts/check-capability-inventory.mjs
