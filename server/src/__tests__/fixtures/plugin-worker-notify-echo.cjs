// Test worker fixture for the `agents.sessions.event` host→worker
// NOTIFICATION path (BRO-2278 / notify() invocation-scope regression tests).
//
// A notification has no `id`, so the worker never gets to reply to it
// directly — there's nothing for the host to await. To let a test observe
// what invocation info actually rode along on the wire, this fixture reacts
// to an incoming `agents.sessions.event` notification by turning around and
// issuing its OWN worker→host request (`companies.get`, already a handled
// method in the other invocation-scope fixture/tests) whose params echo:
//   - `companyId`              — the notification's own `params.companyId`
//   - `observedInvocationId`   — `message.paperclipInvocation.id`, or null
//   - `observedScopeCompanyId` — `message.paperclipInvocation.scope.companyId`,
//                                 or null
//
// A test registers a `"companies.get"` mock in `hostHandlers` and asserts on
// its captured call arguments. Responses to the echo request are ignored —
// the fixture only needs the outbound observation, not a round trip.
const readline = require("node:readline");

let nextEchoId = 1;
const pendingEchoIds = new Set();

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

  // A response to one of our own echo requests — nothing further to do.
  if (message.id !== undefined && message.id !== null && pendingEchoIds.has(message.id)) {
    pendingEchoIds.delete(message.id);
    return;
  }

  const method = typeof message.method === "string" ? message.method : null;
  const isNotification = message.id === undefined || message.id === null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true, supportedMethods: [] },
    });
    return;
  }

  if (method === "agents.sessions.event" && isNotification) {
    const params = message.params || {};
    const invocation = message.paperclipInvocation || null;
    const echoId = `echo-${nextEchoId++}`;
    pendingEchoIds.add(echoId);
    send({
      jsonrpc: "2.0",
      id: echoId,
      method: "companies.get",
      params: {
        companyId: params.companyId ?? null,
        observedInvocationId: invocation ? invocation.id : null,
        observedScopeCompanyId:
          invocation && invocation.scope ? invocation.scope.companyId : null,
      },
    });
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }

  // Anything else this fixture doesn't model is silently ignored — it only
  // needs to speak the two methods above plus lifecycle.
});
