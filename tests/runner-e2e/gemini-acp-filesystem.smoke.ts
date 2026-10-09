/** Opt-in installed-CLI compatibility check. No real provider credentials or inference. */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "../../packages/adapter-utils/node_modules/acpx/dist/runtime.js";

const argument = process.argv.indexOf("--agent-command");
const command = argument < 0 ? "gemini --acp" : process.argv[argument + 1];
if (!command) throw new Error("agent_command_required");
const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-filesystem-smoke-"));
const content = '{"nonce":"synthetic-file-smoke","total":28}\n';
const results: Array<{ case: string; passed: boolean; completedTools: number; failedTools: number; missingFileSignal: boolean }> = [];
let active: { calls: number; file: string; tool: string };
const server = createServer(async (request, response) => {
  // Never retain request bodies, headers, provider prompts or model output.
  for await (const _chunk of request) { /* Drain the synthetic request. */ }
  const parts = ++active.calls === 1
    ? [{ functionCall: { name: active.tool, args: { file_path: active.file, ...(active.tool === "write_file" ? { content } : {}) } } }]
    : [{ text: "synthetic-complete" }];
  const payload = {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    modelVersion: "gemini-3.1-flash-lite",
  };
  if (request.url?.includes(":streamGenerateContent")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(payload)}\n\n`);
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url?.includes(":countTokens") ? { totalTokens: 10 } : payload));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  for (const scenario of ["create-missing", "read-existing", "deny-outside"] as const) {
    const home = path.join(root, scenario, "home");
    const workspace = path.join(root, scenario, "workspace");
    await mkdir(path.join(home, ".gemini"), { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true });
    const cwd = await realpath(workspace);
    const file = scenario === "deny-outside" ? path.join(await realpath(root), "outside.json") : path.join(cwd, "proof.json");
    if (scenario !== "create-missing") await writeFile(file, content);
    await writeFile(path.join(home, ".gemini", "settings.json"), JSON.stringify({
      security: { auth: { selectedType: "gemini-api-key" } }, telemetry: { enabled: false },
    }), { mode: 0o600 });
    active = { calls: 0, file, tool: scenario === "read-existing" ? "read_file" : "write_file" };
    const runtime = createAcpRuntime({
      cwd, sessionStore: createRuntimeStore({ stateDir: path.join(root, scenario, "state") }),
      agentRegistry: createAgentRegistry({ overrides: { gemini: command } }),
      permissionMode: "approve-all", nonInteractivePermissions: "deny", inheritProcessEnv: false,
      onAgentStderr: () => { /* Child diagnostics may contain untrusted material. */ },
    });
    const handle = await runtime.ensureSession({
      sessionKey: `gemini-filesystem-${scenario}`, agent: "gemini", mode: "oneshot", cwd,
      sessionOptions: { env: {
        HOME: home, PATH: process.env.PATH ?? "", GEMINI_MODEL: "gemini-3.1-flash-lite",
        GEMINI_API_KEY: "synthetic-invalid-key", GOOGLE_GEMINI_BASE_URL: origin,
      } },
    });
    try {
      let completedTools = 0; let failedTools = 0; let missingFileSignal = false;
      for await (const event of runtime.runTurn({ handle, text: "Run the synthetic file operation, then stop.", mode: "prompt", requestId: scenario, timeoutMs: 20_000 })) {
        if (event.type !== "tool_call") continue;
        if (event.status === "completed") completedTools++;
        if (event.status === "failed") {
          failedTools++;
          missingFileSignal ||= /Error checking existing file: (?:Resource not found|Internal error)/.test(event.text ?? "");
        }
      }
      const bytes = await readFile(file, "utf8").catch(() => null);
      const passed = bytes === content && (scenario === "deny-outside" ? failedTools > 0 && completedTools === 0 : failedTools === 0 && completedTools > 0);
      results.push({ case: scenario, passed, completedTools, failedTools, missingFileSignal });
    } finally { await runtime.close({ handle, reason: "synthetic filesystem smoke complete" }); }
  }
  console.log(JSON.stringify({ realProviderCalls: 0, results }, null, 2));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
