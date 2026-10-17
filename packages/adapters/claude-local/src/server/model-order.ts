import type { AdapterModel } from "@paperclipai/adapter-utils";
import { parseClaudeModelId, type ClaudeModelKey } from "../model-id.js";

export { parseClaudeModelId };

/**
 * Order Claude models the way the Claude app does (#14877): the newest release of each
 * family first, by decreasing capability, then every older release grouped the same way
 * with versions descending. Ids that do not look like a Claude model keep their incoming
 * order at the end of the list, so a new naming scheme is still shown rather than dropped.
 */

function compareVersions(a: ClaudeModelKey, b: ClaudeModelKey): number {
  return a.major - b.major || a.minor - b.minor;
}

export function sortClaudeModels(models: AdapterModel[]): AdapterModel[] {
  const keyed = models.map((model, index) => ({ model, index, key: parseClaudeModelId(model.id) }));

  const newestByFamily = new Map<number, ClaudeModelKey>();
  for (const { key } of keyed) {
    if (!key) continue;
    const newest = newestByFamily.get(key.family);
    if (!newest || compareVersions(key, newest) > 0) newestByFamily.set(key.family, key);
  }
  // 0: newest release of its family, 1: older release, 2: not a recognizable Claude id.
  const section = (key: ClaudeModelKey | null): number => {
    if (!key) return 2;
    return compareVersions(key, newestByFamily.get(key.family)!) === 0 ? 0 : 1;
  };

  return keyed
    .sort((a, b) => {
      const bySection = section(a.key) - section(b.key);
      if (bySection !== 0) return bySection;
      if (a.key && b.key) {
        return (
          a.key.family - b.key.family
          || compareVersions(b.key, a.key)
          || Number(a.key.pinned) - Number(b.key.pinned)
          || b.key.snapshot - a.key.snapshot
          || a.index - b.index
        );
      }
      return a.index - b.index;
    })
    .map((entry) => entry.model);
}
