#!/usr/bin/env node
// Advisory LLM analysis pass for the image-bloat detector. Feeds the Dockerfile
// diff, the lockfile diff, and the deterministic detector report to a model via a
// LiteLLM-compatible gateway and asks it to predict which changes are likely to
// add duplicated bytes (and suggest fixes).
//
// This is advisory only and is deliberately kept OUT of `docker build`:
//   - a key in the build context/ARG would end up in the image or build cache;
//   - an LLM call makes the build non-deterministic and network-dependent.
// Run it as a pre-push/CI step *around* the build, never inside it.
//
// It is opt-in and endpoint-explicit: the repo diffs and the bearer key are only
// ever sent to the host named by LITELLM_BASE_URL. There is no default endpoint,
// so a contributor cannot silently ship repository content to a third-party host
// — without LITELLM_BASE_URL the pass skips with a note. Set LITELLM_BASE_URL to
// a gateway you control (or one the project has vetted) before the diffs leave
// the machine.
//
// Usage:
//   node scripts/image-bloat-llm.mjs \
//     --detector-report report.json \
//     --dockerfile-diff <(git diff -- Dockerfile) \
//     --lockfile-diff <(git diff -- pnpm-lock.yaml)

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = "qwen3.8-27b-w4a16";

// No DEFAULT_BASE_URL on purpose: the repo diffs and the bearer key are only
// ever sent to a host the operator explicitly names via LITELLM_BASE_URL. A
// hard-coded default would let a contributor ship repository content to a
// third-party endpoint they did not choose.

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function envKey() {
  return process.env.IMAGE_BLOAT_LLM_KEY ?? process.env.LITELLM_KEY_PI ?? null;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

export function buildPrompt({ dockerfileDiff, lockfileDiff, detectorReport }) {
  const detector = truncate(detectorReport, 12000);
  const dockerfile = truncate(dockerfileDiff || "(no Dockerfile diff supplied)", 8000);
  const lockfile = truncate(lockfileDiff || "(no lockfile diff supplied)", 8000);
  return [
    "You are reviewing a change to a Docker image build for bloat. ",
    "The image runs on Debian trixie (glibc) for linux x64/arm64, built natively per arch.",
    "",
    "Given the Dockerfile diff, lockfile diff, and a deterministic bloat-detector report, ",
    "predict which parts of this change are likely to add duplicated bytes to the image, and ",
    "suggest concrete fixes. Consider: the same package installed globally and as an app ",
    "dependency; platform variants (musl/darwin/win32) a glibc image never loads; dev ",
    "dependencies in the production stage; chmod/chown -R layers that copy whole trees; ",
    "@latest installs that defeat the layer cache; and one asset copied to more than one path.",
    "",
    "Answer in a compact list. Only flag things grounded in the provided diffs/report; if you ",
    "see nothing, say so.",
    "",
    "=== Dockerfile diff ===",
    dockerfile,
    "",
    "=== pnpm-lock.yaml diff ===",
    lockfile,
    "",
    "=== detector report (JSON) ===",
    detector,
  ].join("\n");
}

export async function analyzeWithLLM({ dockerfileDiff, lockfileDiff, detectorReport, fetchImpl = fetch } = {}) {
  const key = envKey();
  const baseUrl = (process.env.LITELLM_BASE_URL ?? "").replace(/\/+$/, "");
  if (!key) {
    return { skipped: true, note: "no LiteLLM key configured (IMAGE_BLOAT_LLM_KEY / LITELLM_KEY_PI); skipping advisory LLM pass" };
  }
  if (!baseUrl) {
    return { skipped: true, note: "no LiteLLM endpoint configured (LITELLM_BASE_URL); skipping advisory LLM pass — repo diffs are only sent to an explicitly named gateway" };
  }
  const model = process.env.IMAGE_BLOAT_LLM_MODEL ?? DEFAULT_MODEL;

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: buildPrompt({ dockerfileDiff, lockfileDiff, detectorReport }) }],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LiteLLM gateway returned HTTP ${response.status}: ${truncate(text, 400)}`);
  }
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("LiteLLM gateway returned no assistant content");
  }
  return { skipped: false, model, text };
}

async function main() {
  const reportPath = readArg("--detector-report");
  if (!reportPath) {
    throw new Error("Usage: node scripts/image-bloat-llm.mjs --detector-report <file> [--dockerfile-diff <file>] [--lockfile-diff <file>]");
  }
  const readOpt = (flag) => {
    const p = readArg(flag);
    return p ? readFileSync(p, "utf8") : null;
  };
  const result = await analyzeWithLLM({
    dockerfileDiff: readOpt("--dockerfile-diff"),
    lockfileDiff: readOpt("--lockfile-diff"),
    detectorReport: readFileSync(reportPath, "utf8"),
  });

  if (result.skipped) {
    console.log(`SKIP: ${result.note}`);
    return;
  }
  console.log(`# Image-bloat advisory (model: ${result.model})\n`);
  console.log(result.text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
