import type { RunnerTaskFixture } from "./types.js";

export const piControlTasks: readonly RunnerTaskFixture[] = ["pending-permission-stop", "same-turn-steering"].map(id => ({
  id, label: id === "pending-permission-stop" ? "Stop Pi while permission is unanswered" : "Steer Pi through a pending native write",
  groups: [], workMode: "standard", flow: "pi_controls", expectedRunCount: 1,
  attemptTimeoutMs: { local: 300_000, daytona: 300_000 }, turnTimeoutMs: 120_000,
  expectedTerminalState: id === "pending-permission-stop" ? { issue: "in_progress", run: "cancelled" } : { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Pi ${id} ${nonce}`,
  buildVisibleMarker: nonce => `PI-CONTROL-${nonce}`,
  buildPrompt: () => [
    "Attempt the supplied native write exactly once and wait for its actual permission decision. Do not retry, answer your own permission, use bash, or use another path/tool to work around it.",
    id === "pending-permission-stop"
      ? "The operator will stop this unfinished task while permission remains unanswered. Do not finish or claim completion."
      : "The operator will send a same-turn instruction while this permission is pending, then deny the write. After the actual denial, follow that new instruction. Denial is the expected result. Never claim that the file was written. Do not finish before receiving that instruction.",
  ].join("\n"),
  buildMatchers: () => [], // Dedicated flow joins public control receipts and independent retirement evidence.
}));
