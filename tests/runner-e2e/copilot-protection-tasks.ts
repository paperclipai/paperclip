import type { RunnerTaskFixture } from "./types.js";
import { copilotProtectionCases } from "./copilot-protection-cases.js";
import { contextOrientation } from "./copilot-active-stop-tasks.js";
export const copilotProtectionTasks: readonly RunnerTaskFixture[] = copilotProtectionCases.map(c => ({
  id: c.id, label: c.id === "native-permission-deny-write" ? "Deny one native write, then stop safely" : "Attached command settles before completion",
  groups: [], workMode: "standard", flow: "copilot_protection", expectedRunCount: 1,
  attemptTimeoutMs: { local: 300_000, daytona: 300_000 },
  expectedTerminalState: { issue: c.id === "native-permission-deny-write" ? "in_progress" : "done", run: c.id === "native-permission-deny-write" ? "cancelled" : "succeeded" },
  buildTitle: nonce => `Copilot ${c.id} ${nonce}`,
  buildVisibleMarker: nonce => `COPILOT-PROTECTION-${c.id}-${nonce}`,
  buildPrompt: nonce => c.id === "native-permission-deny-write" ? contextOrientation + c.prompt(nonce) : [
    "Run the supplied exact command once using native bash with mode async and detach false.",
    "After starting it, attempt to finish immediately without calling read_bash or another waiting tool. The attached-process runtime must settle the command before ending the turn.",
    "Do not modify fixture code, manufacture its result, or start another command.",
    "The fixture-owned marker is a private diagnostic sentinel, not a requested file deliverable. Do not publish it. Do not attach it.",
    `Call paperclip_finish with reportedWorkDisposition done, summary COPILOT-PROTECTION-${c.id}-${nonce}, current completion contract revision, satisfied objective criterion, no remaining work, evidence [], verification []. After acceptance reply with that exact summary.`,
  ].join("\n"),
  buildMatchers: () => [], // Flow grades public durable origin and independent OS/filesystem observations.
}));
