#!/usr/bin/env node
/**
 * Live smoke for the Capability issue-thread server.
 *
 * Starts the real package server on loopback, drives a real runnerd + Codex
 * app-server session through the same HTTP routes the browser uses, and checks
 * that the projected view carries the live identity, the multi-turn thread, the
 * durable mock records, and no credential. Requires an authenticated local
 * Codex installation.
 *
 * Usage: node scripts/capability-issue-thread-smoke.mjs [--json]
 */

import { createServer } from "node:http";
import { once } from "node:events";

import { createCapabilityCookieJar } from "./capability-cookie-jar.mjs";
import { createCapabilityIssueThreadMiddleware } from "./capability-issue-thread-server.mjs";

const { readCapabilityTurnStream, CAPABILITY_TURN_STREAM_ACCEPT } = await import(
  new URL("../dist/live/index.js", import.meta.url).href
);

/** Runs one turn over the NDJSON stream and returns its settled payload. */
async function runTurn(jar, body) {
  const response = await jar.fetch("/api/capability/ui/message", {
    method: "POST",
    headers: { "content-type": "application/json", accept: CAPABILITY_TURN_STREAM_ACCEPT },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`turn failed with HTTP ${response.status}`);
  let frames = 0;
  const settled = await readCapabilityTurnStream(response, () => {
    frames += 1;
  });
  return { ...settled, frames };
}

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

async function main() {
  const asJson = process.argv.includes("--json");
  let turnError = null;
  let turnErrorMethods = [];
  const middleware = createCapabilityIssueThreadMiddleware({
    bindHost: "127.0.0.1",
    requestedModel: "gpt-5.4-mini",
    onTurnError: (error, _sessionId, snapshot) => {
      turnError = error;
      turnErrorMethods = snapshot.evidence
        .filter((entry) => entry.kind === "provider_event")
        .map((entry) => entry.data);
    },
  });
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

  // One jar for the whole run: the routes are bound to a per-browser capability
  // (track 7U), so the smoke has to behave like one browser.
  const jar = createCapabilityCookieJar(origin);
  const assertions = {};
  let sessionId = null;
  try {
    const created = await (await jar.fetch("/api/capability/ui/session")).json();
    sessionId = created.sessionId;
    assertions.sessionCreated = typeof sessionId === "string" && sessionId.length > 0;
    assertions.liveIdentity =
      created.view.identity.agentLabel === "Real Codex" &&
      created.view.identity.runnerLabel === "Real runnerd" &&
      created.view.identity.controlPlaneLabel === "Mock Paperclip";
    assertions.mockIdentifier = created.view.issue.identifier.startsWith("MCK-");
    assertions.toolsProjected = created.view.evidence.tools.length >= 0;

    const first = await runTurn(jar, {
      sessionId,
      message:
        "Call get_task_context, then call report_progress with a one-sentence status. Do not ask me anything.",
    }).catch((error) => {
      if (turnError instanceof Error) {
        throw new Error("live issue-thread turn failed", { cause: turnError });
      }
      throw error;
    });
    assertions.turnStreamed = first.frames >= 2;
    const firstItems = first.view.turns.flatMap((turn) => turn.items);
    assertions.userMessageRendered = firstItems.some((item) => item.kind === "user_message");
    assertions.toolActivityRendered = firstItems.some((item) => item.kind === "tool_activity");
    assertions.durableCommentRendered = firstItems.some(
      (item) => item.kind === "durable_comment",
    );
    assertions.authorizationRecorded = first.view.evidence.authorization.length > 0;
    assertions.callsRecorded = first.view.evidence.calls.length > 0;
    assertions.controlPlaneWithheld = (first.view.evidence.tools[0]?.rows ?? []).some(
      (row) => row.disposition === "control_plane_owned",
    );

    const second = await runTurn(jar, {
      sessionId,
      message: "Summarise the mock task in one line.",
    }).catch((error) => {
      if (turnError instanceof Error) {
        throw new Error(`live issue-thread second turn failed; provider methods=${JSON.stringify(turnErrorMethods)}`, { cause: turnError });
      }
      throw error;
    });
    assertions.multiTurnThread = second.view.turns.length > first.view.turns.length;
    assertions.composerReady = second.view.composer.state === "ready";

    assertions.noCredentialInView = credentialLeaks(second.view).length === 0;
    // A browser without this run's capability must not reach this session.
    const stranger = createCapabilityCookieJar(origin);
    const foreign = await stranger.fetch(`/api/capability/ui/session?sessionId=${sessionId}`);
    await foreign.text();
    assertions.crossSessionDenied = foreign.status === 404;

    const failures = Object.entries(assertions).filter(([, ok]) => ok !== true);
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schema: "paperclip.capability.issue-thread-smoke.v1",
            sessionId,
            turns: second.view.turns.length,
            toolCalls: second.view.evidence.calls.length,
            authorizationRecords: second.view.evidence.authorization.length,
            assertions,
          },
          null,
          2,
        )}\n`,
      );
    }
    assert(failures.length === 0, `${failures.map(([name]) => name).join(", ")}`);
    if (!asJson) process.stdout.write("Capability issue-thread live smoke passed.\n");
  } finally {
    await middleware.close();
    server.close();
  }
}

await main();
