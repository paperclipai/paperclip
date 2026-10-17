/**
 * Pure Claude model-id parsing, shared by the client-bundled `index.ts`
 * (reasoning-effort lookup) and the server-only `server/model-order.ts`
 * (picker sort order). No Node-only imports: safe in a browser bundle.
 */
export const CLAUDE_FAMILY_RANK: Readonly<Record<string, number>> = {
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

export interface ClaudeModelKey {
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
      family: CLAUDE_FAMILY_RANK[modern[1]], major: Number(modern[2]), minor: Number(modern[3] ?? 0), pinned, snapshot,
    };
  }
  const legacy = bare.match(LEGACY_ID_RE);
  if (legacy) {
    return {
      family: CLAUDE_FAMILY_RANK[legacy[3]], major: Number(legacy[1]), minor: Number(legacy[2] ?? 0), pinned, snapshot,
    };
  }
  return null;
}

/** True when two keys name the same release (family + major + minor), ignoring snapshot/pin. */
export function sameClaudeModelRelease(a: ClaudeModelKey, b: ClaudeModelKey): boolean {
  return a.family === b.family && a.major === b.major && a.minor === b.minor;
}
