import { createHash } from "node:crypto";
import { mkdtemp, open, rm, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { inspectStoppedCodexRollout } from "./stopped-codex-rollout.js";

const binding = { threadId: "thread", turnId: "turn", cwd: "/workspace" };
const row = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
const meta = row("session_meta", { id: "thread", cwd: "/workspace" });
const start = row("event_msg", { type: "task_started", turn_id: "turn" });
const context = row("turn_context", { turn_id: "turn", cwd: "/workspace" });
const stop = row("event_msg", { type: "turn_aborted", turn_id: "turn", reason: "interrupted" });

it("inventories a transcript beyond the old 32 MiB limit with an exact raw-byte digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "stopped-rollout-")), path = join(root, "rollout.jsonl");
  try {
    const file = await open(path, "wx", 0o600), hash = createHash("sha256");
    const block = row("response_item", { type: "message", text: "x".repeat(1024) }).repeat(32);
    try {
      await file.writeFile(meta); hash.update(meta);
      // Old transcript bytes do not become current replay authority.
      for (let index = 0; index < 1100; index++) { await file.writeFile(block); hash.update(block); }
      const tail = start + context + block + stop; await file.writeFile(tail); hash.update(tail);
    } finally { await file.close(); }
    const expected = hash.digest("hex");
    expect(await inspectStoppedCodexRollout(path, binding)).toEqual({ safe: true, sha256: expected });
    expect((await inspectStoppedCodexRollout(path)).sha256).toBe(expected);
    await appendFile(path, row("response_item", { type: "function_call" }));
    expect((await inspectStoppedCodexRollout(path, binding)).safe).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("refuses partial tails and unknown current actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stopped-rollout-invalid-")), path = join(root, "rollout.jsonl");
  try {
    await writeFile(path, meta + start + context + stop.trimEnd());
    expect((await inspectStoppedCodexRollout(path, binding)).safe).toBe(false);
    await writeFile(path, meta + start + context + row("response_item", { type: "function_call" }) + stop);
    expect((await inspectStoppedCodexRollout(path, binding)).safe).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
