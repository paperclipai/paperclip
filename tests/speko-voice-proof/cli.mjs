import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createProof, createProofServer, PROOF_PROMPT, toolDefinitions } from "./proof.mjs";

// This probe is intentionally outside the app. Credentials never enter a
// browser bundle, repository fixture, or printed provider response.
const statePath = resolve(process.env.SPEKO_PROOF_STATE ?? `${homedir()}/.paperclip/speko-proof/state.json`);
const save = async (state) => writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
async function api(path, body) {
  const key = process.env.SPEKO_API_KEY ?? process.env.SPEKO_MCP_API_KEY;
  if (!key) throw new Error("Set SPEKO_API_KEY or SPEKO_MCP_API_KEY in the server environment");
  const response = await fetch(`https://api.speko.dev${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  // No automatic mutation retry: an uncertain creation must be reconciled.
  if (!response.ok) throw new Error(`Speko ${body ? "POST" : "GET"} ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const command = process.argv[2];
  if (command === "init") {
    await mkdir(resolve(statePath, ".."), { recursive: true, mode: 0o700 });
    const state = { signingSecret: `whsec_${randomBytes(32).toString("base64")}`, createdAt: new Date().toISOString(), toolIds: {} };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log("Initialized private proof state. No provider calls made.");
    return;
  }
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (command === "provision") {
    const definitions = toolDefinitions(process.env.SPEKO_PROOF_PUBLIC_ORIGIN);
    if (state.pendingMutation) throw new Error("A previous provider mutation has an uncertain outcome. Inspect the dedicated proof agent in Speko before clearing pendingMutation in private state.");
    if (!state.agentId) {
      state.pendingMutation = "create_agent";
      await save(state);
      const agent = await api("/v1/agents", {
        name: "Paperclip delayed voice proof",
        systemPrompt: PROOF_PROMPT,
        firstMessage: "This is a synthetic Paperclip test. Say start the test when you are ready.",
        intent: { language: "en-US", optimizeFor: "latency" },
        runMode: "cascade",
      });
      if (typeof agent.id !== "string") throw new Error("Unexpected agent response; reconcile creation in Speko");
      state.agentId = agent.id;
      delete state.pendingMutation;
      await save(state);
    }
    for (const definition of definitions) {
      if (state.toolIds[definition.name]) continue;
      state.pendingMutation = `create_tool:${definition.name}`;
      await save(state);
      const tool = await api(`/v1/agents/${encodeURIComponent(state.agentId)}/tools`, {
        ...definition, source: { ...definition.source, secret: state.signingSecret },
      });
      if (typeof tool.id !== "string") throw new Error("Unexpected tool response; reconcile creation in Speko");
      state.toolIds[definition.name] = tool.id;
      delete state.pendingMutation;
      await save(state);
    }
    state.publicOrigin = process.env.SPEKO_PROOF_PUBLIC_ORIGIN;
    await save(state);
    console.log(JSON.stringify({ agentId: state.agentId, tools: Object.keys(state.toolIds), liveQualification: "not_established" }));
    return;
  }
  if (command === "serve") {
    const port = Number(process.env.SPEKO_PROOF_PORT ?? 3198);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid SPEKO_PROOF_PORT");
    const proof = createProof({ signingSecret: state.signingSecret, onEvent: (event) => console.log(JSON.stringify(event)) });
    const server = createProofServer(proof);
    server.listen(port, "127.0.0.1", () => console.log(`Synthetic probe listening on 127.0.0.1:${port}; expires after 15 minutes`));
    const stop = async () => {
      proof.close();
      server.close();
      server.closeAllConnections();
      await writeFile(resolve(statePath, "../evidence.json"), `${JSON.stringify(proof.evidence(), null, 2)}\n`, { mode: 0o600 });
    };
    const expiry = setTimeout(() => { void stop(); }, 15 * 60_000);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { clearTimeout(expiry); void stop(); });
    return;
  }
  throw new Error("Usage: node cli.mjs init|provision|serve");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
