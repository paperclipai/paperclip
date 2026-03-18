export interface IssueVisibilityAction {
  isHidden: boolean;
  label: string;
  hiddenAt: string | null;
}

export function getIssueVisibilityAction(
  hiddenAt: Date | string | null | undefined,
  now: () => string = () => new Date().toISOString(),
): IssueVisibilityAction {
  const isHidden = Boolean(hiddenAt);
  return {
    isHidden,
    label: isHidden ? "Unhide this Issue" : "Hide this Issue",
    hiddenAt: isHidden ? null : now(),
  };
}
