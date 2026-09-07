import { i18n, t } from "@/i18n";
import { taskChatDisplayLabel } from "./task-chat-display";

// Only the finite grammar emitted by transcript-adapter.ts:phaseSummary.
// Do not use this parser for provider summaries, tool output, or user messages.
const PHRASES: ReadonlyArray<{
  singular: string;
  plural: RegExp;
  key: string;
  reuseSingle?: boolean;
}> = [
  { singular: "Read a file", plural: /^Read ([1-9]\d*) files$/, key: "readFiles", reuseSingle: true },
  { singular: "Edited a file", plural: /^Edited ([1-9]\d*) files$/, key: "editedFiles", reuseSingle: true },
  { singular: "Ran a command", plural: /^Ran ([1-9]\d*) commands$/, key: "commands", reuseSingle: true },
  { singular: "Searched once", plural: /^Searched ([1-9]\d*) times$/, key: "searches" },
  { singular: "Used a tool", plural: /^Used ([1-9]\d*) tools$/, key: "tools" },
  { singular: "Updated the plan", plural: /^Updated ([1-9]\d*) plans$/, key: "plans", reuseSingle: true },
  { singular: "Used a subagent", plural: /^Used ([1-9]\d*) subagents$/, key: "subagents" },
  { singular: "Updated the model", plural: /^Updated the model ([1-9]\d*) times$/, key: "modelUpdates" },
  { singular: "Compacted context", plural: /^Compacted context ([1-9]\d*) times$/, key: "contextCompactions", reuseSingle: true },
  { singular: "Handled an artifact", plural: /^Handled ([1-9]\d*) artifacts$/, key: "artifacts" },
  { singular: "Changed review mode", plural: /^Changed review mode ([1-9]\d*) times$/, key: "reviewChanges" },
  { singular: "Ran a hook", plural: /^Ran ([1-9]\d*) hooks$/, key: "hooks", reuseSingle: true },
  { singular: "Referenced memory", plural: /^Referenced memory ([1-9]\d*) times$/, key: "memoryLookups", reuseSingle: true },
  { singular: "Ran a safety review", plural: /^Ran ([1-9]\d*) safety reviews$/, key: "safetyReviews" },
  { singular: "Sent terminal input", plural: /^Sent terminal input ([1-9]\d*) times$/, key: "terminalInputs", reuseSingle: true },
  { singular: "Waited", plural: /^Waited ([1-9]\d*) times$/, key: "waits" },
  { singular: "Received a provider notice", plural: /^Received ([1-9]\d*) provider notices$/, key: "providerNotices" },
  { singular: "Searched available tools", plural: /^Searched available tools ([1-9]\d*) times$/, key: "toolSearches", reuseSingle: true },
  { singular: "Read from Paperclip", plural: /^Read from Paperclip ([1-9]\d*) times$/, key: "paperclipReads" },
  { singular: "Used Paperclip", plural: /^Used Paperclip ([1-9]\d*) times$/, key: "paperclipUses" },
  { singular: "Changed a file", plural: /^Changed ([1-9]\d*) files$/, key: "changedFiles" },
];

const MARKER_LABELS = new Set([
  "Run interrupted", "Interrupted", "Run failed", "Run timed out",
  "Run cancelled", "Interrupted by board", "Paused by board", "Stopped",
]);

function safeCount(raw: string, minimum: number): number | null {
  const count = Number(raw);
  return Number.isSafeInteger(count) && count >= minimum ? count : null;
}

function phraseDisplay(value: string): string | null {
  for (const rule of PHRASES) {
    if (value === rule.singular) {
      return rule.reuseSingle
        ? taskChatDisplayLabel(value)
        : t(`localizationPhaseSummary.${rule.key}`, { count: 1 });
    }
    const match = rule.plural.exec(value);
    if (!match) continue;
    const count = safeCount(match[1]!, 2);
    return count === null ? null : t(`localizationPhaseSummary.${rule.key}`, { count });
  }
  return null;
}

/** Translate a generated phase summary without rewriting its canonical model. */
export function taskChatPhaseSummaryDisplay(value: string, origin: "generated" | "marker" = "generated"): string {
  if (!i18n.resolvedLanguage?.startsWith("ru")) return value;
  // phaseSummary may return an interruption label verbatim. A custom label
  // that happens to resemble a generated counter must still remain raw.
  if (origin === "marker") return MARKER_LABELS.has(value) ? taskChatDisplayLabel(value) : value;
  if (value === "Runner activity") return t("localizationPhaseSummary.runnerActivity");
  if (value === "Reasoning") return t("localizationTaskRuntime.ui_Reasoning_13g72ef");
  if (value === "No tool activity") return t("localizationPhaseSummary.noToolActivity");
  if (MARKER_LABELS.has(value)) return taskChatDisplayLabel(value);

  const runner = /^([1-9]\d*) runner updates$/.exec(value);
  if (runner) {
    const count = safeCount(runner[1]!, 2);
    return count === null ? value : t("localizationPhaseSummary.runnerUpdates", { count });
  }

  const parts = value.split(", ");
  if (parts.length > 4) return value;
  const more = parts.length === 4 ? /^\+([1-9]\d*) more$/.exec(parts[3]!) : null;
  if (parts.length === 4 && !more) return value;
  const hidden = more ? safeCount(more[1]!, 1) : null;
  if (more && hidden === null) return value;

  const translated: string[] = [];
  const visible = more ? parts.slice(0, 3) : parts;
  for (const [index, part] of visible.entries()) {
    // The generator lowercases only the first letter of subsequent phrases.
    if (index > 0 && !/^[a-z]/.test(part)) return value;
    const canonical = index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1);
    const label = phraseDisplay(canonical);
    if (label === null) return value; // Unknown grammar stays intact, not half-translated.
    // Do not lowercase protected names such as Paperclip at a phrase boundary.
    translated.push(index === 0 ? label : label.replace(/^[А-ЯЁ]/, (letter) => letter.toLowerCase()));
  }
  if (hidden !== null) translated.push(t("localizationPhaseSummary.more", { count: hidden }));
  return translated.join(", ");
}
