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
//   - `data`: an array of `{ chunk, sid?, rid? }`. The fixture emits each as a
//     data notification after the open reply. `sid` defaults to the real worker
//     session id and `rid` defaults to the real host route id; a test sets a wrong
//     `sid` or `rid` to prove the host drops a mismatched-pair notification and
//     counts a protocol error.
//   - `exitCode`: when set, the fixture emits an exit notification after the data.
//   - `transportClosed`: when true, the exit notification marks a reason-less
//     transport close and carries no exit code.
//   - `dataAfterExit`: an array of `{ chunk, sid? }`, same shape as `data`. The
//     fixture emits these as data notifications after the exit notification, so a
//     test can script a batch where a data frame arrives after the exit in the
//     read order — proving the host still bounds these frames on their own terms
//     and never lets the exit crowd a data frame out of the pre-open hold.
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
// batch mode writes these together with the open reply in one stdout write. Each
// frame carries the exact pair, so the host binds and routes by the pair. A test
// sets a wrong `sid` or `rid` to force a mismatch.
function scriptedFrameLines(directive, hostRouteId, workerSessionId) {
  const data = Array.isArray(directive.data) ? directive.data : [];
  let lines = "";
  for (const entry of data) {
    lines += `${JSON.stringify({
      jsonrpc: "2.0",
      method: "duplexChannel.data",
      params: {
        hostRouteId: entry.rid ?? hostRouteId,
        workerSessionId: entry.sid ?? workerSessionId,
        chunk: entry.chunk,
      },
    })}\n`;
  }
  if (typeof directive.exitCode === "number" || directive.transportClosed === true) {
    const exitParams = {
      hostRouteId,
      workerSessionId,
      exitCode: typeof directive.exitCode === "number" ? directive.exitCode : null,
    };
    // A transport-close directive marks a reason-less transport close, so the
    // fixture carries the discriminator the same way a real worker does.
    if (directive.transportClosed === true) exitParams.transportClosed = true;
    lines += `${JSON.stringify({
      jsonrpc: "2.0",
      method: "duplexChannel.exit",
      params: exitParams,
    })}\n`;
  }
  const dataAfterExit = Array.isArray(directive.dataAfterExit) ? directive.dataAfterExit : [];
  for (const entry of dataAfterExit) {
    lines += `${JSON.stringify({
      jsonrpc: "2.0",
      method: "duplexChannel.data",
      params: {
        hostRouteId: entry.rid ?? hostRouteId,
        workerSessionId: entry.sid ?? workerSessionId,
        chunk: entry.chunk,
      },
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
    const hostRouteId = params.hostRouteId;
    routes.set(hostRouteId, {
      hostRouteId,
      workerSessionId,
      closeMode,
      echoInput: directive.echoInput === true,
      noWriteReply: mode === "no-write-reply",
      emitAfterCloseChunk:
        typeof directive.emitAfterCloseChunk === "string" ? directive.emitAfterCloseChunk : null,
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

    // Echo the host route id on the reply, so the host binds the exact pair.
    const openReplyLine = `${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { hostRouteId, workerSessionId },
    })}\n`;

    if (directive.batchWithOpenReply === true) {
      // Write the open reply and the scripted frames in one stdout write. The
      // host reads them in one batch, so a data or exit frame arrives before the
      // route binds. The host must hold and replay the frame after the bind.
      process.stdout.write(openReplyLine + scriptedFrameLines(directive, hostRouteId, workerSessionId));
      return;
    }

    const reply = () => process.stdout.write(openReplyLine);
    reply();
    if (mode === "duplicate-open-reply") {
      // Send a second open reply for the same request id. The host drops it.
      reply();
    }

    // Emit the scripted data and the exit after the open reply, so the host
    // binds the route first. Each frame echoes the exact pair; a test overrides
    // `sid` or `rid` to force a mismatch.
    setImmediate(() => {
      process.stdout.write(scriptedFrameLines(directive, hostRouteId, workerSessionId));
    });
    return;
  }

  if (method === "duplexChannelWrite") {
    // Act only on the exact live pair. A write whose pair does not match a bound
    // route applies no bytes.
    const entry = routes.get(params.hostRouteId);
    if (!entry || entry.workerSessionId !== params.workerSessionId) {
      send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    if (entry.noWriteReply) {
      // Never reply, so the host write call stays pending. The test proves the
      // host ends the route on the pending-request bound.
      return;
    }
    if (entry.echoInput) {
      // Echo the input back as one data notification for the bound pair, so a
      // test proves the input reaches the worker and the output routes back.
      send({
        jsonrpc: "2.0",
        method: "duplexChannel.data",
        params: {
          hostRouteId: entry.hostRouteId,
          workerSessionId: entry.workerSessionId,
          chunk: `echo:${params.data}`,
        },
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
    // A bound close echoes both identifiers; a pre-bind close with no entry
    // echoes the host route id only.
    const ack = entry
      ? { hostRouteId: params.hostRouteId, workerSessionId: entry.workerSessionId }
      : { hostRouteId: params.hostRouteId };
    send({ jsonrpc: "2.0", id: message.id, result: ack });
    if (entry && entry.emitAfterCloseChunk) {
      // Emit one late data frame for the just-closed pair, so a test proves the
      // host drops a late frame for a tombstoned pair and does not retire the
      // worker.
      setImmediate(() => {
        send({
          jsonrpc: "2.0",
          method: "duplexChannel.data",
          params: {
            hostRouteId: entry.hostRouteId,
            workerSessionId: entry.workerSessionId,
            chunk: entry.emitAfterCloseChunk,
          },
        });
      });
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
