import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../../workflows/docker-cloud.yml", import.meta.url), "utf8");
const step = workflow.split("      - name: Free runner disk")[1].split("      - name: Login to GitHub Container Registry")[0];
const script = step.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
const threshold = 64 * 1024 * 1024;

for (const { name, dockerFree, workspaceFree, dfStatus = "0", infoStatus = "0", cleanup } of [
  { name: "ample free space", dockerFree: threshold + 1, workspaceFree: threshold + 1, cleanup: false },
  { name: "exactly the headroom threshold", dockerFree: threshold, workspaceFree: threshold, cleanup: false },
  { name: "Docker filesystem below threshold", dockerFree: threshold - 1, workspaceFree: threshold + 1, cleanup: true },
  { name: "workspace filesystem below threshold", dockerFree: threshold + 1, workspaceFree: threshold - 1, cleanup: true },
  { name: "invalid Docker measurement", dockerFree: "unknown", workspaceFree: threshold + 1, cleanup: true },
  { name: "invalid workspace measurement", dockerFree: threshold + 1, workspaceFree: "unknown", cleanup: true },
  { name: "failed df command", dockerFree: threshold + 1, workspaceFree: threshold + 1, dfStatus: "1", cleanup: true },
  { name: "failed Docker inspection", dockerFree: threshold + 1, workspaceFree: threshold + 1, infoStatus: "1", cleanup: true },
]) {
  test(`cloud disk cleanup: ${name}`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cloud-disk-test-"));
    const log = path.join(dir, "commands.log");
    // Every mutating command is a recording fixture; no real SDKs, caches,
    // images, or directories are deleted when the workflow shell executes.
    const fixture = `#!/bin/bash
printf '%s %s\\n' "\${0##*/}" "$*" >> "$COMMAND_LOG"
case "\${0##*/}" in
  df)
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
    if [ "$1" = '-Pk' ]; then
      printf '/dev/docker 200000000 1 %s 1%% /docker\\n' "$DOCKER_FREE"
      printf '/dev/workspace 200000000 1 %s 1%% /workspace\\n' "$WORKSPACE_FREE"
      exit "$DF_STATUS"
    fi
    ;;
  docker)
    if [ "$1" = 'info' ]; then
      printf '/docker-data\\n'
      exit "$INFO_STATUS"
    fi
    ;;
esac
`;
    try {
      for (const command of ["df", "docker", "pnpm", "sudo"]) {
        writeFileSync(path.join(dir, command), fixture, { mode: 0o755 });
      }
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_WORKSPACE: "/workspace", COMMAND_LOG: log,
          DOCKER_FREE: String(dockerFree), WORKSPACE_FREE: String(workspaceFree), DF_STATUS: dfStatus, INFO_STATUS: infoStatus },
      });
      assert.equal(result.status, 0, result.stderr);
      const commands = readFileSync(log, "utf8");
      if (infoStatus === "0") assert.match(commands, /df -Pk \/docker-data \/workspace/);
      assert.equal(commands.includes("pnpm store prune"), cleanup);
      assert.equal(commands.includes("sudo rm -rf /usr/share/dotnet"), cleanup);
      assert.equal(commands.includes("docker system prune -af"), cleanup);
      assert.equal(result.stdout.includes("skipping cleanup"), !cleanup);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
