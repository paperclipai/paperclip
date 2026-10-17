import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const helperPath = path.join(repoRoot, "skills/paperclip/scripts/heartbeat-inbox.sh");

function makeFakeCurl(mode: "all-fail" | "empty-success") {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-inbox-test-"));
  const binDir = path.join(root, "bin");
  const scratchDir = path.join(root, "run-scratch");
  const curlLog = path.join(root, "curl.log");
  const curlPath = path.join(binDir, "curl");
  mkdirSync(binDir);
  writeFileSync(curlLog, "");
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -u
output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w) shift 2 ;;
    -H|-X) shift 2 ;;
    http://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s %s\\n' "$url" "$output" >> "$CURL_LOG"
if [[ "$HEARTBEAT_CURL_MODE" == "all-fail" ]]; then
  exit 7
fi
printf '{"items":[]}\\n' > "$output"
printf '200'
`,
  );
  chmodSync(curlPath, 0o755);
  return { root, binDir, scratchDir, curlLog };
}

function runHelper(
  mode: "all-fail" | "empty-success",
  options: { apiUrl?: string } = {},
) {
  const fixture = makeFakeCurl(mode);
  try {
    const env = {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      CURL_LOG: fixture.curlLog,
      HEARTBEAT_CURL_MODE: mode,
      PAPERCLIP_API_URL: options.apiUrl ?? "http://paperclip.invalid",
      PAPERCLIP_RUN_SCRATCH_DIR: fixture.scratchDir,
      PAPERCLIP_HEARTBEAT_RETRY_DELAY_SECONDS: "0",
    };
    try {
      const stdout = execFileSync("bash", [helperPath], { env, encoding: "utf8" });
      return { status: 0, stdout, stderr: "", calls: readFileSync(fixture.curlLog, "utf8") };
    } catch (error) {
      const result = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return {
        status: result.status ?? 1,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        calls: readFileSync(fixture.curlLog, "utf8"),
      };
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

describe("paperclip heartbeat inbox helper", () => {
  it("surfaces an API outage after attempting the loopback fallback", () => {
    const result = runHelper("all-fail");

    expect(result.status).not.toBe(0);
    expect(result.calls).toContain("http://paperclip.invalid");
    expect(result.calls).toContain("http://127.0.0.1:3100");
    expect(result.stderr).toContain("trying loopback fallback");
    expect(result.stderr).toContain("ERROR: Paperclip API unreachable");
    expect(result.stderr).not.toContain("no new assignments");
    expect(result.calls).not.toContain("/tmp/pc_inbox.json");
  });

  it("allows a genuine 200 empty inbox to exit cleanly", () => {
    const result = runHelper("empty-success");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('{"items":[]}');
    expect(result.calls).toContain("http://paperclip.invalid");
    expect(result.calls).not.toContain("127.0.0.1");
    expect(result.stderr).not.toContain("ERROR: Paperclip API unreachable");
    expect(result.stderr).not.toContain("trying loopback fallback");
  });
});
