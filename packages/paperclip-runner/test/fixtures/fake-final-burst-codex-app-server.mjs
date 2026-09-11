// Credential-free, deterministic provider for the opt-in durable burst benchmark.
// No network, model, tool execution, or user files are used by this fixture.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [statePath, countArg] = process.argv.slice(2);
const deltaCount = Number(countArg);
if (!statePath || ![16, 128, 512].includes(deltaCount)) {
  throw new Error("final_burst_fixture_invalid_arguments");
}
let state;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  state = { threadId: "final-burst-thread", nextTurn: 0, turns: {} };
}
const pending = new Map();
const save = () =>
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function finish(turnId) {
  const turn = state.turns[turnId];
  turn.burstStartedAtMs = Date.now();
  for (let index = 0; index < deltaCount; index += 1) {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: state.threadId,
        turnId,
        itemId: `message-${turnId}`,
        delta: `${index.toString().padStart(4, "0")} `,
      },
    });
  }
  send({
    method: "item/completed",
    params: {
      threadId: state.threadId,
      turnId,
      item: {
        id: `message-${turnId}`,
        type: "agentMessage",
        text: "Fixture complete.",
      },
    },
  });
  turn.status = "completed";
  turn.deltaCount = deltaCount;
  turn.providerCompletedAtMs = Date.now();
  save();
  send({
    method: "turn/completed",
    params: {
      threadId: state.threadId,
      turn: { id: turnId, status: "completed" },
    },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (!method) {
    const turnId = pending.get(String(id));
    if (!turnId) return;
    pending.delete(String(id));
    if (message.error || message.result?.success !== true) {
      throw new Error("final_burst_fixture_completion_rejected");
    }
    state.turns[turnId].completionReceiptAtMs = Date.now();
    finish(turnId);
    return;
  }
  if (id === undefined) return;
  if (method === "initialize") {
    send({ id, result: { user: { sessionId: "final-burst-fixture" } } });
  } else if (
    ["thread/start", "thread/resume", "thread/read"].includes(method)
  ) {
    save();
    send({
      id,
      result: {
        model: "fixture-no-model",
        modelProvider: "fixture-no-provider",
        thread: {
          id: state.threadId,
          status: { type: Object.values(state.turns).some(turn => turn.status === "inProgress") ? "active" : "idle" },
          sessionId: "final-burst-fixture",
          turns: Object.entries(state.turns).map(([turnId, turn]) => ({
            id: turnId,
            status: turn.status,
          })),
        },
      },
    });
  } else if (method === "turn/start") {
    const turnId = `final-burst-turn-${++state.nextTurn}`;
    state.turns[turnId] = { status: "inProgress", startedAtMs: Date.now() };
    save();
    send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({
      method: "turn/started",
      params: {
        threadId: state.threadId,
        turn: { id: turnId, status: "inProgress" },
      },
    });
    const requestId = `finish-${turnId}`;
    pending.set(requestId, turnId);
    send({
      id: requestId,
      method: "item/tool/call",
      params: {
        threadId: state.threadId,
        turnId,
        callId: requestId,
        tool: "paperclip_finish",
        arguments: {
          reportedWorkDisposition: "done",
          summary: "Fixture complete.",
          completionClaim: {
            contractRevision: "burst-v1",
            objectiveSatisfied: true,
            criteria: [
              { criterionId: "burst", status: "satisfied", evidenceRefs: [] },
            ],
            remainingWork: [],
          },
          evidence: [],
          verification: [],
          attentionRequests: [],
          artifacts: [],
        },
      },
    });
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
    const turn = state.turns[params.turnId];
    if (turn && turn.status !== "completed") {
      turn.status = "interrupted";
      save();
      send({
        method: "turn/completed",
        params: {
          threadId: state.threadId,
          turn: { id: params.turnId, status: "interrupted" },
        },
      });
    }
  } else {
    send({
      id,
      error: {
        code: -32601,
        message: "final_burst_fixture_unsupported_method",
      },
    });
  }
});
