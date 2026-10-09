import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { COPILOT_MESSAGE_MAPPING_REPLACEMENT, COPILOT_REPLAY_MAPPING_REPLACEMENT, patchPinnedCopilotMessageIdentity, readCopilotInnerTar, readPinnedCopilotInnerDistribution } from "./copilot-inner-distribution.mjs";

function file(name, content = "data", { type = "0", mode = 0o644, prefix = "" } = {}) {
  const bytes = Buffer.from(content); const h = Buffer.alloc(512);
  h.write(name, 0, 100, "ascii"); h.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  h.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  h.fill(32, 148, 156); h.write(type, 156); h.write("ustar\0", 257); h.write("00", 263); h.write(prefix, 345, 155);
  h.write(h.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
const tar = (...files) => Buffer.concat([...files, Buffer.alloc(1024)]);

test("inner reader preserves every regular asset and ustar prefix without executing it", () => {
  const entries = readCopilotInnerTar(tar(file("package/index.js", "throw new Error('never execute')", { mode: 0o755 }), file("asset", "", { prefix: "package/assets" })));
  assert.equal(entries.size, 2);
  assert.equal(entries.get("index.js").executable, true);
  assert.equal(entries.get("assets/asset").bytes.length, 0);
});

test("inner reader rejects traversal, links, duplicate entries, writable files and file parents", () => {
  for (const files of [[file("package/../escape")], [file("/package/index.js")], [file("package/a\\b")],
    [file("package/link", "", { type: "2" })], [file("package/hardlink", "", { type: "1" })],
    [file("package/a", "", { mode: 0o777 })], [file("package/a"), file("package/a")],
    [file("package/a"), file("package/a/b")], [file("package/meta", "", { type: "x" })]]) {
    assert.throws(() => readCopilotInnerTar(tar(...files)));
  }
});

test("inner reader rejects corrupt checksums, truncated framing and hidden padding/trailer", () => {
  const valid = tar(file("package/a"));
  const checksum = Buffer.from(valid); checksum[0] ^= 1;
  const padding = Buffer.from(valid); padding[517] = 1;
  const trailer = Buffer.from(valid); trailer[trailer.length - 1] = 1;
  for (const bytes of [checksum, padding, trailer, valid.subarray(0, -512), valid.subarray(0, -1)]) assert.throws(() => readCopilotInnerTar(bytes));
});

test("pinned archive and source refuse unknown upstream bytes before patching", () => {
  assert.throws(() => patchPinnedCopilotMessageIdentity(Buffer.from(COPILOT_MESSAGE_MAPPING_REPLACEMENT)), /source digest/);
  assert.throws(() => readPinnedCopilotInnerDistribution(Buffer.alloc(1), "darwin-arm64"), /framing/);
  assert.throws(() => readPinnedCopilotInnerDistribution(Buffer.alloc(1), "linux-arm64"), /target/);
});

test("ordered mapping retains native IDs including an empty start and never echoes completion text", () => {
  const map = runInNewContext(`e=>{switch(e.type){${COPILOT_MESSAGE_MAPPING_REPLACEMENT}default:return null}}`);
  const events = [
    { type: "assistant.message_start", data: { messageId: "first" } },
    { type: "assistant.message_delta", data: { messageId: "first", deltaContent: "same" } },
    { type: "assistant.message", data: { messageId: "first", content: "same" } },
    { type: "tool.execution_complete", data: {} },
    { type: "assistant.message_start", data: { messageId: "second" } },
    { type: "assistant.message_delta", data: { messageId: "second", deltaContent: "sa" } },
    { type: "assistant.message_delta", data: { messageId: "second", deltaContent: "me" } },
    { type: "assistant.message", data: { messageId: "second", content: "same" } },
    { type: "assistant.message_start", data: { messageId: "empty-final" } },
    { type: "assistant.message", data: { messageId: "empty-final", content: "" } },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(events.map(map).filter(Boolean))).map(e => [e.messageId, e.content.text]),
    [["first", ""], ["first", "same"], ["second", ""], ["second", "sa"], ["second", "me"], ["empty-final", ""]]);
});

test("the patched replay branch emits full messages once, with ordered identities and empty finals", () => {
  const live = runInNewContext(`e=>{switch(e.type){${COPILOT_MESSAGE_MAPPING_REPLACEMENT}default:return null}}`);
  const replay = runInNewContext(`t=>{switch(t.type){${COPILOT_REPLAY_MAPPING_REPLACEMENT}default:return null}}`);
  const history = [
    { type: "assistant.message", data: { messageId: "old-first", content: "same" } },
    { type: "assistant.message", data: { messageId: "old-second", content: "same" } },
    { type: "assistant.message", data: { messageId: "old-empty", content: "" } },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(history.map(replay))).map(e => [e.messageId, e.content.text]),
    [["old-first", "same"], ["old-second", "same"], ["old-empty", ""]]);
  assert.deepEqual(history.map(live), [null, null, null]);
  // Completion has opposite roles: historical content is replayed once, while
  // the active mapper must not echo text already emitted as live deltas.
  const final = history[0];
  assert.equal(replay(final).content.text, "same");
  assert.equal(live(final), null);
});
