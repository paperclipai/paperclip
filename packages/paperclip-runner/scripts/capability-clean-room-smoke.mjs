#!/usr/bin/env node
/**
 * Live smoke for the Capability clean-room chat.
 *
 * Starts the real package server on loopback, opens a clean room, and drives a
 * real runnerd + Codex app-server session through the same HTTP routes the
 * browser uses. It checks that the room starts blank, that a free-form message
 * produces a real Codex turn with semantic tool calls against the mock control
 * plane, that `New chat` rotates the mock identities and retires the previous
 * session, and that nothing in the projected view carries a credential.
 *
 * Requires an authenticated local Codex installation and a built runnerd.
 *
 * Usage: node scripts/capability-clean-room-smoke.mjs [--json]
 */

import { createServer } from "node:http";
import { once } from "node:events";

import { createCapabilityCookieJar } from "./capability-cookie-jar.mjs";
import { createCapabilityIssueThreadMiddleware } from "./capability-issue-thread-server.mjs";

const { readCapabilityTurnStream, CAPABILITY_TURN_STREAM_ACCEPT } = await import(
  new URL("../dist/live/index.js", import.meta.url).href
);

const CREDENTIAL_PATTERNS = [
  /bearer\s+[a-z0-9._-]+/i,
  // Anchored so a mock id such as `task-cleanroom-3f2a9c11` cannot masquerade
  // as an `sk-` provider key. A real key is preceded by a delimiter.
  /(?<![A-Za-z0-9])sk-[a-z0-9]{8,}/i,
  /"api[_-]?key"\s*:/i,
  /PAPERCLIP_API_KEY/,
  /OPENAI_API_KEY/,
];

