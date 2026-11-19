// Credential-free, deterministic provider that streams one delta at a time.
// No network, model, tool execution, or user files are used by this fixture.
// Usage: node fake-paced-codex-app-server.mjs <deltaCount> <intervalMs>
import { createInterface } from "node:readline";

const [countArg, intervalArg] = process.argv.slice(2);
const deltaCount = Number(countArg);
const intervalMs = Number(intervalArg);
if (
  !Number.isInteger(deltaCount) || deltaCount < 1 || deltaCount > 512 ||
  !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_000
) {
  throw new Error("paced_fixture_invalid_arguments");
}
const threadId = "paced-thread";
const turns = new Map();
let nextTurn = 0;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function stream(turnId) {
  let index = 0;
  const timer = setInterval(() => {
    if (turns.get(turnId) !== "inProgress") {
      clearInterval(timer);
      return;
    }
    if (index < deltaCount) {
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId: `message-${turnId}`,
          delta: `${index.toString().padStart(4, "0")} `,
        },
      });
      index += 1;
      return;
    }
    clearInterval(timer);
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: `message-${turnId}`, type: "agentMessage", text: "Fixture complete." },
      },
    });
    turns.set(turnId, "completed");
    send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });
  }, intervalMs);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (!method || id === undefined) return;
  if (method === "initialize") {
    send({ id, result: { user: { sessionId: "paced-fixture" } } });
  } else if (["thread/start", "thread/resume", "thread/read"].includes(method)) {
    send({
      id,
      result: {
        model: "fixture-no-model",
        modelProvider: "fixture-no-provider",
        thread: {
          id: threadId,
          sessionId: "paced-fixture",
          status: { type: [...turns.values()].includes("inProgress") ? "active" : "idle" },
          ...(params.includeTurns
            ? { turns: [...turns].map(([turnId, status]) => ({ id: turnId, status })) }
            : {}),
        },
      },
    });
  } else if (method === "thread/turns/list") {
    const listed = [...turns].map(([turnId, status]) => ({
      id: turnId, status, items: [], itemsView: "notLoaded",
    }));
    if (params.sortDirection === "desc") listed.reverse();
    const offset = Number(params.cursor ?? 0);
    const limit = params.limit ?? 100;
    send({ id, result: {
      data: listed.slice(offset, offset + limit),
      nextCursor: offset + limit < listed.length ? String(offset + limit) : null,
    } });
  } else if (method === "turn/start") {
    const turnId = `paced-turn-${++nextTurn}`;
    turns.set(turnId, "inProgress");
    send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    stream(turnId);
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
    if (turns.get(params.turnId) === "inProgress") {
      turns.set(params.turnId, "interrupted");
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: params.turnId, status: "interrupted" } },
      });
    }
  } else {
    send({ id, error: { code: -32601, message: "paced_fixture_unsupported_method" } });
  }
});
