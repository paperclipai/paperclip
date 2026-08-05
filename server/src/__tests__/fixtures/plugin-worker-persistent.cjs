// Long-lived worker fixture for the stdin command-channel supervision tests.
//
// Unlike the other fixtures, this worker deliberately survives losing its
// stdin: readline "close" does not terminate it, and a ref'd keep-alive timer
// holds the event loop open. That reproduces the field shape the supervision
// fix exists for — the host->worker command pipe dies while the worker process
// itself stays alive and uncommandable.
//
// `shutdown` is acknowledged immediately but the exit is deliberately deferred,
// which leaves a window in which a test can kill the command channel *during*
// an intentional stop (the negative control).

const readline = require("node:readline");

/** How long the worker waits after acking `shutdown` before exiting. */
const SHUTDOWN_EXIT_DELAY_MS = 300;

/** Hard ceiling so a fixture never outlives the test run that spawned it. */
const MAX_LIFETIME_MS = 30_000;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Ref'd, so the process stays alive after stdin reaches EOF.
const keepAlive = setInterval(() => {}, 1_000);

const selfDestruct = setTimeout(() => {
  process.exit(0);
}, MAX_LIFETIME_MS);

function exitNow() {
  clearInterval(keepAlive);
  clearTimeout(selfDestruct);
  process.exit(0);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

// Explicitly do NOT exit here: losing the command channel must leave this
// process alive so the host supervision path is the thing under test.
rl.on("close", () => {});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: [],
      },
    });
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    setTimeout(exitNow, SHUTDOWN_EXIT_DELAY_MS);
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Unhandled method: ${method}`,
    },
  });
});
