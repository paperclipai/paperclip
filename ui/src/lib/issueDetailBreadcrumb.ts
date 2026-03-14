type IssueDetailBreadcrumb = {
  label: string;
  href: string;
};

type IssueDetailLocationState = {
  issueDetailBreadcrumb?: IssueDetailBreadcrumb;
};

function isIssueDetailBreadcrumb(value: unknown): value is IssueDetailBreadcrumb {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IssueDetailBreadcrumb>;
  return typeof candidate.label === "string" && typeof candidate.href === "string";
}

export function createIssueDetailLocationState(label: string, href: string): IssueDetailLocationState {
  return { issueDetailBreadcrumb: { label, href } };
}

export function readIssueDetailBreadcrumb(state: unknown): IssueDetailBreadcrumb | null {
  if (typeof state !== "object" || state === null) return null;
  const candidate = (state as IssueDetailLocationState).issueDetailBreadcrumb;
  return isIssueDetailBreadcrumb(candidate) ? candidate : null;
}
