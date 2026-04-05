type IssueDetailSource = "issues" | "inbox";

type IssueDetailBreadcrumb = {
  label: string;
  href: string;
};

type IssueDetailLocationState = {
  issueDetailBreadcrumb?: IssueDetailBreadcrumb;
  issueDetailSource?: IssueDetailSource;
  issueDetailInboxQuickArchiveArmed?: boolean;
};

const ISSUE_DETAIL_SOURCE_QUERY_PARAM = "from";
const ISSUE_DETAIL_BREADCRUMB_HREF_QUERY_PARAM = "fromHref";

function isIssueDetailBreadcrumb(value: unknown): value is IssueDetailBreadcrumb {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IssueDetailBreadcrumb>;
  return typeof candidate.label === "string" && typeof candidate.href === "string";
}

function isIssueDetailSource(value: unknown): value is IssueDetailSource {
  return value === "issues" || value === "inbox";
}

function readIssueDetailSource(state: unknown): IssueDetailSource | null {
  if (typeof state !== "object" || state === null) return null;
  const source = (state as IssueDetailLocationState).issueDetailSource;
  return isIssueDetailSource(source) ? source : null;
}

function readIssueDetailSourceFromSearch(search?: string): IssueDetailSource | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const source = params.get(ISSUE_DETAIL_SOURCE_QUERY_PARAM);
  return isIssueDetailSource(source) ? source : null;
}

function readIssueDetailBreadcrumbHrefFromSearch(search?: string): string | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const href = params.get(ISSUE_DETAIL_BREADCRUMB_HREF_QUERY_PARAM);
  return href && href.startsWith("/") ? href : null;
}

function breadcrumbForSource(source: IssueDetailSource): IssueDetailBreadcrumb {
  if (source === "inbox") return { label: "Inbox", href: "/inbox" };
  return { label: "Issues", href: "/issues" };
}

export function createIssueDetailLocationState(
  label: string,
  href: string,
  source?: IssueDetailSource,
): IssueDetailLocationState {
  return {
    issueDetailBreadcrumb: { label, href },
    issueDetailSource: source,
  };
}

export function armIssueDetailInboxQuickArchive(state: unknown): IssueDetailLocationState {
  if (typeof state !== "object" || state === null) {
    return { issueDetailInboxQuickArchiveArmed: true };
  }

  return {
    ...(state as IssueDetailLocationState),
    issueDetailInboxQuickArchiveArmed: true,
  };
}

export function createIssueDetailPath(issuePathId: string, state?: unknown, search?: string): string {
  const source = readIssueDetailSource(state) ?? readIssueDetailSourceFromSearch(search);
  const breadcrumb =
    (typeof state === "object" && state !== null
      ? (state as IssueDetailLocationState).issueDetailBreadcrumb
      : null);
  const breadcrumbHref =
    (isIssueDetailBreadcrumb(breadcrumb) ? breadcrumb.href : null) ??
    readIssueDetailBreadcrumbHrefFromSearch(search);
  if (!source) return `/issues/${issuePathId}`;
  const params = new URLSearchParams();
  params.set(ISSUE_DETAIL_SOURCE_QUERY_PARAM, source);
  if (breadcrumbHref) params.set(ISSUE_DETAIL_BREADCRUMB_HREF_QUERY_PARAM, breadcrumbHref);
  return `/issues/${issuePathId}?${params.toString()}`;
}

export function readIssueDetailBreadcrumb(state: unknown, search?: string): IssueDetailBreadcrumb | null {
  if (typeof state === "object" && state !== null) {
    const candidate = (state as IssueDetailLocationState).issueDetailBreadcrumb;
    if (isIssueDetailBreadcrumb(candidate)) return candidate;
  }

  const source = readIssueDetailSourceFromSearch(search);
  if (!source) return null;

  const fallback = breadcrumbForSource(source);
  const href = readIssueDetailBreadcrumbHrefFromSearch(search);
  return href ? { ...fallback, href } : fallback;
}

export function shouldArmIssueDetailInboxQuickArchive(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  return (state as IssueDetailLocationState).issueDetailInboxQuickArchiveArmed === true;
}
