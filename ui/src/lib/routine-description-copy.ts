/**
 * Markdown copied from a routine Overview heading.
 * While the description editor is open, copy the draft. Otherwise copy the
 * saved description so it can be pasted into a routine on another instance.
 */
export function routineOverviewCopyText(input: {
  editing: boolean;
  draft: string;
  saved: string | null | undefined;
}): string {
  return input.editing ? input.draft : input.saved ?? "";
}
