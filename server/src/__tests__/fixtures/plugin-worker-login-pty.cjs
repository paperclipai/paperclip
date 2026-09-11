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
//   - `outputs`: an array of `{ chunk, sid?, crossRoute?, omitHostRouteId? }`. The
//     fixture emits each as an output notification after the open reply. `sid`
//     defaults to the real worker session id; a test sets a wrong `sid` to prove
//     the host drops a mismatched notification. `crossRoute: true` sends this
//     route's own worker session id under a DIFFERENT, already-open route's host
//     route identifier (any other entry currently registered), so a test proves
//     the host drops a swapped `(hostRouteId, workerSessionId)` pair instead of
//     misdelivering it. `omitHostRouteId: true` sends the notification with no
//     `hostRouteId` field at all, so a test proves the host warns about a plugin
//     build old enough to omit the field, instead of silently dropping it.
//   - `exitCode`: when set, the fixture emits an exit notification after the outputs.
//   - `omitHostRouteIdOnExit`: when true, the main `exitCode` exit notification
//     carries no `hostRouteId` field, so a test proves the host still resolves
//     a legacy worker's exit by the worker session id.
//   - `extraExits`: an array of `{ exitCode, sid? }`. The fixture emits each as a
//     further exit notification, after the main `exitCode` exit. `sid` defaults
//     to the real worker session id; a test sets a wrong `sid` to script a worker
//     that sends a valid exit, then a mismatched exit, before the bind.
//   - `outputsAfterExit`: an array of `{ chunk, sid? }`, same shape as `outputs`.
//     The fixture emits these after the exit notification, so a test proves the
//     host drops output that arrives behind a queued exit.
//   - `sequence`: an array of `{ type: "output", chunk, sid? }` or
//     `{ type: "exit", exitCode, sid? }` entries. When set, the fixture emits
//     exactly this sequence, in order, instead of the fixed
//     outputs/exitCode/extraExits/outputsAfterExit composition. A test uses
//     this to script an arrival order the fixed composition cannot express,
//     for example a mismatched exit that arrives before a valid one.
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

// Find some other host route identifier the fixture already registered, for
// a `crossRoute` output entry. Returns null when no other route is open,
// which a well-formed test never triggers.
function pickOtherHostRouteId(ownHostRouteId) {
  for (const key of routes.keys()) {
    if (key !== ownHostRouteId) return key;
  }
  return null;
}

// Serialize one array of `{ chunk, sid?, crossRoute?, omitHostRouteId? }`
// entries as newline-delimited output notification lines. A test sets a
// wrong `sid` on one entry to force a mismatch. `crossRoute: true` stamps
// some OTHER already-open route's host route identifier on this route's own
// worker session id, so a test proves the host drops a swapped pair. Every
// other line echoes this route's own host route identifier, so the host can
// route each chunk to its own route when the worker holds more than one.
// `omitHostRouteId: true` sends the notification with no `hostRouteId` field
// at all, so a test proves the host warns instead of silently dropping it.
function outputLines(entries, hostRouteId, workerSessionId) {
  let lines = "";
  for (const entry of entries) {
    const effectiveHostRouteId = entry.crossRoute
      ? pickOtherHostRouteId(hostRouteId) ?? hostRouteId
      : entry.hostRouteId ?? hostRouteId;
    const params = {
      workerSessionId: entry.sid ?? workerSessionId,
      chunk: entry.chunk,
    };
    if (!entry.omitHostRouteId) params.hostRouteId = effectiveHostRouteId;
    lines += `${JSON.stringify({
      jsonrpc: "2.0",
      method: "loginPty.output",
      params,
    })}\n`;
  }
  return lines;
}

// Serialize one exit notification line for the given host route and worker
// session id. `omit: true` sends the notification with no `hostRouteId`
// field at all, matching a plugin build old enough to predate it.
function exitLine(hostRouteId, workerSessionId, exitCode, omit) {
  const params = { workerSessionId, exitCode };
  if (!omit) params.hostRouteId = hostRouteId;
  return `${JSON.stringify({
    jsonrpc: "2.0",
    method: "loginPty.exit",
    params,
  })}\n`;
}

// Serialize the scripted output and exit notifications as newline-delimited
// lines. The `sequence` directive, when set, emits exactly that order. The
// fixed composition otherwise emits, in order: the pre-exit outputs, then
// the main exit, then every extra exit, then the post-exit outputs. The
// batch mode writes these together with the open reply in one stdout write.
function scriptedOutputLines(directive, hostRouteId, workerSessionId) {
  if (Array.isArray(directive.sequence)) {
    let lines = "";
    for (const entry of directive.sequence) {
      if (entry.type === "output") {
        lines += outputLines(
          [{ chunk: entry.chunk, sid: entry.sid, hostRouteId: entry.hostRouteId, crossRoute: entry.crossRoute }],
          hostRouteId,
          workerSessionId,
        );
      } else if (entry.type === "exit") {
        lines += exitLine(entry.hostRouteId ?? hostRouteId, entry.sid ?? workerSessionId, entry.exitCode);
      }
    }
    return lines;
  }
  const outputs = Array.isArray(directive.outputs) ? directive.outputs : [];
  const outputsAfterExit = Array.isArray(directive.outputsAfterExit)
    ? directive.outputsAfterExit
    : [];
  const extraExits = Array.isArray(directive.extraExits) ? directive.extraExits : [];
  let lines = outputLines(outputs, hostRouteId, workerSessionId);
  if (typeof directive.exitCode === "number") {
    lines += exitLine(hostRouteId, workerSessionId, directive.exitCode, directive.omitHostRouteIdOnExit);
  }
  for (const exit of extraExits) {
    lines += exitLine(exit.hostRouteId ?? hostRouteId, exit.sid ?? workerSessionId, exit.exitCode);
  }
  lines += outputLines(outputsAfterExit, hostRouteId, workerSessionId);
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
      process.stdout.write(scriptedOutputLines(directive, params.hostRouteId, workerSessionId));
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
      process.stdout.write(
        openReplyLine + scriptedOutputLines(directive, params.hostRouteId, workerSessionId),
      );
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
      process.stdout.write(scriptedOutputLines(directive, params.hostRouteId, workerSessionId));
    });
    return;
  }

  if (method === "loginPtyInput") {
    // Echo the input back as one output notification for the bound session, so a
    // test proves the input reaches the worker and the output routes back.
    for (const [hostRouteId, entry] of routes.entries()) {
      if (entry.workerSessionId === params.workerSessionId) {
        send({
          jsonrpc: "2.0",
          method: "loginPty.output",
          params: {
            hostRouteId,
            workerSessionId: entry.workerSessionId,
            chunk: `echo:${params.data}`,
          },
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
