import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const baseEnv = Object.fromEntries(
  ["PATH", "HOME", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const compose = spawnSync("docker", ["compose", "version"], { env: baseEnv });
assert.equal(compose.status, 0, "Docker Compose is required for this integration check.");

for (const [file, service] of [
  ["docker/docker-compose.quickstart.yml", "paperclip"],
  ["docker/docker-compose.yml", "server"],
]) {
  test(`${file} forwards the independent tool signing secret`, () => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), "paperclip-compose-secrets-"));
    const envFile = path.join(temporary, "empty.env");
    writeFileSync(envFile, "");
    try {
      for (const signingSecret of ["test-tool-signing-secret", undefined]) {
        const env = { ...baseEnv, BETTER_AUTH_SECRET: "test-session-secret" };
        if (signingSecret !== undefined) env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = signingSecret;
        const result = spawnSync("docker", [
          "compose", "--env-file", envFile, "-f", file, "config", "--format", "json",
        ], { cwd: repoRoot, env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const containerEnv = JSON.parse(result.stdout).services[service].environment;
        assert.equal(containerEnv.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET, signingSecret ?? "");
        assert.equal(containerEnv.BETTER_AUTH_SECRET, "test-session-secret");
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
