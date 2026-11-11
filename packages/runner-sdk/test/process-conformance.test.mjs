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
  await fixture(`await serveHarness({ identity, capabilities: { typedEvents: true, interruption: true, resume: true },
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


function rawLifecycleProvider(eventPosition) {
  return `const { createInterface } = await import('node:readline');
    const lines = createInterface({ input: process.stdin });
    const fact = { schema: 'paperclip.harness.v1', sequence: 1, eventType: 'turn.started', priority: 'p0', payload: {} };
    const encode = value => JSON.stringify(value) + '\\n';
    for await (const line of lines) {
      const request = JSON.parse(line);
      const response = { schema: 'paperclip.harness.v1', id: request.id, ok: true,
        result: request.method === 'initialize' ? { identity, capabilities: {} } : {} };
      if (request.method === 'initialize') process.stdout.write(
        ${JSON.stringify(eventPosition)} === 'before_initialize' ? encode(fact) + encode(response)
          : encode(response) + (${JSON.stringify(eventPosition)} === 'after_initialize' ? encode(fact) : ''));
      else if (request.method === 'close') {
        process.stdout.write(encode(response) + (${JSON.stringify(eventPosition)} === 'after_close' ? encode(fact) : ''));
        break;
      } else process.stdout.write(encode(response));
    }
    process.stdin.destroy();`;
}

test("test kit rejects events before the initialize success response", async () => {
  await fixture(rawLifecycleProvider("before_initialize"), input =>
    assert.rejects(runHarnessProcessConformance(input), /initializ|admission/));
});

test("test kit rejects events after the close response", async () => {
  await fixture(rawLifecycleProvider("after_close"), input =>
    assert.rejects(runHarnessProcessConformance(input), /close|admission/));
});

test("test kit admits events immediately following initialize success in the same chunk", async () => {
  await fixture(rawLifecycleProvider("after_initialize"), async input => {
    const report = await runHarnessProcessConformance({ ...input, requiredEventTypes: ["turn.started"] });
    assert.equal(report.events.length, 1);
  });
});


for (const resume of [undefined, false]) {
  test(`one-shot harness conformance does not require snapshots (resume=${resume})`, async () => {
    await fixture(`await serveHarness({ identity, capabilities: ${JSON.stringify(resume === undefined ? {} : { resume })},
      execute() { return {}; }, close() { return {}; } });`, async input => {
      const report = await runHarnessProcessConformance(input);
      assert.equal(Object.hasOwn(report, "snapshot"), false);
    });
  });
}

test("resumable conformance requires the advertised snapshot handler", async () => {
  await fixture(`await serveHarness({ identity, capabilities: { resume: true }, execute() { return {}; }, close() { return {}; } });`, input =>
    assert.rejects(runHarnessProcessConformance({ ...input, requireSnapshot: false }), /snapshot/));
});

test("caller can require snapshot conformance independently of resume capability", async () => {
  await fixture(`await serveHarness({ identity, capabilities: {}, execute() { return {}; },
    snapshot() { return { nativeSessionId: 'one_shot' }; }, close() { return {}; } });`, async input => {
      const report = await runHarnessProcessConformance({ ...input, requireSnapshot: true });
      assert.equal(report.snapshot.nativeSessionId, "one_shot");
    });
});
