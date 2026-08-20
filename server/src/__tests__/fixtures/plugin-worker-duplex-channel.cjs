// Test worker fixture for the host-owned duplex channel route state machine. The
// fixture drives the manager route state machine through the four typed methods
// (open, write, stop, close) and the data and exit notifications.
//
// The duplex channel is generic. It carries no command allowlist. The test
// encodes a JSON directive in the forwarded `providerLeaseId`, so one fixture
// serves every route case:
//   - `mode`: "normal" | "malformed-open" | "no-open-reply" | "duplicate-open-reply" |
//     "no-write-reply"
//   - `workerSessionId`: the worker session id the open reply returns (default "ws-1")
//   - `data`: an array of `{ chunk, sid? }`. The fixture emits each as a data
//     notification after the open reply. `sid` defaults to the real worker session
//     id; a test sets a wrong `sid` to prove the host drops a mismatched
//     notification and counts a protocol error.
//   - `exitCode`: when set, the fixture emits an exit notification after the data.
//   - `echoInput`: when true, the fixture echoes each `duplexChannelWrite` back as
//     one data notification for the bound session.
//   - `closeMode`: "ack" | "bad-ack" | "no-ack" (default "ack"). It controls the
//     close reply, so a test proves the host retires the worker on an unconfirmed
//     close.
//   - `batchWithOpenReply`: when true, the fixture writes the open reply and the
//     scripted data and exit in one stdout write. The host then reads the open
//     reply and the notifications in one batch, so a test proves the host holds
//     and replays a frame that arrives before the route binds.
const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Serialize the scripted data and exit frames as newline-delimited lines. The
// batch mode writes these together with the open reply in one stdout write.
function scriptedFrameLines(directive, workerSessionId) {
  const data = Array.isArray(directive.data) ? directive.data : [];
  let lines = "";
  for (const entry of data) {
    lines += `${JSON.stringify({
      jsonrpc: "2.0",
      method: "duplexChannel.data",
      params: { workerSessionId: entry.sid ?? workerSessionId, chunk: entry.chunk },
    })}\n`;
  }
  if (typeof directive.exitCode === "number") {
    lines += `${JSON.stringify({
      jsonrpc: "2.0",
      method: "duplexChannel.exit",
      params: { workerSessionId, exitCode: directive.exitCode },
    })}\n`;
  }
  return lines;
}

// The registered channels, keyed by the host route id. Each entry records the
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
          "duplexChannelOpen",
          "duplexChannelWrite",
          "duplexChannelStop",
          "duplexChannelClose",
        ],
      },
    });
    return;
  }

  if (method === "duplexChannelOpen") {
    const directive = parseDirective(params.providerLeaseId);
    const mode = directive.mode ?? "normal";
    const workerSessionId = directive.workerSessionId ?? "ws-1";
    const closeMode = directive.closeMode ?? "ack";
    routes.set(params.hostRouteId, {
      workerSessionId,
      closeMode,
      echoInput: directive.echoInput === true,
      noWriteReply: mode === "no-write-reply",
    });

    if (mode === "no-open-reply") {
      // Never reply, so the host open call times out.
      return;
    }
    if (mode === "malformed-open") {
      // Reply with no worker session id, so the host terminalizes the route.
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    const openReplyLine = `${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { workerSessionId },
    })}\n`;

    if (directive.batchWithOpenReply === true) {
      // Write the open reply and the scripted frames in one stdout write. The
      // host reads them in one batch, so a data or exit frame arrives before the
      // route binds. The host must hold and replay the frame after the bind.
      process.stdout.write(openReplyLine + scriptedFrameLines(directive, workerSessionId));
      return;
    }

    const reply = () => process.stdout.write(openReplyLine);
    reply();
    if (mode === "duplicate-open-reply") {
      // Send a second open reply for the same request id. The host drops it.
      reply();
    }

    // Emit the scripted data and the exit after the open reply, so the host
    // binds the route first.
    setImmediate(() => {
      process.stdout.write(scriptedFrameLines(directive, workerSessionId));
    });
    return;
  }

  if (method === "duplexChannelWrite") {
    const entry = [...routes.values()].find(
      (route) => route.workerSessionId === params.workerSessionId,
    );
    if (entry && entry.noWriteReply) {
      // Never reply, so the host write call stays pending. The test proves the
      // host ends the route on the pending-request bound.
      return;
    }
    if (entry && entry.echoInput) {
      // Echo the input back as one data notification for the bound session, so a
      // test proves the input reaches the worker and the output routes back.
      send({
        jsonrpc: "2.0",
        method: "duplexChannel.data",
        params: { workerSessionId: entry.workerSessionId, chunk: `echo:${params.data}` },
      });
    }
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (method === "duplexChannelStop") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (method === "duplexChannelClose") {
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
