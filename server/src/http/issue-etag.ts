const ISSUE_ETAG_PATTERN = /^"issue-v([1-9]\d*)"$/;
const MAX_ISSUE_VERSION = 2_147_483_647;

export class InvalidIssueEtagError extends Error {
  constructor() {
    super("Invalid If-Match issue ETag");
  }
}

export function formatIssueEtag(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_ISSUE_VERSION) {
    throw new RangeError("Issue version must be a positive 32-bit integer");
  }
  return `"issue-v${version}"`;
}

export function parseOptionalIssueIfMatch(
  value: string | string[] | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new InvalidIssueEtagError();

  const match = value.trim().match(ISSUE_ETAG_PATTERN);
  if (!match) throw new InvalidIssueEtagError();

  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version > MAX_ISSUE_VERSION) {
    throw new InvalidIssueEtagError();
  }
  return version;
}
