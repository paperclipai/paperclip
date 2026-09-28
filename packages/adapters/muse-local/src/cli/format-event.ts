import pc from "picocolors";
import { decodeMuseRecord } from "../shared/records.js";

export function printMuseStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const record = decodeMuseRecord(line);
  if (!record) {
    console.log(line);
    return;
  }
  const { payload } = record;
  const text = typeof payload.text === "string" ? payload.text : "";
  if (payload.kind === "run_terminal") {
    const terminal = String(payload.terminal ?? "unknown");
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    console.log(terminal === "completed" ? pc.blue("Muse run completed") : pc.red(`Muse run ${terminal}${reason ? `: ${reason}` : ""}`));
    return;
  }
  switch (record.payloadType) {
    case "run.model.configured":
      console.log(pc.blue(`Muse model: ${String(payload.model_id ?? "")} (session ${record.streamId ?? "?"})`));
      return;
    case "run.output.delta":
      if (text) console.log(pc.green(`assistant: ${text}`));
      return;
    case "tool.result":
      console.log(pc.gray(`tool result (${String(payload.call_id ?? "")}): ${text.slice(0, 400)}`));
      return;
    default:
      if (debug && record.payloadType !== "turn.input.user") console.log(pc.gray(`event: ${record.payloadType}`));
  }
}
