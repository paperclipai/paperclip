// Opt-in real Codex qualification; no model turn or live account data.
// Run from the repository root:
// node --import ./server/node_modules/tsx/dist/loader.mjs scripts/tests/native-cleanup-paginated-codex.mjs
// PAPERCLIP_TEST_CODEX_BINARY may select the exact installed Codex 0.153.4 binary.
// Fresh synthetic fixture directories are retained for inspection; never reuse live homes.
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  mkdir,
  writeFile,
  rename,
  cp,
  readFile,
  readlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { rebaseRetainedNativeCleanupProviderHome } from "../../server/src/services/native-runtime/native-session-executor.ts";

const codexBinary = process.env.PAPERCLIP_TEST_CODEX_BINARY ?? "codex";
if (
  execFileSync(codexBinary, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim() !== "codex-cli 0.153.4"
) {
  throw new Error(
    "This opt-in qualification requires Codex CLI 0.153.4. Requalify deliberately before changing the pin.",
  );
}
const home = await mkdtemp(join(tmpdir(), "paperclip-paginated-probe-"));
const methods = [];
async function withServer(home, callback) {
  const child = spawn(codexBinary, ["app-server"], {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      CODEX_HOME: home,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const finished = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
  child.stderr.on("data", () => {});
  const pending = new Map();
  let next = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.id != null && pending.has(frame.id)) {
      const { resolve, reject, timer } = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(timer);
      frame.error
        ? reject(new Error(JSON.stringify(frame.error)))
        : resolve(frame.result);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      methods.push(method);
      const id = ++next;
      const timer = setTimeout(
        () => reject(new Error("local_rpc_timeout")),
        10000,
      );
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    await rpc("initialize", {
      clientInfo: { name: "paperclip-fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return await callback(rpc);
  } finally {
    let killTimer;
    let deadline;
    try {
      child.stdin.end();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      const exit = await Promise.race([
        finished,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("fixture_child_exit_unproven")),
            5000,
          );
        }),
      ]);
      if (exit.error) throw exit.error;
    } finally {
      clearTimeout(killTimer);
      clearTimeout(deadline);
      for (const { timer } of pending.values()) clearTimeout(timer);
    }
  }
}
const result = await withServer(home, (rpc) =>
  rpc("thread/start", { cwd: home, model: "gpt-5.6-luna", ephemeral: false }),
);
const threadId = result.thread.id;
const canonicalHome = await realpath(home);
const rolloutRelative = relative(canonicalHome, result.thread.path);
if (
  !/^[a-f0-9-]{36}$/.test(threadId) ||
  isAbsolute(rolloutRelative) ||
  !rolloutRelative.startsWith("sessions/") ||
  rolloutRelative.split("/").includes("..") ||
  !rolloutRelative.endsWith(`-${threadId}.jsonl`)
) {
  throw new Error("Provider fixture path escaped the exact temporary home");
}
const timestamp = new Date().toISOString();
// Same minimal paginated fixture shape as the pinned provider's own
// app-server/tests/common/rollout.rs. No model call or turn/start is sent.
const lines =
  [
    {
      type: "session_meta",
      payload: {
        id: threadId,
        session_id: threadId,
        timestamp,
        cwd: home,
        originator: "codex",
        cli_version: "0.153.4",
        source: "cli",
        model_provider: "openai",
        selected_capability_roots: [],
        history_mode: "paginated",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Synthetic retained fixture. No action requested.",
          },
        ],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Synthetic retained fixture. No action requested.",
        kind: "plain",
      },
    },
  ]
    .map((v, ordinal) => JSON.stringify({ timestamp, ordinal, ...v }))
    .join("\n") + "\n";
await mkdir(dirname(result.thread.path), { recursive: true });
await writeFile(result.thread.path, lines, { flag: "wx" });
// Materialize the synthetic persisted thread through the real provider so
// SQLite, paginated history and rollout selection use the producer schema.
await withServer(canonicalHome, (rpc) =>
  rpc("thread/resume", {
    threadId,
    cwd: canonicalHome,
    model: "gpt-5.6-luna",
    excludeTurns: true,
  }),
);
const original = `${canonicalHome}-archive`;
await rename(canonicalHome, original);
const fingerprint = async (root) => {
  const files = [];
  async function visit(relative) {
    for (const entry of (
      await readdir(join(root, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(relative, entry.name);
      if (entry.isDirectory()) await visit(p);
      else if (entry.isFile())
        files.push([
          p,
          createHash("sha256")
            .update(await readFile(join(root, p)))
            .digest("hex"),
        ]);
      else if (entry.isSymbolicLink())
        files.push([p, "symlink", await readlink(join(root, p))]);
      else throw new Error("unsupported_synthetic_fixture_entry");
    }
  }
  await visit("");
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
};
const originalFingerprint = await fingerprint(original);
const copied = `${canonicalHome}-copy`;
await cp(original, copied, {
  recursive: true,
  filter: (source) => !["tmp", ".tmp"].includes(source.split("/").at(-1)),
});
const resume = (rpc) =>
  rpc("thread/resume", {
    threadId,
    cwd: copied,
    model: "gpt-5.6-luna",
    excludeTurns: true,
  });
let red;
try {
  await withServer(copied, resume);
} catch (error) {
  red = error.message;
}
if (!red?.includes(`no rollout found for thread id ${threadId}`)) {
  console.log(JSON.stringify({ red, canonicalHome, copied, threadId }));
  throw new Error("expected_exact_missing_paginated_path");
}
rebaseRetainedNativeCleanupProviderHome(
  copied,
  canonicalHome,
  threadId,
  "staging",
);
const green = await withServer(copied, resume);
if (green.thread.id !== threadId || green.thread.historyMode !== "paginated")
  throw new Error("wrong_resumed_identity");
rebaseRetainedNativeCleanupProviderHome(
  copied,
  canonicalHome,
  threadId,
  "canonical",
);
await rename(copied, canonicalHome);
const activated = await withServer(canonicalHome, (rpc) =>
  rpc("thread/resume", {
    threadId,
    cwd: canonicalHome,
    model: "gpt-5.6-luna",
    excludeTurns: true,
  }),
);
if (
  activated.thread.id !== threadId ||
  activated.thread.historyMode !== "paginated"
)
  throw new Error("wrong_activated_identity");
if (methods.some((method) => method === "turn/start"))
  throw new Error("unexpected_provider_turn");
if (originalFingerprint !== (await fingerprint(original)))
  throw new Error("original_fixture_changed");
console.log(
  JSON.stringify({
    red: "exact_paginated_path_missing",
    green: true,
    activatedResume: true,
    threadId,
    historyMode: green.thread.historyMode,
    methods,
    original,
    canonicalHome,
    originalFingerprint,
    originalSnapshotPreserved: true,
  }),
);
