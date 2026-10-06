export interface LocaleChange {
  key: string;
  kind: "added" | "changed" | "removed";
  previousSource: string | null;
  source: string | null;
  translations: Array<{
    key: string;
    previous: string | null;
    current: string | null;
    status: "missing" | "matches-source" | "unchanged" | "edited";
  }>;
}

export function collectLocaleChanges(options: {
  previousSource: Record<string, unknown>;
  source: Record<string, unknown>;
  previousTarget: Record<string, unknown>;
  target: Record<string, unknown>;
  locale: string;
}): LocaleChange[];

export function runLocaleChanges(args?: string[]): {
  baseCommit: string;
  locale: string;
  summary: Record<LocaleChange["kind"], number>;
  changes: LocaleChange[];
};
