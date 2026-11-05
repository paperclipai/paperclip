// Synthetic provider boundary for the real sidecar's pipe-pressure test.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export class AcpxRuntimeHost {
  static async open(options) {
    const host = new AcpxRuntimeHost(options);
    await once(host.provider, "message");
    writeFileSync(join(process.env.PAPERCLIP_TEST_OUTPUT_ROOT, "provider-pid"), String(host.provider.pid));
    return host;
  }

  constructor(options) {
    this.options = options;
    this.closed = false;
    this.closeCount = 0;
    this.provider = spawn(process.execPath, ["-e", `
      process.on("SIGTERM", () => process.exit(0));
      process.send("ready");
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH } });
    this.result = new Promise(resolve => { this.settle = resolve; });
  }

  binding() {
    return { normalizedSessionId: this.options.normalizedSessionId,
      commandDigest: `sha256:${"a".repeat(64)}`, profileDigest: `sha256:${"b".repeat(64)}`,
      workspaceDigest: `sha256:${"c".repeat(64)}`, requestedModel: this.options.model,
      effectiveModel: this.options.model, permissionMode: this.options.permissionMode };
  }

  identity() {
    const { commandDigest: _command, ...binding } = this.binding();
    return { schema: "paperclip.runner.acpx-identity.v2", ...binding,
      acpxRecordId: "blocked-output-record", backendSessionId: "blocked-output-backend",
      agentSessionId: "blocked-output-agent", providerLifetimeFenceCandidates: [49152, 49153, 49154] };
  }

  async status() { return {}; }
  goalCapability() { return null; }
  steeringCapability() { return null; }

  startTurn({ requestId }) {
    const host = this;
    return { requestId, promptStarted: Promise.resolve(), result: this.result,
      events: (async function* () {
        for (let index = 0; index < 4096 && !host.closed; index++) {
          yield { type: "text_delta", text: `blocked-${index}:${"x".repeat(4096)}` };
        }
      })() };
  }

  async close({ reason }) {
    this.closeCount++;
    this.closed = true;
    const bufferedBytes = process.stdout.writableLength;
    const exited = once(this.provider, "exit");
    this.provider.kill("SIGTERM");
    const [code, signal] = await exited;
    this.settle({ status: "cancelled" });
    writeFileSync(join(process.env.PAPERCLIP_TEST_OUTPUT_ROOT, "provider-cleanup.json"),
      JSON.stringify({ reason, bufferedBytes, closeCount: this.closeCount, pid: this.provider.pid, code, signal }));
  }
}
