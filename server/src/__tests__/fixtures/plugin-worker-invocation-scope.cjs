const readline = require("node:readline");

let nextRequestId = 1;
const pendingNested = new Map();
let retainedInvocationId = null;
let releasedInvocationId = null;
let releasedAgentOutcome = null;
let releasedAgentWaiter = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendNestedHostRequest(originalRequest, invocationId) {
  const nestedId = `nested-${nextRequestId++}`;
  const params = originalRequest.params?.params ?? originalRequest.params?.parameters ?? {};
  const mode = params.mode;
  const requestedCompanyId = params.requestedCompanyId;
  const hostMethod = params.hostMethod || "companies.get";
  const nestedParams = hostMethod === "secrets.resolve"
    ? {
        companyId: requestedCompanyId,
        secretRef: {
          type: "secret_ref",
          secretId: params.secretId || "11111111-1111-4111-8111-111111111111",
        },
        configPath: params.configPath || "apiKeyRef",
      }
    : hostMethod === "projects.resolveGitCredential"
    ? {
        companyId: requestedCompanyId,
        projectId: originalRequest.params.projectId,
        workspaceId: originalRequest.params.operation.source.id,
      }
    : hostMethod === "state.get"
    ? {
        // Company-scoped state key — the shape a proactive gateway loop uses
        // (ctx.state.get with scopeKind "company"). The host derives the
        // requested company from scopeId, not companyId.
        scopeKind: "company",
        scopeId: requestedCompanyId,
        namespace: params.namespace || "ns",
        stateKey: params.stateKey || "key",
      }
    : hostMethod === "events.subscribe"
    ? {
        // The subscribe shape the SDK issues from setup() via
        // ctx.events.on(name, { companyId }, fn): the requested company lives in
        // filter.companyId, NOT a top-level companyId. The host resolver must
        // mirror the SDK gate and read it from there (LOOA-695).
        eventPattern: params.eventPattern || "issue.updated",
        filter: { companyId: requestedCompanyId },
      }
    : {
        companyId: requestedCompanyId,
      };
  if (mode === "retain" || mode === "retain-released" || mode === "use-retained" || mode === "release-retained") {
    const openingScope = mode === "retain" || mode === "retain-released";
    const retainedRequest = {
      jsonrpc: "2.0",
      id: nestedId,
      method: openingScope
        ? "background.retain"
        : mode === "release-retained"
          ? "background.release"
          : "companies.get",
      params: openingScope
        ? { companyId: requestedCompanyId }
        : mode === "release-retained"
          ? { invocationId: retainedInvocationId }
          : { companyId: requestedCompanyId },
      paperclipInvocationId: mode === "retain"
        ? invocationId
        : mode === "retain-released"
          ? "released-invocation"
          : (retainedInvocationId || releasedInvocationId || "released-invocation"),
    };
    pendingNested.set(nestedId, {
      id: originalRequest.id,
      capture: mode === "retain" ? "retain" : mode === "release-retained" ? "release" : undefined,
    });
    send(retainedRequest);
    return;
  }

  const nestedRequest = {
    jsonrpc: "2.0",
    id: nestedId,
    method: hostMethod,
    params: nestedParams,
  };

  if (mode === "echo") {
    nestedRequest.paperclipInvocationId = invocationId;
  } else if (mode === "unknown") {
    nestedRequest.paperclipInvocationId = "unknown-invocation";
  }

  pendingNested.set(nestedId, {
    id: originalRequest.id,
    ...(hostMethod === "projects.resolveGitCredential" ? { identity: {
      runId: originalRequest.params.runId,
      agentId: originalRequest.params.agentId,
    } } : {}),
  });
  send(nestedRequest);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id && pendingNested.has(message.id)) {
    const original = pendingNested.get(message.id);
    pendingNested.delete(message.id);
    if (original.capture === "released-agent") {
      releasedAgentOutcome = message.error
        ? { denied: true, code: message.error.code }
        : { denied: false, invocationId: message.result && message.result.invocationId };
      if (releasedAgentWaiter) {
        const waiter = releasedAgentWaiter;
        releasedAgentWaiter = null;
        send({ jsonrpc: "2.0", id: waiter, result: releasedAgentOutcome });
      }
      return;
    }
    if (message.error) {
      send({
        jsonrpc: "2.0",
        id: original.id,
        error: message.error,
      });
      return;
    }

    if (original.capture === "retain" && message.result && typeof message.result.invocationId === "string") {
      retainedInvocationId = message.result.invocationId;
    }
    if (original.capture === "release") {
      releasedInvocationId = retainedInvocationId;
      retainedInvocationId = null;
    }

    send({
      jsonrpc: "2.0",
      id: original.id,
      result: original.identity ? { identity: original.identity, credential: message.result } : message.result,
    });
    return;
  }

  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["getData", "performAction", "resourceLifecycle", "workspaceOperation", "workspacePrepare", "executeTool"],
      },
    });
    return;
  }

  if (["getData", "performAction", "resourceLifecycle", "workspaceOperation", "workspacePrepare", "executeTool"].includes(method)) {
    const params = message.params?.params ?? message.params?.parameters ?? {};
    if (params.mode === "retain-after-release") {
      const invocationId = message.paperclipInvocation && message.paperclipInvocation.id;
      send({ jsonrpc: "2.0", id: message.id, result: { released: true } });
      const nestedId = `nested-${nextRequestId++}`;
      pendingNested.set(nestedId, { capture: "released-agent" });
      send({
        jsonrpc: "2.0",
        id: nestedId,
        method: "background.retain",
        params: { companyId: params.requestedCompanyId },
        paperclipInvocationId: invocationId,
      });
      return;
    }
    if (params.mode === "released-agent-outcome") {
      if (releasedAgentOutcome) {
        send({ jsonrpc: "2.0", id: message.id, result: releasedAgentOutcome });
      } else {
        releasedAgentWaiter = message.id;
      }
      return;
    }
    sendNestedHostRequest(message, message.paperclipInvocation?.id);
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    setImmediate(() => process.exit(0));
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
