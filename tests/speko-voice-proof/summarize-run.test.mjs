import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("shared reports exclude private content and never promote transport to playback proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "speko-redaction-"));
  try {
    const input = join(dir, "private.json");
    const output = join(dir, "public.json");
    await writeFile(input, JSON.stringify({
      sessionId: "11111111-1111-4111-8111-111111111111", mode: "text", provider: "openai:gpt-4.1",
      failure: null, audioFrames: 42, transportToken: "never-publish-token",
      syntheticTranscript: [{ text: "never-publish-transcript" }],
      sourceDigests: { "proof.mjs": "a".repeat(64), accidentalKey: "never-publish-key" },
      proof: { acceptedRequests: 2, resultReturned: true, expectedSyntheticResult: "never-publish-phrase" },
      events: [
        { kind: "request_accepted", elapsedMs: 10, requestCount: 1, text: "never-publish-caller" },
        { kind: "script_failed", elapsedMs: 20, reason: "never-publish-error-detail" },
        { kind: "unknown_future_event", elapsedMs: 30, text: "never-publish-future" },
      ],
    }));
    const script = new URL("./summarize-run.mjs", import.meta.url);
    const run = () => spawnSync(process.execPath, [script.pathname, input, output], { encoding: "utf8" });
    assert.equal(run().status, 0);
    const text = await readFile(output, "utf8");
    assert.equal(text.includes("never-publish"), false);
    const report = JSON.parse(text);
    assert.equal(report.status, "requires_audio_review");
    assert.equal(report.confirmedResultPlayback, false);
    assert.equal(report.resultReturned, true);
    assert.equal(report.events.length, 2);
    assert.deepEqual(report.sourceDigests, { "proof.mjs": "a".repeat(64) });
    assert.notEqual(run().status, 0, "must refuse to overwrite evidence");
    assert.equal(await readFile(output, "utf8"), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
