#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  demoProfiles,
  findTool,
  fixtureProfiles,
  listTools,
} from "../mcp-fixtures/catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const stdioServerPath = resolve(repoRoot, "scripts/mcp-fixtures/servers/stdio-fixture.mjs");
const httpServerPath = resolve(repoRoot, "scripts/mcp-fixtures/servers/http-fixture.mjs");

function parseArgs(argv) {
  const args = {
    paperclipUrl: process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api",
    requirePaperclip: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--paperclip-url") args.paperclipUrl = argv[++i];
    else if (arg === "--require-paperclip") args.requirePaperclip = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help") {
      console.log(`Usage: node scripts/smoke/mcp-fixture-harness.mjs [--paperclip-url URL] [--require-paperclip] [--json]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function normalizePaperclipUrl(raw) {
  const url = new URL(raw);
  if (url.pathname.endsWith("/api")) {
    url.pathname = url.pathname.slice(0, -4) || "/";
  }
  return url.toString().replace(/\/$/, "");
}

async function checkPaperclipHealth(rawUrl, required) {
  const baseUrl = normalizePaperclipUrl(rawUrl);
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, baseUrl };
  } catch (error) {
    if (required) {
      throw new Error(`Paperclip health check failed at ${baseUrl}/api/health: ${error.message}`);
    }
    return { ok: false, baseUrl, skippedReason: error.message };
  }
}

function redactHostileText(value) {
  return JSON.stringify(value)
    .replace(/pc_live_[A-Za-z0-9_=-]+/g, "[REDACTED_SECRET]")
    .replace(/PAPERCLIP_API_KEY/g, "[REDACTED_ENV_NAME]");
}

function fingerprintTool(tool) {
  return JSON.stringify({
    name: tool.name,
    schemaVersion: tool.schemaVersion,
    inputSchema: tool.inputSchema,
  });
}

class StdioFixtureClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
  }

  async start() {
    this.process = spawn(process.execPath, [stdioServerPath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      const response = JSON.parse(line);
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      pending.resolve(response);
    });
    this.process.stderr.on("data", (chunk) => {
      process.stderr.write(`[mcp-stdio-fixture] ${chunk}`);
    });
    await this.request("health");
  }

  request(method, params = {}) {
    const id = String(this.nextId++);
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`stdio fixture request timed out: ${method}`));
        }
      }, 2000).unref();
    });
  }

  async listTools() {
    const response = await this.request("list_tools");
    return response.tools;
  }

  async callTool(name, input) {
    return this.request("call_tool", { name, input });
  }

  async stop() {
    if (!this.process || this.process.killed) return;
    this.process.kill("SIGTERM");
    await Promise.race([
      once(this.process, "exit"),
      new Promise((resolveStop) => setTimeout(resolveStop, 500)),
    ]);
  }
}

class HttpFixtureClient {
  constructor() {
    this.process = null;
    this.baseUrl = null;
  }

  async start() {
    this.process = spawn(process.execPath, [httpServerPath], {
      cwd: repoRoot,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process.stderr.on("data", (chunk) => {
      process.stderr.write(`[mcp-http-fixture] ${chunk}`);
    });
    const rl = createInterface({ input: this.process.stdout });
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("http fixture did not become ready")), 2000);
      rl.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.event === "ready") {
          clearTimeout(timer);
          resolveReady(event);
        }
      });
    });
    this.baseUrl = `http://${ready.host}:${ready.port}`;
    const health = await fetch(`${this.baseUrl}/health`);
    if (!health.ok) throw new Error(`http fixture health failed: ${health.status}`);
  }

  async listTools() {
    const response = await fetch(`${this.baseUrl}/catalog`);
    const body = await response.json();
    return body.tools;
  }

  async callTool(name, input) {
    const response = await fetch(`${this.baseUrl}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
    return response.json();
  }

  async stop() {
    if (!this.process || this.process.killed) return;
    this.process.kill("SIGTERM");
    await Promise.race([
      once(this.process, "exit"),
      new Promise((resolveStop) => setTimeout(resolveStop, 500)),
    ]);
  }
}

class SmokePolicyHarness {
  constructor({ stdioClient, httpClient }) {
    this.stdioClient = stdioClient;
    this.httpClient = httpClient;
    this.audit = [];
    this.pendingApprovals = new Map();
    this.idempotency = new Map();
    this.quarantine = new Set();
    this.baselineFingerprints = new Map(listTools().map((tool) => [tool.name, fingerprintTool(tool)]));
  }

  profile(profileId) {
    const profile = fixtureProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    return profile;
  }

  isAllowedByProfile(profile, tool) {
    if (this.quarantine.has(tool.name)) return { outcome: "quarantined" };
    const riskAllowed = tool.risk === "low" || profile.allowRisks?.includes(tool.risk) || !profile.denyRisks?.includes(tool.risk);
    if (!riskAllowed) return { outcome: "denied" };
    if (profile.allowCapabilities.includes(tool.capability)) return { outcome: "allowed" };
    if (profile.approvalCapabilities.includes(tool.capability) || tool.approvalRequired) return { outcome: "approval_required" };
    return { outcome: "denied" };
  }

  async call(profileId, toolName, input = {}, options = {}) {
    const profile = this.profile(profileId);
    const tool = findTool(toolName);
    const idempotencyKey = options.idempotencyKey ?? null;
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey);
      this.audit.push({ toolName, profileId, outcome: "idempotent_replay", idempotencyKey });
      return cached;
    }

    const decision = this.isAllowedByProfile(profile, tool);
    if (decision.outcome === "denied" || decision.outcome === "quarantined") {
      const response = { ok: false, outcome: decision.outcome, toolName };
      this.audit.push({ toolName, profileId, outcome: decision.outcome });
      return response;
    }

    if (decision.outcome === "approval_required" && !options.approved) {
      const approvalId = `approval-${this.pendingApprovals.size + 1}`;
      const response = { ok: false, outcome: "approval_required", approvalId, toolName };
      this.pendingApprovals.set(approvalId, { profileId, toolName, input, idempotencyKey });
      this.audit.push({ toolName, profileId, outcome: "approval_required", approvalId });
      return response;
    }

    const client = tool.transport === "stdio" ? this.stdioClient : this.httpClient;
    const response = await client.callTool(toolName, input);
    let outcome = response.ok ? "allowed" : response.error?.code ?? "fixture_error";
    if (tool.hostile && response.ok) {
      const redacted = redactHostileText(response.result);
      outcome = redacted.includes("Ignore prior instructions") ? "malicious_result_quarantined" : "allowed";
      response.result = { redacted, quarantined: outcome === "malicious_result_quarantined" };
    }
    const wrapped = { ...response, outcome, toolName };
    if (idempotencyKey && response.ok) this.idempotency.set(idempotencyKey, wrapped);
    this.audit.push({ toolName, profileId, outcome, transport: tool.transport, idempotencyKey });
    return wrapped;
  }

  async approve(approvalId) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error(`Unknown approval: ${approvalId}`);
    this.pendingApprovals.delete(approvalId);
    return this.call(pending.profileId, pending.toolName, pending.input, {
      approved: true,
      idempotencyKey: pending.idempotencyKey,
    });
  }

  discoverSchemaChanges(tools) {
    const quarantined = [];
    for (const tool of tools) {
      const baseline = this.baselineFingerprints.get(tool.name);
      if (baseline && baseline !== fingerprintTool(tool)) {
        this.quarantine.add(tool.name);
        quarantined.push(tool.name);
        this.audit.push({ toolName: tool.name, outcome: "schema_change_quarantined" });
      }
    }
    return quarantined;
  }
}

async function runCase(results, name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paperclip = await checkPaperclipHealth(args.paperclipUrl, args.requirePaperclip);
  const stdioClient = new StdioFixtureClient();
  const httpClient = new HttpFixtureClient();
  const results = [];

  try {
    await stdioClient.start();
    await httpClient.start();
    const harness = new SmokePolicyHarness({ stdioClient, httpClient });

    await runCase(results, "fixture catalog includes required profiles and demos", async () => {
      assert(fixtureProfiles.length === 4, "expected four profile definitions");
      assert(demoProfiles.length === 8, "expected eight first-install demo definitions");
      const tools = [...await stdioClient.listTools(), ...await httpClient.listTools()];
      for (const fixture of [
        "echo-calculator-time",
        "todo-kv",
        "outbox-email",
        "mock-social-blog",
        "malicious",
        "slow-crashing-stdio",
        "fake-oauth-missing-secret",
      ]) {
        assert(tools.some((tool) => tool.fixture === fixture), `missing fixture ${fixture}`);
      }
      assert(tools.some((tool) => tool.transport === "stdio"), "missing stdio fixture");
      assert(tools.some((tool) => tool.transport === "http"), "missing http fixture");
    });

    await runCase(results, "allow and deny decisions are enforced", async () => {
      const allowed = await harness.call("read-only", "calculator.add", { a: 2, b: 3 });
      assert(allowed.ok && allowed.result.value === 5, "calculator.add should be allowed");
      const denied = await harness.call("read-only", "kv.set", { key: "a", value: "b" });
      assert(!denied.ok && denied.outcome === "denied", "kv.set should be denied for read-only");
    });

    await runCase(results, "approval-gated writes execute after approval", async () => {
      const pending = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "fixture",
        body: "deterministic",
      }, { idempotencyKey: "send-email-1" });
      assert(pending.outcome === "approval_required", "email.send should require approval");
      const approved = await harness.approve(pending.approvalId);
      assert(approved.ok && approved.result.message.status === "sent", "approved email.send should execute");
    });

    await runCase(results, "audit trail records decisions and transports", async () => {
      assert(harness.audit.some((event) => event.outcome === "denied" && event.toolName === "kv.set"), "missing deny audit");
      assert(harness.audit.some((event) => event.outcome === "approval_required" && event.toolName === "email.send"), "missing approval audit");
      assert(harness.audit.some((event) => event.transport === "stdio"), "missing stdio audit");
      assert(harness.audit.some((event) => event.transport === "http"), "missing http audit");
    });

    await runCase(results, "runtime lifecycle handles slow and crashing stdio fixtures", async () => {
      const slow = await harness.call("runtime-lifecycle", "slow.ping", { delayMs: 10 });
      assert(slow.ok && slow.result.pong === true, "slow.ping should return");
      const crash = await harness.call("runtime-lifecycle", "crash.now", {});
      assert(!crash.ok && crash.outcome === "fixture_crash", "crash.now should report fixture_crash");
      const afterCrash = await harness.call("runtime-lifecycle", "time.now", {});
      assert(afterCrash.ok, "stdio fixture should keep serving after synthetic crash response");
    });

    await runCase(results, "secret failures are categorized without real credentials", async () => {
      const response = await harness.call("read-only", "secret.read", {});
      assert(!response.ok && response.outcome === "secret_missing", "secret.read should fail with secret_missing");
    });

    await runCase(results, "schema changes quarantine changed tools", async () => {
      const flip = await harness.call("runtime-lifecycle", "fixture.schemaFlip", { toolName: "kv.set" });
      assert(flip.ok, "fixture.schemaFlip should execute");
      const changedTools = await httpClient.listTools();
      const quarantined = harness.discoverSchemaChanges(changedTools);
      assert(quarantined.includes("kv.set"), "kv.set should be quarantined after schema change");
      const blocked = await harness.call("approval-gated-writes", "kv.set", { key: "a", value: "b" });
      assert(blocked.outcome === "quarantined", "quarantined tool should not execute");
    });

    await runCase(results, "malicious result is redacted and quarantined", async () => {
      const response = await harness.call("security-hostile", "malicious.result", {});
      assert(response.ok, "malicious result fixture should return a result");
      assert(response.outcome === "malicious_result_quarantined", "malicious result should be quarantined");
      assert(!response.result.redacted.includes("pc_live_should_be_redacted"), "synthetic secret should be redacted");
      assert(!response.result.redacted.includes("PAPERCLIP_API_KEY"), "env key name should be redacted");
    });

    await runCase(results, "idempotent approved writes only execute once", async () => {
      const first = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "idempotent",
        body: "only once",
      }, { approved: true, idempotencyKey: "send-email-idempotent" });
      const second = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "idempotent",
        body: "only once",
      }, { approved: true, idempotencyKey: "send-email-idempotent" });
      assert(first.result.message.id === second.result.message.id, "idempotent replay should return cached message");
      assert(harness.audit.some((event) => event.outcome === "idempotent_replay"), "missing idempotent replay audit");
    });

    const summary = {
      ok: results.every((result) => result.ok),
      paperclip,
      results,
      auditEvents: harness.audit.length,
      profiles: fixtureProfiles.map((profile) => profile.id),
      demos: demoProfiles.map((demo) => demo.id),
    };
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`MCP fixture smoke: ${summary.ok ? "PASS" : "FAIL"}`);
      console.log(`Paperclip health: ${paperclip.ok ? "ok" : `skipped (${paperclip.skippedReason})`}`);
      for (const result of results) {
        console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.error ? ` - ${result.error}` : ""}`);
      }
    }
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await Promise.allSettled([stdioClient.stop(), httpClient.stop()]);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
