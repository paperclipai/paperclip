import assert from "node:assert/strict";
import test from "node:test";
import { canaryStartup } from "./canary-startup-fixture.mjs";

test("actual Playwright teardown stops the CLI and descendants that ignore SIGTERM", async () => {
  const result = await canaryStartup({ mode: "success", onboard: "serve", playwright: true });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.calls.filter(call => call.kind === "onboard").length, 1);
  const processes = result.calls.filter(call => ["onboard", "descendant"].includes(call.kind));
  assert.equal(processes.length, 2);
  for (const call of processes) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(call.pid, 0); } catch (error) { if (error.code === "ESRCH") break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(call.pid, 0), {code:"ESRCH"}, `fixture ${call.kind} outlived bounded teardown`);
  }
});

test("actual Playwright startup timeout cancels a detached npm install", async () => {
  const result = await canaryStartup({ mode: "hang", playwright: true });
  assert.equal(result.code, 1);
  const installs = result.calls.filter(call => call.kind === "npm");
  assert.equal(installs.length, 1, result.output);
  assert.equal(result.calls.filter(call => call.kind === "onboard").length, 0);
  assert.throws(() => process.kill(installs[0].pid,0), {code:"ESRCH"});
  assert.ok(result.elapsed < 10000, `startup timeout did not stop npm: ${result.elapsed}ms`);
});
