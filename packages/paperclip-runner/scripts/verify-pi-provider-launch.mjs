import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Runs inside the Linux image build against the actual deployed provider pack.
// An ACP session starts the pinned Pi RPC child without making a model request.
const pack = resolve(process.argv[2]);
const { createAcpxPackageJsonResolver, verifyQualifiedAcpxInstallation } = await import(pathToFileURL(join(pack, "dist/drivers/acpx/installation-integrity.js")));
const { resolveQualifiedAcpxProfile } = await import(pathToFileURL(join(pack, "dist/drivers/acpx/qualified-profiles.js")));
const root = await mkdtemp(join(tmpdir(), "pi-qualified-launch-"));
const installation = await verifyQualifiedAcpxInstallation(
  resolveQualifiedAcpxProfile("pi", "openrouter/deepseek/deepseek-v4-flash-0731"),
  createAcpxPackageJsonResolver(pack),
);
const lease = await installation.openCommand();
const child = lease.spawn([], { cwd: root, detached: true, env: {
  HOME: root, PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: join(root, ".pi"),
  // Makes the static OpenRouter model catalog selectable; never sends a prompt.
  OPENROUTER_API_KEY: "qualification-no-model-requests",
} });
let buffer = "", stderr = "";
const pending = new Map();
child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
child.stdout.on("data", (data) => {
  buffer += data;
  assert(buffer.length < 1024 * 1024, "Provider protocol output exceeded bound");
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  }
});
const request = (id, method, params) => new Promise((resolveRequest, reject) => {
  const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 30_000);
  pending.set(id, (response) => { clearTimeout(timer); pending.delete(id); resolveRequest(response); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
try {
  const initialize = await request(1, "initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "paperclip-image-qualification", version: "1" } });
  assert.equal(initialize.error, undefined, JSON.stringify(initialize.error));
  const session = await request(2, "session/new", { cwd: root, mcpServers: [] });
  assert.equal(session.error, undefined, JSON.stringify(session.error));
  assert.equal(typeof session.result?.sessionId, "string");
  console.log("Verified Pi ACP and pinned RPC runtime started successfully");
} finally {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await lease.close();
  await rm(root, { recursive: true, force: true });
}
