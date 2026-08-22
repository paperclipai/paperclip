// Test worker fixture for the host-owned setup-token login pseudo-terminal route
// gate. The fixture drives the manager route state machine through
// the four typed methods (open, input, stop, close) and the output and exit
// notifications.
//
// The manager allowlists `command` to the fixed `CLAUDE_SETUP_TOKEN_COMMAND`. The
// test encodes a JSON directive in the forwarded `providerLeaseId`, so one fixture
// serves every route-gate case:
//   - `mode`: "normal" | "malformed-open" | "no-open-reply" | "duplicate-open-reply"
//   - `workerSessionId`: the worker session id the open reply returns (default "ws-1")
//   - `outputs`: an array of `{ chunk, sid? }`. The fixture emits each as an output
//     notification after the open reply. `sid` defaults to the real worker session
//     id; a test sets a wrong `sid` to prove the host drops a mismatched
//     notification.
//   - `exitCode`: when set, the fixture emits an exit notification after the outputs.
//   - `closeMode`: "ack" | "bad-ack" | "no-ack" (default "ack"). It controls the
//     close reply, so a test proves the host retires the worker on an unconfirmed
//     close.
const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
          "setupTokenPtyOpen",
          "setupTokenPtyInput",
          "setupTokenPtyStop",
          "setupTokenPtyClose",
        ],
      },
    });
    return;
  }

  if (method === "setupTokenPtyOpen") {
    const directive = parseDirective(params.providerLeaseId);
    const mode = directive.mode ?? "normal";
    const workerSessionId = directive.workerSessionId ?? "ws-1";
    const closeMode = directive.closeMode ?? "ack";
    routes.set(params.hostRouteId, { workerSessionId, closeMode });

    if (mode === "no-open-reply") {
      // Never reply, so the host open call times out.
      return;
    }
    if (mode === "malformed-open") {
      // Reply with no worker session id, so the host terminalizes the route.
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    const reply = () =>
      send({ jsonrpc: "2.0", id: message.id, result: { workerSessionId } });
    reply();
    if (mode === "duplicate-open-reply") {
      // Send a second open reply for the same request id. The host drops it.
      reply();
    }

    // Emit the scripted output and the exit after the open reply, so the host
    // binds the route first.
    setImmediate(() => {
      const outputs = Array.isArray(directive.outputs) ? directive.outputs : [];
      for (const entry of outputs) {
        send({
          jsonrpc: "2.0",
          method: "setupTokenPty.output",
          params: {
            workerSessionId: entry.sid ?? workerSessionId,
            chunk: entry.chunk,
          },
        });
      }
      if (typeof directive.exitCode === "number") {
        send({
          jsonrpc: "2.0",
          method: "setupTokenPty.exit",
          params: { workerSessionId, exitCode: directive.exitCode },
        });
      }
    });
    return;
  }

  if (method === "setupTokenPtyInput") {
    // Echo the input back as one output notification for the bound session, so a
    // test proves the input reaches the worker and the output routes back.
    for (const entry of routes.values()) {
      if (entry.workerSessionId === params.workerSessionId) {
        send({
          jsonrpc: "2.0",
          method: "setupTokenPty.output",
          params: { workerSessionId: entry.workerSessionId, chunk: `echo:${params.data}` },
        });
      }
    }
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (method === "setupTokenPtyStop") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (method === "setupTokenPtyClose") {
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
