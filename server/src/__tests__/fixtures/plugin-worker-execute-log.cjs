// Test worker fixture for the `execute.log` worker→host notification route.
//
// On `environmentExecute` the fixture emits the `execute.log` notifications
// listed in `params.logs`, then returns the final result. Each log entry sets
// the envelope invocation id by its `tag`:
//   - "echo"    → the real host-issued id (the normal streaming path)
//   - "unknown" → a forged id with no active route (must be dropped)
//   - "none"    → no id at all (must be dropped)
// The default tag is "echo". The entry `stream` and `chunk` pass through
// verbatim, so a test can send an invalid stream name or an empty chunk to
// prove the host drops invalid input.
const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true, supportedMethods: ["environmentExecute"] },
    });
    return;
  }

  if (method === "environmentExecute") {
    const invocationId = message.paperclipInvocation && message.paperclipInvocation.id;
    const params = message.params ?? {};
    const logs = Array.isArray(params.logs) ? params.logs : [];
    for (const entry of logs) {
      const note = {
        jsonrpc: "2.0",
        method: "execute.log",
        params: { stream: entry.stream, chunk: entry.chunk },
      };
      const tag = entry.tag ?? "echo";
      if (tag === "echo") {
        note.paperclipInvocationId = invocationId;
      } else if (tag === "unknown") {
        note.paperclipInvocationId = "unknown-invocation";
      }
      // tag === "none" → omit the invocation id entirely.
      send(note);
    }

    const finish = () => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: params.finalStdout ?? "",
          stderr: params.finalStderr ?? "",
        },
      });
    };
    const delayMs = Number(params.delayMs ?? 0);
    if (delayMs > 0) {
      setTimeout(finish, delayMs);
    } else {
      finish();
    }
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unhandled method: ${method}` },
  });
});
