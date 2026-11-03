import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHarnessProcessConformance } from "../dist/testing.js";

const identity = { harnessId: "example.fixture/native", packageName: "@example/plugin-native", version: "1.0.0",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, protocolVersion: 1, runtimeDigest: `sha256:${"a".repeat(64)}` };

async function fixture(body, action) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-harness-conformance-"));
  const entrypoint = join(root, "harness.mjs");
  try {
    await writeFile(entrypoint, `import { serveHarness } from ${JSON.stringify(new URL("../dist/host.js", import.meta.url).href)};
      const identity = ${JSON.stringify(identity)}; ${body}`);
    await action({ command: process.execPath, args: [entrypoint], cwd: root, identity, commands: [], timeoutMs: 3000 });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("public test kit exercises an independent process through real stdio and successful cleanup", async () => {
  await fixture(`await serveHarness({ identity, capabilities: { typedEvents: true, interruption: true },
    async execute(command, context) {
      await context.emit({ eventType: 'turn.started', priority: 'p0', payload: { commandId: command.commandId } });
      await context.emit({ eventType: 'turn.completed', priority: 'p0', payload: {} });
      return { admitted: true };
    }, snapshot() { return { nativeSessionId: 'native_fixture' }; }, close() { return {}; }
  });`, async input => {
    const report = await runHarnessProcessConformance({ ...input,
      commands: [{ schema: "paperclip.prp.command.v1", commandId: "fixture_command", controllerSeq: 1,
        type: "turn.start", issuedAt: "2026-11-03T00:00:00Z", payload: {} }],
      requiredEventTypes: ["turn.started", "turn.completed"],
    });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.identity, identity);
    assert.equal(report.snapshot.nativeSessionId, "native_fixture");
    assert.deepEqual(report.events.map(event => event.sequence), [1, 2]);
  });
});

test("test kit rejects release mismatch and never returns a successful report", async () => {
  await fixture(`await serveHarness({ identity: { ...identity, version: '2.0.0' }, capabilities: {},
    execute() { throw Error('must not execute'); }, close() { return {}; }
  });`, input => assert.rejects(runHarnessProcessConformance(input), /identity|exited/));
});

test("test kit bounds waiting for an event that the provider never emits", async () => {
  await fixture(`await serveHarness({ identity, capabilities: {}, execute() { return {}; },
    snapshot() { return {}; }, close() { return {}; }
  });`, input => assert.rejects(runHarnessProcessConformance({ ...input, timeoutMs: 200,
    requiredEventTypes: ["turn.completed"] }), /deadline exceeded/));
});
