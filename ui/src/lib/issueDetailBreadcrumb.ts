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
const ISSUE_DETAIL_STORAGE_KEY_PREFIX = "paperclip:issue-detail-breadcrumb:";

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

function inferIssueDetailSource(
  state: Partial<IssueDetailLocationState> | null,
  breadcrumb: IssueDetailBreadcrumb | null,
): IssueDetailSource | null {
  if (isIssueDetailSource(state?.issueDetailSource)) return state.issueDetailSource;
  if (!breadcrumb) return null;
  if (breadcrumb.label === "Inbox" || breadcrumb.href.includes("/inbox")) return "inbox";
  if (breadcrumb.label === "Issues" || breadcrumb.href.includes("/issues")) return "issues";
  return null;
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

function readStoredIssueDetailLocationState(issuePathId: string): IssueDetailLocationState | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;

  const raw = window.sessionStorage.getItem(`${ISSUE_DETAIL_STORAGE_KEY_PREFIX}${issuePathId}`);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<IssueDetailLocationState>;
    const breadcrumb = isIssueDetailBreadcrumb(parsed.issueDetailBreadcrumb)
      ? parsed.issueDetailBreadcrumb
      : null;
    const source = inferIssueDetailSource(parsed, breadcrumb);
    if (!breadcrumb || !source) return null;
    return {
      issueDetailBreadcrumb: breadcrumb,
      issueDetailSource: source,
      issueDetailInboxQuickArchiveArmed: parsed.issueDetailInboxQuickArchiveArmed === true,
    };
  } catch {
    return null;
  }
}

function normalizeIssueDetailLocationState(
  state: unknown,
  search?: string,
): IssueDetailLocationState | null {
  if (typeof state === "object" && state !== null) {
    const candidate = (state as IssueDetailLocationState).issueDetailBreadcrumb;
    if (isIssueDetailBreadcrumb(candidate)) {
      const source = inferIssueDetailSource(state as Partial<IssueDetailLocationState>, candidate);
      if (!source) return null;
      return {
        issueDetailBreadcrumb: candidate,
        issueDetailSource: source,
        issueDetailInboxQuickArchiveArmed:
          (state as IssueDetailLocationState).issueDetailInboxQuickArchiveArmed === true,
      };
    }
  }

  const source = readIssueDetailSourceFromSearch(search);
  const href = readIssueDetailBreadcrumbHrefFromSearch(search);
  if (!source) return null;

  return {
    issueDetailBreadcrumb: href ? { ...breadcrumbForSource(source), href } : breadcrumbForSource(source),
    issueDetailSource: source,
    issueDetailInboxQuickArchiveArmed: false,
  };
}

export function rememberIssueDetailLocationState(issuePathId: string, state: unknown, search?: string): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;

  const normalized = normalizeIssueDetailLocationState(state, search);
  if (!normalized) return;

  window.sessionStorage.setItem(
    `${ISSUE_DETAIL_STORAGE_KEY_PREFIX}${issuePathId}`,
    JSON.stringify(normalized),
  );
}

export function createIssueDetailPath(issuePathId: string): string {
  return `/issues/${issuePathId}`;
}

export function hasLegacyIssueDetailQuery(search?: string): boolean {
  if (!search) return false;
  const params = new URLSearchParams(search);
  return params.has(ISSUE_DETAIL_SOURCE_QUERY_PARAM) || params.has(ISSUE_DETAIL_BREADCRUMB_HREF_QUERY_PARAM);
}

export function readIssueDetailLocationState(
  issuePathId: string | null | undefined,
  state: unknown,
  search?: string,
): IssueDetailLocationState | null {
  const normalized = normalizeIssueDetailLocationState(state, search);
  if (normalized) return normalized;
  if (!issuePathId) return null;
  return readStoredIssueDetailLocationState(issuePathId);
}

export function readIssueDetailBreadcrumb(
  issuePathId: string | null | undefined,
  state: unknown,
  search?: string,
): IssueDetailBreadcrumb | null {
  return readIssueDetailLocationState(issuePathId, state, search)?.issueDetailBreadcrumb ?? null;
}

export function shouldArmIssueDetailInboxQuickArchive(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  return (state as IssueDetailLocationState).issueDetailInboxQuickArchiveArmed === true;
}