function credentialLeaks(value) {
  const serialized = JSON.stringify(value);
  return CREDENTIAL_PATTERNS.filter((pattern) => pattern.test(serialized)).map(String);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function items(view) {
  return view.turns.flatMap((turn) => turn.items);
}

function assistantText(view) {
  return items(view)
    .filter((item) => item.kind === "agent_message")
    .map((item) => item.body)
    .join("");
}

/**
 * Interim assistant states are monotonic when each one extends the last. That
 * is the property the streamed turn has to hold against a real provider, not
 * just against a scripted one.
 */
function monotonic(states) {
  return states.every((state, index) => index === 0 || state.startsWith(states[index - 1]));
}

async function main() {
  const asJson = process.argv.includes("--json");
  const middleware = createCapabilityIssueThreadMiddleware({ bindHost: "127.0.0.1" });
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  // One jar for the whole run: the smoke drives the routes as a single browser
  // would, so it carries the capability the server minted for it.
  const jar = createCapabilityCookieJar(origin);
  const get = async (path) => (await jar.fetch(path)).json();
  const post = async (path, body) =>
    (
      await jar.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  /**
   * Runs one turn and records what the browser would have rendered along the
   * way, so the smoke proves incremental delivery from a real Codex turn rather
   * than only the settled reply.
   */
  const turn = async (body) => {
    const response = await jar.fetch("/api/capability/ui/message", {
      method: "POST",
      headers: { "content-type": "application/json", accept: CAPABILITY_TURN_STREAM_ACCEPT },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`turn failed with HTTP ${response.status}`);
    const states = [];
    const settled = await readCapabilityTurnStream(response, (frame) => {
      states.push(assistantText(frame.view));
    });
    return { ...settled, states };
  };

  const assertions = {};
  let summary = {};
  try {
    const opened = await get("/api/capability/ui/cleanroom/session");
    assertions.cleanRoomOpened = typeof opened.sessionId === "string" && opened.sessionId.length > 0;
    assertions.blankThread = Array.isArray(opened.view.turns) && opened.view.turns.length === 0;
    assertions.noCannedEvidence =
      opened.view.evidence.calls.length === 0 &&
      opened.view.evidence.parity.length === 0 &&
      opened.view.replay === null;
    assertions.liveIdentity =
      opened.view.mode === "live" &&
      opened.view.identity.agentLabel === "Real Codex" &&
      opened.view.identity.runnerLabel === "Real runnerd" &&
      opened.view.identity.controlPlaneLabel === "Mock Paperclip";
    assertions.freshMockTenant =
      typeof opened.identity?.token === "string" &&
      opened.view.issue.identifier === opened.identity.identifier &&
      opened.view.issue.identifier.startsWith("MCK-");

    const first = await turn({
      sessionId: opened.sessionId,
      message:
        "Read this issue with get_task_context, then call report_progress with a one-sentence status. Do not ask me anything.",
    });
    const firstItems = items(first.view);
    const growing = first.states.filter((state) => state.length > 0);
    assertions.streamedIncrementally =
      growing.length >= 2 && monotonic(growing) && growing.at(-1) === assistantText(first.view);
    assertions.realCodexTurn = firstItems.some((item) => item.kind === "agent_message");
    assertions.semanticToolCalled = firstItems.some((item) => item.kind === "tool_activity");
    assertions.mockStateMutated = firstItems.some((item) => item.kind === "durable_comment");
    assertions.authorizationRecorded = first.view.evidence.authorization.length > 0;

    const second = await turn({
      sessionId: opened.sessionId,
      message: "In one line, what status did you just record?",
    });
    assertions.multiTurnSameSession =
      second.sessionId === opened.sessionId && second.view.turns.length > first.view.turns.length;
    assertions.composerReady = second.view.composer.state === "ready";

    const guard = second.view.evidence.control_plane.find((record) =>
      record.id.startsWith("network-guard-"),
    );
    assertions.realApiBlocked = guard?.outcome === "no_real_paperclip_request";
    assertions.noCredentialInView = credentialLeaks(second.view).length === 0;

    const fresh = await post("/api/capability/ui/cleanroom/session", { sessionId: opened.sessionId });
    assertions.newChatRotatesIdentity =
      fresh.sessionId !== opened.sessionId &&
      fresh.identity.companyId !== opened.identity.companyId &&
      fresh.identity.taskId !== opened.identity.taskId &&
      fresh.view.turns.length === 0;
    const retired = await jar.fetch("/api/capability/ui/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: opened.sessionId, message: "still there?" }),
    });
    assertions.priorAuthorityRetired = retired.status === 404;
    // A second browser must not reach the room this one owns.
    const stranger = createCapabilityCookieJar(origin);
    const foreign = await stranger.fetch(
      `/api/capability/ui/cleanroom/session?sessionId=${fresh.sessionId}`,
    );
    await foreign.text();
    assertions.crossSessionDenied = foreign.status === 404;
    assertions.capabilityBound = typeof jar.value("paperclip_capability_chat") === "string";

    summary = {
      schema: "paperclip.capability.clean-room-smoke.v1",
      firstSessionId: opened.sessionId,
      firstIssue: opened.view.issue.identifier,
      newChatSessionId: fresh.sessionId,
      newChatIssue: fresh.view.issue.identifier,
      turns: second.view.turns.length,
      streamedStates: first.states.length,
      streamedPrefixes: first.states.filter((state) => state.length > 0).slice(0, 3),
      toolCalls: second.view.evidence.calls.map((call) => ({
        operationId: call.operationId,
        outcome: call.outcome,
      })),
      authorizationRecords: second.view.evidence.authorization.length,
      assistantReply: firstItems.find((item) => item.kind === "agent_message")?.body ?? null,
    };

    const failures = Object.entries(assertions).filter(([, ok]) => ok !== true);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ...summary, assertions }, null, 2)}\n`);
    }
    assert(failures.length === 0, `${failures.map(([name]) => name).join(", ")}`);
    if (!asJson) process.stdout.write("Capability clean-room live smoke passed.\n");
  } finally {
    await middleware.close();
    server.close();
  }
}

await main();
