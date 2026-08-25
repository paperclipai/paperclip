// Test worker fixture for the host-owned setup-token login pseudo-terminal route
// gate. The fixture drives the manager route state machine through
// the four typed methods (open, input, stop, close) and the output and exit
// notifications.
//
// The manager allowlists `command` to the fixed `CLAUDE_SETUP_TOKEN_COMMAND`. The
// test encodes a JSON directive in the forwarded `providerLeaseId`, so one fixture
// serves every route-gate case:
//   - `mode`: "normal" | "malformed-open" | "no-open-reply" | "duplicate-open-reply" |
//     "exit-before-open-reply"
//   - `workerSessionId`: the worker session id the open reply returns (default "ws-1")
//   - `outputs`: an array of `{ chunk, sid? }`. The fixture emits each as an output
//     notification after the open reply. `sid` defaults to the real worker session
//     id; a test sets a wrong `sid` to prove the host drops a mismatched
//     notification.
//   - `exitCode`: when set, the fixture emits an exit notification after the outputs.
//   - `closeMode`: "ack" | "bad-ack" | "no-ack" (default "ack"). It controls the
//     close reply, so a test proves the host retires the worker on an unconfirmed
//     close.
//   - `batchWithOpenReply`: when true, the fixture writes the open reply and the
//     scripted outputs and exit in one stdout write. The host then reads the open
//     reply and the notifications in one batch, so a test proves the host queues
//     and replays a record that arrives before the route binds.
//   - `mode: "exit-before-open-reply"`: the fixture emits the scripted outputs,
//     then exits with no open reply, so a test proves the host clears the
//     pre-bind queue on a worker exit during the open window.
const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Serialize the scripted output and exit notifications as newline-delimited
// lines. The batch mode writes these together with the open reply in one
// stdout write. A test sets a wrong `sid` on one entry to force a mismatch.
function scriptedOutputLines(directive, workerSessionId) {
  const outputs = Array.isArray(directive.outputs) ? directive.outputs : [];
  let lines = "";
  for (const entry of outputs) {
    lines += `${JSON.stringify({
      jsonrpc: "2.0",
      method: "loginPty.output",
      params: {
        workerSessionId: entry.sid ?? workerSessionId,
        chunk: entry.chunk,
      },
    })}\n`;
  }
  if (typeof directive.exitCode === "number") {
    lines += `${JSON.stringify({
      jsonrpc: "2.0",
      method: "loginPty.exit",
      params: { workerSessionId, exitCode: directive.exitCode },
    })}\n`;
  }
  return lines;
}

// The registered terminals, keyed by the host route id. Each entry records the
// bound worker session id and the close directive.
const routes = new Map();

function parseDirective(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;
  const params = message.params ?? {};

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: [
          "loginPtyOpen",
          "loginPtyInput",
          "loginPtyStop",
          "loginPtyClose",
        ],
      },
    });
    return;
  }

  if (method === "loginPtyOpen") {
    const directive = parseDirective(params.providerLeaseId);
    const mode = directive.mode ?? "normal";
    const workerSessionId = directive.workerSessionId ?? "ws-1";
    const closeMode = directive.closeMode ?? "ack";
    routes.set(params.hostRouteId, { workerSessionId, closeMode });

    if (mode === "no-open-reply") {
      // Never reply, so the host open call times out.
      return;
    }
    if (mode === "exit-before-open-reply") {
      // Emit the scripted pre-bind outputs, then exit with no open reply. The
      // route never binds, so a test proves the worker-exit path clears the
      // pre-bind queue.
      process.stdout.write(scriptedOutputLines(directive, workerSessionId));
      process.exit(1);
      return;
    }

    // A malformed reply carries no worker session id, so the host cannot bind
    // and terminalizes the route.
    const isMalformedOpen = mode === "malformed-open";
    const openReplyLine = `${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: isMalformedOpen ? {} : { workerSessionId },
    })}\n`;

    if (directive.batchWithOpenReply === true) {
      // Write the open reply and the scripted outputs and exit in one stdout
      // write. The host reads them in one batch, so an output or an exit
      // notification arrives before the route binds — even a malformed reply
      // that never binds. The host must queue and, on a bind, replay it; on a
      // malformed reply, it must clear the queue instead.
      process.stdout.write(openReplyLine + scriptedOutputLines(directive, workerSessionId));
      return;
    }

    process.stdout.write(openReplyLine);
    if (mode === "duplicate-open-reply") {
      // Send a second open reply for the same request id. The host drops it.
      process.stdout.write(openReplyLine);
    }
    if (isMalformedOpen) {
      // No scripted output follows a non-batched malformed reply.
      return;
    }

    // Emit the scripted output and the exit after the open reply, so the host
    // binds the route first.
    setImmediate(() => {
      process.stdout.write(scriptedOutputLines(directive, workerSessionId));
    });
    return;
  }

  if (method === "loginPtyInput") {
    // Echo the input back as one output notification for the bound session, so a
    // test proves the input reaches the worker and the output routes back.
    for (const entry of routes.values()) {
      if (entry.workerSessionId === params.workerSessionId) {
        send({
          jsonrpc: "2.0",
          method: "loginPty.output",
          params: { workerSessionId: entry.workerSessionId, chunk: `echo:${params.data}` },
        });
      }
    }
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (method === "loginPtyStop") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (method === "loginPtyClose") {
    const entry = routes.get(params.hostRouteId);
    routes.delete(params.hostRouteId);
    const closeMode = entry ? entry.closeMode : "ack";
    if (closeMode === "no-ack") {
      // Never reply, so the host close call times out and the host retires us.
      return;
    }
    if (closeMode === "bad-ack") {
      send({ jsonrpc: "2.0", id: message.id, result: { hostRouteId: "mismatched-route" } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { hostRouteId: params.hostRouteId } });
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
