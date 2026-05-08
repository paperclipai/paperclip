import type { AdapterModel } from "../api/agents";
import { models as CLAUDE_LOCAL_MODELS } from "@paperclipai/adapter-claude-local";
import { models as CODEX_LOCAL_MODELS } from "@paperclipai/adapter-codex-local";

const claudeModelIds = new Set(CLAUDE_LOCAL_MODELS.map((model) => model.id));
const codexModelIds = new Set(CODEX_LOCAL_MODELS.map((model) => model.id));

export function filterAcpxModelsByAgent(models: AdapterModel[], acpxAgent: string): AdapterModel[] {
  if (acpxAgent === "claude") {
    return models.filter((model) => claudeModelIds.has(model.id) || model.label.startsWith("Claude: "));
  }
  if (acpxAgent === "codex") {
    return models.filter((model) => codexModelIds.has(model.id) || model.label.startsWith("Codex: "));
  }
  return [];
}
