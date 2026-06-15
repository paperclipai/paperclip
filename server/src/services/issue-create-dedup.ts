// Explicit, dependency-free signal that issueService.create collapsed a
// retried/repeated create (#7980) into a pre-existing issue instead of inserting
// a new row. The create route uses wasDeduplicatedIssueCreate() to detect that
// branch reliably — rather than inferring it from whether the returned issue
// echoes the route-minted id, which is brittle (a service mock or a future
// id-normalizing path breaks that assumption).
//
// This lives in its own module — not services/issues.ts — on purpose: the create
// route imports the detector here, while many route tests partially mock
// "../services/issues.js" (exposing only issueService). Importing the detector
// from issues.ts would resolve to `undefined` under those mocks and throw at
// request time. Keeping it dependency-free here keeps both the route and those
// tests working without each test having to re-stub the export.
//
// The marker is attached as a non-enumerable property so it never leaks into JSON
// responses (JSON.stringify and object spread for the HTTP body both skip it) and
// never affects the existing create callers that read normal issue fields.
export const ISSUE_CREATE_DEDUPLICATED: unique symbol = Symbol("issueCreateDeduplicated");

export function markDeduplicatedIssueCreate<T extends object>(issue: T): T {
  Object.defineProperty(issue, ISSUE_CREATE_DEDUPLICATED, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return issue;
}

export function wasDeduplicatedIssueCreate(issue: unknown): boolean {
  return (
    typeof issue === "object" &&
    issue !== null &&
    (issue as Record<symbol, unknown>)[ISSUE_CREATE_DEDUPLICATED] === true
  );
}
