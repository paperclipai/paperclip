// Launched only by the Linux CI-only test, in a fresh allowlisted environment.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dynamicToolResponse } from "../src/drivers/codex/codex-driver-values.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../src/live/runnerd-codex-transport.js";
import { closedTerminalStatus, diagnosticIdentity, diagnosticPrompt, failedIdentity } from "./opencode-identity-script.js";
if (process.platform !== "linux" || process.env.PAPERCLIP_NATIVE_PROTOCOL_DIAGNOSTIC !== "1") throw new Error("diagnostic_linux_ci_only");
const config = JSON.parse(process.argv[2]!);
const hash = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
const { transport } = createRunnerdCodexTransport({ provider: "opencode", runnerBinary: defaultCapabilityRunnerdBinary(),
  opencodePermissionMode: "deny", stateDirectory: join(config.root, "state"), sourceCodexHome: "", providerNodeCommand: config.node,
  providerNodeCommandSha256: hash(config.node), opencodeCommand: config.executable, opencodeCommandSha256: hash(config.executable),
  opencodeProxyPath: config.proxy, opencodeProxySha256: hash(config.proxy),
  environment: { PATH: process.env.PATH, PAPERCLIP_AI_PROVIDER_URL: config.providerUrl, PAPERCLIP_AI_PROVIDER_KEY: "synthetic-fixture-only" },
});
process.once("SIGTERM", () => { void transport.close().finally(() => { process.exit(1); }); });
let calls = 0;
let terminalStatus: ReturnType<typeof closedTerminalStatus> = "unknown";
transport.setServerRequestHandler(async request => {
  if (request.method !== "item/tool/call" || request.params.tool !== "get_identity"
    || JSON.stringify(request.params.arguments) !== "{}") throw new Error("diagnostic_unexpected_tool");
  calls++;
  return dynamicToolResponse(config.negative && calls === 1 ? failedIdentity : diagnosticIdentity);
});
try {
  await transport.request("thread/start", { cwd: config.root, model: "paperclip/protocol-diagnostic",
    dynamicTools: [{ name: "get_identity", description: "Read the synthetic protocol identity.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } }] });
  const done = (async () => {
    for await (const notification of transport.notifications()) {
      if (notification.method === "turn/completed") {
        terminalStatus = closedTerminalStatus(notification);
        if (terminalStatus !== "completed") throw new Error("diagnostic_terminal_not_completed");
        return;
      }
      if (notification.method === "turn/failed") throw new Error("diagnostic_turn_failed");
    }
    throw new Error("diagnostic_notifications_ended");
  })();
  await transport.request("turn/start", { input: [{ type: "text", text: diagnosticPrompt }] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("diagnostic_timeout")), 35_000); })]); }
  finally { if (timer) clearTimeout(timer); }
  await transport.close();
  process.stdout.write(`DIAGNOSTIC_RESULT ${JSON.stringify({ status: "completed", backendCalls: calls, terminalStatus })}\n`);
} catch {
  await transport.close().catch(() => {});
  process.stdout.write(`DIAGNOSTIC_RESULT ${JSON.stringify({ status: "failed", backendCalls: calls, terminalStatus })}\n`);
  process.stderr.write("diagnostic_native_failure\n"); process.exitCode = 1;
}
