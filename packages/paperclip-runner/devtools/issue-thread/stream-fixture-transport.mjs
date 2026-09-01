/**
 * Scripted Codex transport for the browser streaming test (track 7Q).
 *
 * Everything below the provider is the real thing: the same package server
 * middleware, the same `CapabilityLiveSession`, the same NDJSON turn stream, and
 * the same built browser bundle. Only the provider is scripted, and only so the
 * test can decide when a delta arrives — a real Codex process cannot be asked
 * to emit exactly four deltas 220 ms apart, and a browser assertion needs that
 * to distinguish "streaming" from "arrived all at once".
 *
 * This module is loaded by `vite.issue-thread-stream.config.ts` only. It is not
 * reachable from the shipped server, the deployed surface, or any route: the
 * production plugin takes no transport override from a request or an
 * environment variable.
 */

const DELTA_INTERVAL_MS = 220;
export const CAPABILITY_STREAM_FIXTURE_PRIVATE_REASONING =
  "PRIVATE reasoning text must never reach the browser.";

/** Four deltas: enough for a browser to observe growth twice over, and short. */
export const CAPABILITY_STREAM_FIXTURE_DELTAS = [
  "Reading the clean-room issue. ",
  "It is blank, with one mock agent and one mock task. ",
  "Recording a first status against the mock control plane. ",
  "Done — every record stayed in the mock port.",
];

export const CAPABILITY_STREAM_FIXTURE_REPLY = CAPABILITY_STREAM_FIXTURE_DELTAS.join("");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Notifications {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class StreamFixtureTransport {
  #queue = new Notifications();
  #closed = false;
  #turns = 0;
  #interrupted = new Set();

  async request(method, params) {
    if (method === "initialize") return { user: { sessionId: "stream-fixture-session" } };
    if (method === "thread/start" || method === "thread/read" || method === "thread/resume") {
      return { thread: { id: "stream-fixture-thread", sessionId: "stream-fixture-session" } };
    }
    if (method === "turn/start") {
      this.#turns += 1;
      const turnId = `stream-turn-${this.#turns}`;
      void this.#runTurn(turnId);
      return { turn: { id: turnId, status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      // A stopped turn keeps whatever it had already streamed, so the surface
      // can be checked for a coherent partial reply.
      this.#interrupted.add(String(params.turnId));
      this.#queue.push({
        method: "turn/completed",
        params: {
          threadId: "stream-fixture-thread",
          turn: { id: String(params.turnId), status: "interrupted" },
        },
      });
      return {};
    }
    throw new Error(`unsupported scripted Codex method ${method}`);
  }

  notify() {}

  notifications() {
    return this.#queue;
  }

  setServerRequestHandler() {}

  async close() {
    this.#closed = true;
    this.#queue.close();
  }

  processInfo() {
    return { pid: 7100, processGroupId: 7100, exited: this.#closed, exitCode: null, signal: null };
  }

  async #runTurn(turnId) {
    this.#queue.push({
      method: "turn/started",
      params: { threadId: "stream-fixture-thread", turn: { id: turnId, status: "inProgress" } },
    });
    await sleep(Math.floor(DELTA_INTERVAL_MS / 2));
    if (this.#closed || this.#interrupted.has(turnId)) return;
    this.#queue.push({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "stream-fixture-thread",
        turnId,
        delta: CAPABILITY_STREAM_FIXTURE_PRIVATE_REASONING,
      },
    });
    for (const delta of CAPABILITY_STREAM_FIXTURE_DELTAS) {
      await sleep(DELTA_INTERVAL_MS);
      if (this.#closed || this.#interrupted.has(turnId)) return;
      this.#queue.push({
        method: "item/agentMessage/delta",
        params: { threadId: "stream-fixture-thread", turnId, delta },
      });
    }
    await sleep(DELTA_INTERVAL_MS);
    if (this.#closed || this.#interrupted.has(turnId)) return;
    this.#queue.push({
      method: "item/completed",
      params: {
        threadId: "stream-fixture-thread",
        turnId,
        item: { id: `message-${turnId}`, type: "agentMessage", text: CAPABILITY_STREAM_FIXTURE_REPLY },
      },
    });
    this.#queue.push({
      method: "turn/completed",
      params: { threadId: "stream-fixture-thread", turn: { id: turnId, status: "completed" } },
    });
  }
}

export function capabilityStreamFixtureTransportFactory(options = {}) {
  const evidence = {
    runnerPid: 7100,
    runnerProcessGroupId: 7100,
    codexPid: 7200,
    runnerExited: false,
    runnerExitCode: null,
    runnerSignal: null,
    childEnvironmentKeys: ["CODEX_HOME", "HOME", "PATH"],
    diagnostics: [],
  };
  options.onEvidence?.(evidence);
  return { transport: new StreamFixtureTransport(), evidence: () => ({ ...evidence }) };
}
