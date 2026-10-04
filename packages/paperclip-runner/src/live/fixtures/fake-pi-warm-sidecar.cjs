// Protocol-only fixture: no credentials, network, or model calls.
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
// The test binds configuration into the verified script snapshot before launch.
const config = /* fixture-config */ null;
let identity;
let runId;
let turnId;
let sequence = 1;
const send = (value) => process.stdout.write(`${JSON.stringify({ protocolVersion: 2, ...value })}\n`);
const event = (eventType, payload) => send({ sequence: sequence++, eventType, runId, turnId, payload });
const journal = (value) => appendFileSync(config.journal, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
journal({ event: "spawn" });

async function handle({ id, command, params = {} }) {
  journal({ command, resumed: command === "session.open" && !!params.expectedIdentity });
  let result;
  switch (command) {
    case "initialize":
      result = { protocolVersion: 2, sidecarPid: process.pid, profile: { agent: "pi" }, capabilities: {
        persistentSessions: true, exactModelVerification: true, permissions: "runner_policy",
        semanticTools: "runner_bridge", structuredInput: "paperclip.question_set.v1",
      } };
      break;
    case "session.open":
      if (params.expectedIdentity) await new Promise((resolve) => setTimeout(resolve, config.resumeDelayMs));
      identity = params.expectedIdentity ?? {
        kind: "acpx", normalizedSessionId: params.normalizedSessionId,
        acpxRecordId: "record-warm", backendSessionId: "backend-warm", agentSessionId: "agent-warm",
        profileDigest: "sha256:f35145437eeb355ed37bc5a4fa93d7ede561d9c45daf311979b46890b808ddd4",
        workspaceDigest: `sha256:${"2".repeat(64)}`, requestedModel: params.model, effectiveModel: params.model,
        permissionMode: params.permissionMode, piThinkingLevel: params.piThinkingLevel,
        providerLifetimeFenceCandidates: [61001, 61002, 61003],
      };
      result = { sidecarPid: process.pid, identity, status: {}, turnControls: { steering: true, queuedFollowUp: true } };
      break;
    case "run.attach":
      runId = params.runId;
      result = { runId, catalogRevision: params.catalogRevision };
      break;
    case "turn.start":
      turnId = params.turnId;
      result = { turnId, turnControls: { steering: true, queuedFollowUp: true } };
      break;
    case "tool.resolve":
      if (params.error) throw new Error(`Completion rejected: ${JSON.stringify(params.error)}`);
      result = { resolved: true };
      break;
    case "session.snapshot":
      result = { identity, runId, turnId: null, pendingRuntimeRequests: [] };
      break;
    case "session.goal.get":
      result = { schema: "paperclip.session_goal.snapshot.v1", goal: null, workingNow: false, sessionGoals: {
        availability: "available", actions: ["set", "pause", "resume", "clear"], autonomousUpdates: true,
        persistentAcrossResume: true, maxObjectiveChars: 4000, tokenBudgetControl: false, usageReporting: false,
      } };
      break;
    case "session.suspend": result = { suspended: true, identity }; break;
    case "session.close": result = { closed: true }; break;
    case "turn.cancel": result = { cancelled: true }; break;
    default: throw new Error(`Unexpected fixture command ${command}`);
  }
  send({ id, ok: true, result });
  if (command === "turn.start") event("runtime.tool_called", {
    callId: `finish-${turnId}`, operationId: "paperclip_finish", input: {
      schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Fixture turn completed.",
      completionClaim: { contractRevision: "warm-pi-contract", objectiveSatisfied: true, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
    },
  });
  if (command === "tool.resolve") event("runtime.turn_terminal", { status: "completed" });
}

let handling = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  handling = handling.then(() => handle(JSON.parse(line))).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
});
