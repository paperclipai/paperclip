import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { exerciseWorkspaceIsolation } from "./workspace-isolation-smoke.mjs";

if (process.env.PAPERMARKETING_TEST_ONLY !== "1" || process.env.COMPOSE_PROJECT_NAME !== "papermarketing-qualification") {
  throw new Error("This smoke test requires the disposable papermarketing-qualification stack.");
}
const composeArgs = ["compose", "--env-file", "docker/papermarketing/.env", "-f", "docker/papermarketing/compose.yaml"];
const compose = (...args) => execFileSync("docker", [...composeArgs, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const base = "http://localhost:3100";
async function health() {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, "ok");
  assert.equal(data.deploymentMode, "authenticated");
  return data;
}
await health();
assert.match(await (await fetch(base)).text(), /papermarketing/);
for (const route of ["/api/companies", "/api/instance/settings/experimental"]) {
  const response = await fetch(`${base}${route}`);
  assert.ok([401, 403].includes(response.status), `Anonymous request must be denied: ${route} (${response.status})`);
}
const id = compose("ps", "-q", "app").trim();
const inspect = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8" }))[0];
assert.equal(inspect.HostConfig.Privileged, false);
assert.ok(!inspect.Mounts.some(mount => mount.Source.endsWith("docker.sock")));
assert.equal(inspect.NetworkSettings.Ports["3100/tcp"][0].HostIp, "127.0.0.1");
assert.equal(inspect.Config.Env.find(value => value.startsWith("PAPERCLIP_BUILD_COMMIT=")), `PAPERCLIP_BUILD_COMMIT=${process.env.GITHUB_SHA}`);

const marker = randomUUID();
const verifyAfterRestart = await exerciseWorkspaceIsolation({ base, compose });
compose("exec", "-T", "--user", "node", "app", "node", "-e",
  "require('fs').writeFileSync('/paperclip/qualification-marker', process.argv[1])", marker);
compose("stop", "app");
compose("restart", "db");
compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "240");
const deadline = Date.now() + 120_000;
for (;;) {
  try { await health(); break; } catch (error) {
    if (Date.now() >= deadline) throw error;
    await setTimeout(1_000);
  }
}
assert.equal(compose("exec", "-T", "--user", "node", "app", "node", "-e",
  "process.stdout.write(require('fs').readFileSync('/paperclip/qualification-marker','utf8'))"), marker);
await verifyAfterRestart();
console.log("PASS: authenticated boot, UI, anonymous denial, loopback binding, image identity and volume persistence.");
