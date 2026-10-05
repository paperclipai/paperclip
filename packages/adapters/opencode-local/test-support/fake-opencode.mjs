#!/usr/bin/env node
// Deterministic fake `opencode` CLI for the opencode-local integration tests
// (src/server/execute.fakebin.test.ts). It emulates both OpenCode CLI lines so
// the adapter can be driven end to end with real child processes and no mocks.
//
// Environment contract:
//   FAKE_OPENCODE_MODE=v1|v2   selects the emulated CLI line (default v1).
//   FAKE_OPENCODE_ARGS_FILE    `run` invocations append one JSON object per
//                              line: {argv, stdinBytes, stdinPrefix,
//                              xdgConfigHome} — argv is the CLI args,
//                              stdinBytes/stdinPrefix record the prompt
//                              delivered on stdin (byte count and the first 64
//                              bytes) so tests can prove prompt delivery is
//                              stdin-based, not positional, and xdgConfigHome
//                              records the run's XDG_CONFIG_HOME so tests can
//                              assert skill injection targeted the config home
//                              the run actually sees.
//   FAKE_OPENCODE_REPLY        file whose contents are printed verbatim as the
//                              canned JSONL stdout of a successful `run`.
//
// Line-specific behaviour (shapes verified against the real CLIs):
//   --version   v1 (npm `opencode-ai`) prints `1.18.32`; v2 (npm
//               `@opencode/cli`) prints `opencode v2.0.18`.
//   run ...     v1 keeps the `--variant` flag; v2 folds the variant into the
//               model string (`provider/model#variant`) and REJECTS a stray
//               `--variant` outright: it prints the `run` DESCRIPTION/help text
//               and exits 2 with zero JSONL (PROBE-VERIFIED).
//   models      one `provider/model` id per line. v1 accepts `--refresh`; v2
//               rejects `--refresh` with an error on stderr and exit 1.
import { appendFileSync, readFileSync } from "node:fs";

const mode = process.env.FAKE_OPENCODE_MODE === "v2" ? "v2" : "v1";
const argsFile = process.env.FAKE_OPENCODE_ARGS_FILE ?? "";
const replyFile = process.env.FAKE_OPENCODE_REPLY ?? "";
const argv = process.argv.slice(2);

// The listing intentionally carries a `#variant`-suffixed id so callers must
// round-trip it byte-for-byte.
const MODEL_LISTING = ["opencode-go/mimo-v2.6-pro", "weird/model#variant", "openai/gpt-5"];

// PROBE-VERIFIED: `opencode run --variant ...` on the v2 CLI prints the `run`
// command's DESCRIPTION/help text and fails instead of accepting the flag.
const V2_RUN_HELP_TEXT = `DESCRIPTION
  Start an interactive session or run a one-off prompt

USAGE
  $ opencode run [message..]

FLAGS
  --format        Output format for the run (json)
  --model         Model to use in provider/model format
  --session       Session id to continue
  --standalone    Run without the shared server
  --auto          Automatically approve permission requests
`;

function writeStdout(text) {
  process.stdout.write(text);
}

function consumeStdin() {
  // The adapter pipes the prompt into stdin; drain it to EOF before replying so
  // the parent's write never races our exit. The bytes are returned so the run
  // capture can record how (and how much) prompt text arrived on stdin.
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const stdin = Buffer.concat(chunks);
      resolve({
        bytes: stdin.length,
        prefix: stdin.subarray(0, 64).toString("utf8"),
      });
    };
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    process.stdin.on("close", done);
    if (process.stdin.readableEnded || process.stdin.destroyed) done();
  });
}

function printVersion() {
  writeStdout(mode === "v2" ? "opencode v2.0.18\n" : "1.18.32\n");
  process.exitCode = 0;
}

function printModels() {
  const refresh = argv.includes("--refresh");
  if (mode === "v2" && refresh) {
    // v2 has no `models --refresh`; the v1 capability probe must degrade to a
    // plain listing instead of failing the request.
    process.stderr.write('Error: unknown option "--refresh"\n');
    process.exitCode = 1;
    return;
  }
  // v1 accepts `--refresh` (models.dev cache refresh) and prints the same
  // listing either way.
  writeStdout(`${MODEL_LISTING.join("\n")}\n`);
  process.exitCode = 0;
}

async function runPrompt() {
  // Drain stdin first: the capture records the prompt bytes delivered there,
  // so the record must follow EOF (and a v2 --variant rejection below still
  // records the invocation).
  const stdin = await consumeStdin();
  if (argsFile) {
    appendFileSync(
      argsFile,
      `${JSON.stringify({
        argv,
        stdinBytes: stdin.bytes,
        stdinPrefix: stdin.prefix,
        xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
      })}\n`,
    );
  }
  if (mode === "v2" && argv.includes("--variant")) {
    writeStdout(V2_RUN_HELP_TEXT);
    process.exitCode = 2;
    return;
  }
  if (!replyFile) {
    process.stderr.write("fake-opencode: FAKE_OPENCODE_REPLY is not set\n");
    process.exitCode = 1;
    return;
  }
  const reply = readFileSync(replyFile, "utf8");
  writeStdout(reply.endsWith("\n") ? reply : `${reply}\n`);
  process.exitCode = 0;
}

const subcommand = argv.find((token) => token === "run" || token === "models");
if (argv.includes("--version")) {
  printVersion();
} else if (subcommand === "models") {
  printModels();
} else if (subcommand === "run") {
  await runPrompt();
} else {
  process.stderr.write(`fake-opencode: unrecognized invocation: ${JSON.stringify(argv)}\n`);
  process.exitCode = 1;
}
