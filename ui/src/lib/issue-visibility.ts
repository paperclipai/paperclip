export interface IssueVisibilityAction {
  isHidden: boolean;
  label: string;
}

export function getIssueVisibilityAction(hiddenAt: Date | string | null | undefined): IssueVisibilityAction {
  const isHidden = Boolean(hiddenAt);
  return {
    isHidden,
    label: isHidden ? "Unhide this Issue" : "Hide this Issue",
  };
}
