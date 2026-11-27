import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectLocalPiProfile } from "./probe-local-pi-profile.mjs";

test("probes the owned and selected extensions through Pi RPC with the requested profile", async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-probe-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const profile = join(root, "pi-profile");
  const workspace = join(root, "workspace");
  const entrypoint = join(root, "fake-pi.mjs");
  const extension = join(root, "approved.mjs");
  await Promise.all([mkdir(profile), mkdir(workspace), writeFile(extension, "")]);
  await writeFile(entrypoint, `
    import assert from "node:assert/strict";
    import { createInterface } from "node:readline";
    assert.equal(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(profile)});
    assert.equal(process.cwd(), ${JSON.stringify(workspace)});
    assert(process.argv.includes("--no-extensions"));
    assert(process.argv.includes("--no-session"));
    assert.equal(process.argv.filter(arg => arg === "-e").length, 2);
    assert(process.argv.includes(${JSON.stringify(extension)}));
    for await (const line of createInterface({ input: process.stdin })) {
      const { id, type } = JSON.parse(line);
      if (type === "get_commands") {
        console.log(JSON.stringify({ id, type: "response", success: true, data: { commands: [
          { name: "paperclip-runtime-ready-v1", description: "Paperclip runtime gate v1" },
          { name: "approved-command" },
        ] } }));
      } else {
        assert.equal(type, "get_state");
        console.log(JSON.stringify({ id, type: "response", success: true, data: {
          model: { provider: "fixture", id: "qualified" },
        } }));
      }
    }
  `);
  const args = ["--entrypoint", entrypoint, "--profile", profile, "--workspace", workspace, "--extension", extension];
  assert.match(await inspectLocalPiProfile([...args, "--expect-command", "approved-command", "--model", "fixture/qualified"]), /passed/);
  await assert.rejects(inspectLocalPiProfile([...args, "--expect-command", "missing"]), /expected extension command: missing/);
  await assert.rejects(inspectLocalPiProfile([...args, "--model", "fixture/other"]), /did not select/);
  await assert.rejects(inspectLocalPiProfile([...args, "--extension", "relative.js"]), /requires an absolute path/);
});
