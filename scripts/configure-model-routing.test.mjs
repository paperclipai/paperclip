import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scripts = [
  "scripts/configure-cloud-reviewer-default.sh",
  "scripts/configure-high-volume-gpt-routing.sh",
];

test("explicit agent ids cannot bypass company scoping", () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-model-routing-"));
  const fakeBinDir = path.join(fixtureDir, "bin");
  const curlPath = path.join(fakeBinDir, "curl");
  const callsPath = path.join(fixtureDir, "curl-calls.log");

  try {
    mkdirSync(fakeBinDir);
    writeFileSync(curlPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsPath}"
printf '%s\\n' '{"id":"agent-other","companyId":"other-company","name":"Cloud Reviewer (GPT)","adapterType":"codex_local","adapterConfig":{"model":"gpt-5.6-luna"}}'
`);
    chmodSync(curlPath, 0o755);

    for (const script of scripts) {
      let output = "";
      let status = 0;
      try {
        output = execFileSync(
          "bash",
          [path.join(repoRoot, script), "--apply", "--agent-id", "agent-other"],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              PATH: `${fakeBinDir}:${process.env.PATH}`,
              PAPERCLIP_API_URL: "http://paperclip.test",
              PAPERCLIP_API_KEY: "test-key",
              PAPERCLIP_COMPANY_ID: "expected-company",
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        status = error.status;
        output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      }

      if (status !== 1 || !output.includes("expected 'expected-company'")) {
        throw new Error(`${script} did not reject the cross-company target: ${output}`);
      }
    }

    const calls = readFileSync(callsPath, "utf8");
    if (calls.includes("-X PATCH")) {
      throw new Error("cross-company guard allowed a PATCH request");
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("Cloud Reviewer apply repoints the agent default to Claude", () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-model-routing-"));
  const fakeBinDir = path.join(fixtureDir, "bin");
  const curlPath = path.join(fakeBinDir, "curl");
  const callsPath = path.join(fixtureDir, "curl-calls.log");

  try {
    mkdirSync(fakeBinDir);
    writeFileSync(curlPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsPath}"
if [[ " $* " == *" -X PATCH "* ]]; then
  printf '%s\\n' '{"id":"reviewer-1","companyId":"expected-company","name":"Cloud Reviewer (Claude)","adapterType":"claude_local","adapterConfig":{"model":"claude-opus-4-8"}}'
else
  printf '%s\\n' '{"id":"reviewer-1","companyId":"expected-company","name":"Cloud Reviewer (GPT)","adapterType":"codex_local","adapterConfig":{"model":"gpt-5.6-luna"}}'
fi
`);
    chmodSync(curlPath, 0o755);

    const output = execFileSync(
      "bash",
      [path.join(repoRoot, "scripts/configure-cloud-reviewer-default.sh"), "--apply", "--agent-id", "reviewer-1"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH}`,
          PAPERCLIP_API_URL: "http://paperclip.test",
          PAPERCLIP_API_KEY: "test-key",
          PAPERCLIP_COMPANY_ID: "expected-company",
          PAPERCLIP_RUN_ID: "sample-run",
        },
        encoding: "utf8",
      },
    );

    const calls = readFileSync(callsPath, "utf8");
    if (!calls.includes("-X PATCH")) {
      throw new Error("Cloud Reviewer helper did not send the guarded PATCH request");
    }
    if (!calls.includes('{"adapterType":"claude_local","adapterConfig":{"model":"claude-opus-4-8"}}')) {
      throw new Error(`Cloud Reviewer helper sent the wrong default: ${calls}`);
    }
    if (!output.includes("Applied and verified: claude_local / claude-opus-4-8")) {
      throw new Error(`Cloud Reviewer helper did not verify the Claude default: ${output}`);
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
