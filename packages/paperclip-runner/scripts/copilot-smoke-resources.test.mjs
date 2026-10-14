import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { withCopilotSmokeResources } from "./copilot-smoke-resources.mjs";

function resources(failure) {
  const actions = [];
  const fixture = new EventEmitter();
  fixture.listen = () => queueMicrotask(() => fixture.emit(failure === "listen" ? "error" : "listening", new Error("listen_failed")));
  fixture.closeAllConnections = () => actions.push("connections_closed");
  fixture.close = callback => { actions.push("server_closed"); callback(failure === "listen" ? Object.assign(new Error("not running"), { code: "ERR_SERVER_NOT_RUNNING" }) : undefined); };
  const installation = { openCommand: async () => ({ close: async () => { actions.push("lease_closed"); if (failure === "lease_close") throw new Error("close_failed"); } }) };
  const dependencies = {
    mkdtemp: async () => { if (failure === "workspace") throw new Error("workspace_failed"); actions.push("workspace_created"); return "/fixture/private"; },
    rm: async (root, options) => { assert.equal(root, "/fixture/private"); assert.deepEqual(options, { recursive: true, force: true }); actions.push("workspace_removed"); },
    createServer: () => { if (failure === "server_create") throw new Error("server_create_failed"); return fixture; },
  };
  return { actions, installation, dependencies };
}
for (const failure of ["workspace", "server_create", "listen"]) {
  test(`${failure} setup failure releases all already acquired resources before callback`, async () => {
    const r = resources(failure);
    await assert.rejects(withCopilotSmokeResources(r.installation, () => assert.fail("provider must not launch"), r.dependencies), new RegExp(`${failure}_failed`));
    assert.deepEqual(r.actions, failure === "workspace" ? ["lease_closed"]
      : failure === "server_create" ? ["workspace_created", "lease_closed", "workspace_removed"]
      : ["workspace_created", "connections_closed", "server_closed", "lease_closed", "workspace_removed"]);
  });
}
test("provider callback failure still closes server, lease, and workspace", async () => {
  const r = resources();
  await assert.rejects(withCopilotSmokeResources(r.installation, async () => { throw new Error("native_cleanup_failed"); }, r.dependencies), /native_cleanup_failed/);
  assert.deepEqual(r.actions, ["workspace_created", "connections_closed", "server_closed", "lease_closed", "workspace_removed"]);
});
test("lease close failure cannot bypass workspace removal", async () => {
  const r = resources("lease_close");
  await assert.rejects(withCopilotSmokeResources(r.installation, async () => "ok", r.dependencies), /close_failed/);
  assert.equal(r.actions.at(-1), "workspace_removed");
});
test("successful callback result is returned after all resource cleanup", async () => {
  const r = resources();
  assert.equal(await withCopilotSmokeResources(r.installation, async ({ root, fixtureRequests }) => { assert.equal(root, "/fixture/private"); assert.deepEqual(fixtureRequests, []); return "ok"; }, r.dependencies), "ok");
  assert.deepEqual(r.actions, ["workspace_created", "connections_closed", "server_closed", "lease_closed", "workspace_removed"]);
});
