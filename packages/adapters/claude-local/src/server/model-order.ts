import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * Order Claude models the way the Claude app does (#14877): the newest release of each
 * family first, by decreasing capability, then every older release grouped the same way
 * with versions descending. Ids that do not look like a Claude model keep their incoming
 * order at the end of the list, so a new naming scheme is still shown rather than dropped.
 */
const FAMILY_RANK: Readonly<Record<string, number>> = {
  fable: 0,
  mythos: 1,
  opus: 2,
  sonnet: 3,
  haiku: 4,
};

const FAMILY_PATTERN = "fable|mythos|opus|sonnet|haiku";
// Current scheme: claude-opus-4-8, claude-fable-5-1, claude-opus-5.
const MODERN_ID_RE = new RegExp(`^claude-(${FAMILY_PATTERN})-(\\d+)(?:-(\\d+))?$`);
// Legacy scheme: claude-3-7-sonnet, claude-3-5-haiku, claude-3-opus.
const LEGACY_ID_RE = new RegExp(`^claude-(\\d+)(?:-(\\d+))?-(${FAMILY_PATTERN})$`);

interface ClaudeModelKey {
  family: number;
  major: number;
  minor: number;
  /** Dated snapshot (`-20260529`) or Bedrock revision rather than the bare alias. */
  pinned: boolean;
  /** Snapshot date as YYYYMMDD, 0 when the id carries none; newer snapshots sort first. */
  snapshot: number;
}

export function parseClaudeModelId(id: string): ClaudeModelKey | null {
  let bare = id.trim().toLowerCase().replace(/\[1m\]$/, "");
  // Bedrock ids: us.anthropic.claude-opus-4-6-v1, us.anthropic.claude-sonnet-4-5-20250929-v2:0
  bare = bare.replace(/^[a-z]+\.anthropic\./, "");
  let pinned = false;
  let snapshot = 0;
  const revision = bare.match(/^(.*)-v\d+(?::\d+)?$/);
  if (revision) {
    bare = revision[1];
    pinned = true;
  }
  const dated = bare.match(/^(.*)-(\d{8})$/);
  if (dated) {
    bare = dated[1];
    pinned = true;
    snapshot = Number(dated[2]);
  }
  if (bare.endsWith("-latest")) bare = bare.slice(0, -"-latest".length);

  const modern = bare.match(MODERN_ID_RE);
  if (modern) {
    return {
      family: FAMILY_RANK[modern[1]], major: Number(modern[2]), minor: Number(modern[3] ?? 0), pinned, snapshot,
    };
  }
  const legacy = bare.match(LEGACY_ID_RE);
  if (legacy) {
    return {
      family: FAMILY_RANK[legacy[3]], major: Number(legacy[1]), minor: Number(legacy[2] ?? 0), pinned, snapshot,
    };
  }
  return null;
}

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
