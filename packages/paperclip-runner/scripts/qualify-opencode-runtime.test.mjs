// Opt-in qualification of the installed CLI, not the fake protocol server.
// PAPERCLIP_OPENCODE_QUALIFY=1 node --test scripts/qualify-opencode-runtime.test.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const enabled = process.env.PAPERCLIP_OPENCODE_QUALIFY === "1";
const packageRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

test("the pinned OpenCode executable serves health, sessions, SSE, and a local-provider prompt", {
  skip: !enabled,
  timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-qualification-"));
  let provider;
  let child;
  let exited;
  const streamAbort = new AbortController();
  const killGroup = (signal) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  t.after(async () => {
    streamAbort.abort();
    if (child?.pid) {
      killGroup("SIGTERM");
      const kill = setTimeout(() => killGroup("SIGKILL"), 3000);
      try { await exited; } finally { clearTimeout(kill); killGroup("SIGKILL"); }
    }
    if (provider) { provider.closeAllConnections(); await new Promise((done) => provider.close(done)); }
    await rm(root, { recursive: true, force: true });
  });
  const command = resolve(process.env.PAPERCLIP_TEST_OPENCODE_BINARY ?? join(packageRoot, "node_modules/opencode-ai/bin/opencode.exe"));
  assert.equal(execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(), manifest.dependencies["opencode-ai"]);
  const requests = [];
  provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requests.push({ path: request.url, body });
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [
      [{ role: "assistant", content: "paperclip-opencode-qualified" }, null],
      [{}, "stop"],
    ]) {
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-qualification", object: "chat.completion.chunk", created: 1, model: "qualification", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const config = join(root, "opencode.json");
  await writeFile(config, JSON.stringify({
    model: "openrouter/qualification",
    small_model: "openrouter/qualification",
    share: "disabled", autoupdate: false, plugin: [],
    enabled_providers: ["openrouter"],
    provider: { openrouter: { options: { baseURL: providerUrl, apiKey: "local-fixture-only" }, models: { qualification: { name: "qualification", limit: { context: 10000, output: 1000 } } } } },
    permission: { "*": "deny" },
  }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG: config,
      OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_SERVER_USERNAME: "paperclip", OPENCODE_SERVER_PASSWORD: "local-fixture-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-16384); });
  exited = once(child, "exit");
  let baseUrl;
  for (let attempt = 0; attempt < 150; attempt++) {
    baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (baseUrl) break;
    assert.equal(child.exitCode, null, output);
    await delay(100);
  }
  assert.ok(baseUrl, `OpenCode did not start: ${output}`);
  const headers = { Authorization: `Basic ${Buffer.from("paperclip:local-fixture-only").toString("base64")}`, "Content-Type": "application/json" };
  const api = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(15_000), ...options });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return response;
  };
  const health = await (await api("/global/health")).json();
  assert.deepEqual(health, { healthy: true, version: manifest.dependencies["opencode-ai"] });
  const session = await (await api("/session", { method: "POST", body: JSON.stringify({ title: "Runtime qualification" }) })).json();
  assert.equal((await (await api(`/session/${session.id}`)).json()).id, session.id);
  const stream = await fetch(`${baseUrl}/event`, { headers, signal: streamAbort.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  const reader = stream.body.getReader();
  const events = [];
  const readEvents = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) { if (!streamAbort.signal.aborted) throw error; }
  })();
  const prompt = await api(`/session/${session.id}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ model: { providerID: "openrouter", modelID: "qualification" }, parts: [{ type: "text", text: "Reply with the qualification marker." }] }),
  });
  assert.equal(prompt.status, 204);
  let messages;
  for (let attempt = 0; attempt < 150; attempt++) {
    messages = await (await api(`/session/${session.id}/message`)).json();
    if (messages.some((message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text === "paperclip-opencode-qualified"))) break;
    await delay(100);
  }
  assert.ok(messages.some((message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text === "paperclip-opencode-qualified")), JSON.stringify(messages));
  assert.ok(requests.some((request) => request.path === "/v1/chat/completions" && request.body.model === "qualification"));
  assert.ok(events.some((event) => event.type === "message.part.updated" || event.type === "message.part.delta"));
  streamAbort.abort();
  await readEvents;
  assert.equal((await api(`/session/${session.id}`, { method: "DELETE" })).status, 200);
});
