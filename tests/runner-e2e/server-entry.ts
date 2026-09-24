// This entrypoint is used only by isolated Runner E2E instances. Production
// service code has no test flag, delay, altered prompt, or private test API.
import { ServerResponse } from "node:http";
import { PaperclipRunnerToolAuthority } from "../../server/src/services/native-runtime/paperclip-runner-tool-authority.js";
import { holdInteractionResponse } from "./interaction-response-gate.js";

const ids: string[] = JSON.parse(process.env.PAPERCLIP_RUNNER_E2E_EXECUTION_IDS ?? "[]");
if (ids.some((id) => id.endsWith(".accept-while-running"))) {
  const held = new Set<string>();
  const hold = async (value: any) => {
    const interaction = value?.interaction ?? value;
    if (!interaction?.sourceRunId || interaction.status !== "pending" ||
        !["request_confirmation", "request_checkbox_confirmation"].includes(interaction.kind) || held.has(interaction.id)) return;
    held.add(interaction.id);
    await holdInteractionResponse({
      deadlineAt: Date.now() + 90_000,
      loadStatus: async () => {
        const response = await fetch(`http://127.0.0.1:${process.env.PAPERCLIP_RUNNER_E2E_PORT}/api/issues/${interaction.issueId}/interactions`);
        if (!response.ok) throw new Error(`Approval barrier read failed: ${response.status}`);
        const rows = await response.json() as Array<{ id: string; status: string }>;
        const row = rows.find((candidate) => candidate.id === interaction.id);
        if (!row) throw new Error("Approval barrier lost its committed card");
        return row.status;
      },
    });
  };
  const execute = PaperclipRunnerToolAuthority.prototype.execute;
  PaperclipRunnerToolAuthority.prototype.execute = async function (...args) {
    const result = await execute.apply(this, args);
    if (args[0].tool === "request_human_input") await hold(result);
    return result;
  };
  const end = ServerResponse.prototype.end;
  ServerResponse.prototype.end = function (this: ServerResponse, ...args: any[]) {
    const body = args[0];
    let interaction: any;
    if (this.req.method === "POST" && /\/interactions(?:\?|$)/.test(this.req.url ?? "") &&
        this.statusCode >= 200 && this.statusCode < 300 && (typeof body === "string" || Buffer.isBuffer(body))) {
      try { interaction = JSON.parse(body.toString()); } catch { /* non-JSON response */ }
    }
    if (interaction?.sourceRunId && ["request_confirmation", "request_checkbox_confirmation"].includes(interaction.kind)) {
      void hold(interaction).then(() => Reflect.apply(end, this, args), (error) => this.destroy(error));
      return this;
    }
    return Reflect.apply(end, this, args);
  } as typeof end;
}
await import("../../cli/src/index.js");
