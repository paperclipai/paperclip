/**
 * LET-505 — canned API fixtures for the EAOS screenshot runner.
 *
 * These fixtures are used ONLY by `scripts/evidence/eaos-screenshots.ts`
 * when run with `--mock-api`. They are NOT shipped to customers, NOT
 * loaded by the product code, and are NOT a substitute for real backend
 * data — they exist purely so the screenshot evidence package can render
 * the actual EAOS React shell + page chrome without needing a session
 * cookie or a second authenticated backend instance.
 *
 * Truthfulness contract:
 *   - `/api/health` is forced to `local_trusted` so the CloudAccessGate
 *     does not redirect to the sign-in wall. The product never serves
 *     this response by accident; the dev server's `/api/*` proxy is what
 *     would normally answer, and we replace it via Playwright route().
 *   - The single demo company exists so company-context auto-selection
 *     can resolve. Its name is intentionally generic so reviewers cannot
 *     mistake it for real customer data.
 *   - Every list endpoint returns `[]` so the rendered surfaces show the
 *     authentic "no data yet" empty state — no fake agents, no fake
 *     missions, no decorative metrics. Reviewers can score: shell
 *     density, navigation hierarchy, header copy, table chrome, empty-
 *     state design, typography, spacing, light-theme contrast.
 *
 * No secrets. No production identifiers. Safe to commit verbatim.
 */

export const SCREENSHOT_COMPANY_ID = "00000000-0000-0000-0000-000000000eaa";
const SCREENSHOT_USER_ID = "00000000-0000-0000-0000-0000000000a1";
const NOW = "2026-05-20T00:00:00.000Z";

export const SCREENSHOT_HEALTH = {
  status: "ok",
  deploymentMode: "local_trusted",
  bootstrapStatus: "ready",
  bootstrapInviteActive: false,
  devServer: { enabled: false },
};

export const SCREENSHOT_COMPANY = {
  id: SCREENSHOT_COMPANY_ID,
  name: "Acme AI Labs",
  description: "Screenshot evidence demo company. Not real customer data.",
  status: "active",
  issuePrefix: "ACME",
  brandColor: "#1f2937",
  logoAssetId: null,
  budgetMonthlyCents: 0,
  attachmentMaxBytes: 0,
  requireBoardApprovalForNewAgents: false,
  feedbackDataSharingEnabled: false,
  createdAt: NOW,
  updatedAt: NOW,
};

export const SCREENSHOT_SESSION = {
  user: {
    id: SCREENSHOT_USER_ID,
    email: "design-reviewer@example.invalid",
    name: "Design Reviewer",
    image: null,
  },
};

export const SCREENSHOT_BOARD_ACCESS = {
  user: SCREENSHOT_SESSION.user,
  userId: SCREENSHOT_USER_ID,
  isInstanceAdmin: true,
  companyIds: [SCREENSHOT_COMPANY_ID],
  memberships: [
    {
      companyId: SCREENSHOT_COMPANY_ID,
      membershipRole: "owner",
      status: "active",
    },
  ],
  source: "screenshot-fixture",
  keyId: null,
};

export const SCREENSHOT_INSTANCE_GENERAL = {
  keyboardShortcuts: true,
  copilotEnabled: false,
};

/**
 * Pattern → JSON-body matcher. The runner iterates these in order and
 * serves the first match. The value can be a function so we can sniff
 * the URL/method when needed.
 *
 * The catch-all at the end returns `[]` for any list-shaped path the
 * runner does not explicitly cover. Anything else falls through to a
 * 200 `{}` reply — preferable to a 5xx that would derail the React
 * Query retries and trigger error UI we did not mean to capture.
 */
export interface MockRouteSpec {
  readonly methodPattern?: RegExp;
  readonly pathPattern: RegExp;
  readonly response:
    | { status: number; body: unknown }
    | ((url: URL, method: string) => { status: number; body: unknown });
}

export const SCREENSHOT_API_ROUTES: ReadonlyArray<MockRouteSpec> = [
  { pathPattern: /^\/api\/health$/, response: { status: 200, body: SCREENSHOT_HEALTH } },
  { pathPattern: /^\/api\/auth\/get-session$/, response: { status: 200, body: SCREENSHOT_SESSION } },
  { pathPattern: /^\/api\/auth\/profile$/, response: { status: 200, body: SCREENSHOT_SESSION } },
  { pathPattern: /^\/api\/cli-auth\/me$/, response: { status: 200, body: SCREENSHOT_BOARD_ACCESS } },
  { pathPattern: /^\/api\/instance\/settings\/general$/, response: { status: 200, body: SCREENSHOT_INSTANCE_GENERAL } },
  { pathPattern: /^\/api\/companies$/, response: { status: 200, body: [SCREENSHOT_COMPANY] } },
  { pathPattern: /^\/api\/companies\/stats$/, response: { status: 200, body: { [SCREENSHOT_COMPANY_ID]: { agentCount: 0, issueCount: 0 } } } },
  { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}$`), response: { status: 200, body: SCREENSHOT_COMPANY } },
  // Org graph — empty array shows the truthful "no reporting tree yet" state
  { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/org$`), response: { status: 200, body: [] } },
  // Members/capabilities/skills/blueprints/etc. all return the empty truthful state
  { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/members$`), response: { status: 200, body: { members: [], access: { currentUserRole: "owner", canManageMembers: true, canInviteUsers: true, canApproveJoinRequests: true } } } },
  { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/capabilities$`), response: { status: 200, body: { config: {}, providerStatus: {} } } },
  { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/skills(?:\\b|/)`), response: { status: 200, body: [] } },
  { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/blueprints(?:\\b|/)`), response: { status: 200, body: [] } },
  // Generic list endpoints scoped to the demo company
  { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/(agents|issues|projects|goals|approvals|activity|inbox|search|join-requests|invites|secrets|user-directory|environments)(?:\\b|/|\\?)`), response: { status: 200, body: [] } },
];

/**
 * Fallback for any /api path the explicit list misses. Defaults to
 * `200 []` because most uncovered EAOS endpoints are list-shaped (the
 * UI calls `.filter`/`.map` on them); the few singleton endpoints we
 * care about are pinned explicitly in SCREENSHOT_API_ROUTES.
 */
export function screenshotApiFallback(url: URL): { status: number; body: unknown } {
  if (url.pathname.startsWith("/api/")) {
    const looksLikeSingleton = /\/(health|settings|profile|session|me|config|stats|status|capabilities)$/.test(
      url.pathname,
    );
    return { status: 200, body: looksLikeSingleton ? {} : [] };
  }
  return { status: 200, body: {} };
}
