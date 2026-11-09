#!/usr/bin/env node
/** Live, two-turn AWS AgentCore smoke through the exact Runner Lab HTTP path. */

import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { createCapabilityCookieJar } from "./capability-cookie-jar.mjs";
import { createCapabilityIssueThreadMiddleware } from "./capability-issue-thread-server.mjs";

const { readCapabilityTurnStream, CAPABILITY_TURN_STREAM_ACCEPT } = await import(
  new URL("../dist/live/index.js", import.meta.url).href
);

const envPath = new URL("../.paperclip-local/aws-agentcore.env", import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assistantText(view) {
  return view.turns.flatMap((turn) => turn.items)
    .filter((item) => item.kind === "agent_message")
    .map((item) => item.body)
    .join("\n").trim();
}

async function loadProfileEnvironment() {
  let source;
  try {
    source = await readFile(envPath, "utf8");
  } catch {
    throw new Error("AWS AgentCore profile is missing; run aws-agentcore:provision first");
  }
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("generated AWS AgentCore profile contains an invalid line");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("generated AWS AgentCore profile contains an invalid key");
    process.env[key] = value;
  }
}

async function main() {
  await loadProfileEnvironment();
  for (const key of [
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET",
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX",
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN",
  ]) assert(process.env[key], `the qualified profile includes ${key}`);
  let providerFailure = null;
  const middleware = createCapabilityIssueThreadMiddleware({
    bindHost: "127.0.0.1",
    onTurnError(error) { providerFailure = error; },
  });
  const server = createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404;
    response.end("not found");
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const jar = createCapabilityCookieJar(`http://127.0.0.1:${port}`);
  const post = async (path, body, accept) => {
    const response = await jar.fetch(`/api/capability/ui${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${await response.text()}`);
    return response;
  };
  const turn = async (sessionId, message) => {
    const response = await post("/message", { sessionId, message }, CAPABILITY_TURN_STREAM_ACCEPT);
    try {
      return await readCapabilityTurnStream(response, () => undefined);
    } catch (error) {
      if (providerFailure) throw new Error("AWS AgentCore provider turn failed", { cause: providerFailure });
      throw error;
    }
  };

  try {
    const configuration = {
      provider: "aws_agentcore",
      model: process.env.PAPERCLIP_AWS_AGENTCORE_MODEL,
      agentCoreProfileId: process.env.PAPERCLIP_AWS_AGENTCORE_PROFILE_ID,
      maxEstimatedSessionCostUsd: 1,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
    };
    const opened = await (await post("/cleanroom/session", configuration)).json();
    assert(opened.configuration?.provider === "aws_agentcore", "the AWS provider was selected without fallback");
    assert(opened.view.identity.agentLabel === "Real AWS AgentCore", "the live AWS identity is visible");
    assert(opened.runtime?.providerPid === null, "a remote provider never reports a provider PID");

    const first = await turn(opened.sessionId, "Reply with exactly: AgentCore first response");
    assert(assistantText(first.view).length > 0, "the first AWS response is nonempty");
    assert(first.runtime?.providerSessionId, "the first response carries a runtimeSessionId");

    const second = await turn(opened.sessionId, "Reply with exactly: AgentCore second response");
    assert(assistantText(second.view).length > assistantText(first.view).length, "the second AWS response is visible");
    assert(second.runtime?.providerSessionId === first.runtime.providerSessionId, "both turns reuse one AgentCore session");

    const read = await (await post("/tool", {
      sessionId: opened.sessionId,
      operationId: "get_task_context",
      input: {},
    })).json();
    assert(read.toolResult && typeof read.toolResult === "object", "the mock Paperclip read operation succeeded");

    const serialized = JSON.stringify({ opened, first, second, read });
    for (const pattern of [
      /AWS_ACCESS_KEY_ID/i,
      /AWS_SECRET_ACCESS_KEY/i,
      /AWS_SESSION_TOKEN/i,
      /X-Amz-Signature/i,
      /AWS4-HMAC-SHA256/i,
      /"Authorization"\s*:/,
      /"Proxy-Authorization"\s*:/,
    ]) {
      assert(!pattern.test(serialized), `browser payload excludes ${pattern}`);
    }
    process.stdout.write(`${JSON.stringify({
      schema: "paperclip.capability.aws-agentcore-smoke.v1",
      sessionId: opened.sessionId,
      runtimeSessionId: second.runtime.providerSessionId,
      model: configuration.model,
      turns: second.view.turns.length,
      mockRead: true,
      assertions: { realProvider: true, twoResponses: true, sessionContinuity: true, noCredentialLeak: true },
    }, null, 2)}\n`);
  } finally {
    await middleware.close();
    server.close();
  }
}

await main();
