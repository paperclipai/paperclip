import {
  PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT,
  type ProductFeedbackDiagnostic,
} from "@paperclipai/shared";

const diagnostics: ProductFeedbackDiagnostic[] = [];
const EMAIL_LIKE_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

// Page context is useful for triage, but every pathname segment can contain a
// person-derived slug, plugin route, or other tenant-authored data. Emit only a
// fixed coarse category selected from reviewed router roots. No raw segment is
// ever returned, even when attacker-controlled text equals a static route word.
const COMPANY_ROUTE_CATEGORIES = new Map<string, string>([
  ["activity", "activity"],
  ["agents", "agents"],
  ["apps", "apps"],
  ["approvals", "approvals"],
  ["artifacts", "artifacts"],
  ["audit", "activity"],
  ["board-chat", "board"],
  ["cases", "cases"],
  ["companies", "companies"],
  ["company", "settings"],
  ["costs", "costs"],
  ["dashboard", "dashboard"],
  ["decisions", "decisions"],
  ["design-guide", "design"],
  ["dev", "development"],
  ["execution-workspaces", "workspaces"],
  ["goals", "goals"],
  ["inbox", "inbox"],
  ["instance", "settings"],
  ["issues", "issues"],
  ["learnings", "learnings"],
  ["onboarding", "onboarding"],
  ["org", "organization"],
  ["pipelines", "pipelines"],
  ["plugins", "plugins"],
  ["projects", "projects"],
  ["review-queue", "review"],
  ["routines", "routines"],
  ["search", "search"],
  ["settings", "settings"],
  ["skills", "skills"],
  ["status", "status"],
  ["status-cards", "status"],
  ["tasks", "issues"],
  ["tests", "tests"],
  ["timeline", "timeline"],
  ["tools", "apps"],
  ["u", "profile"],
  ["workspaces", "workspaces"],
]);

function safeLabel(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(EMAIL_LIKE_PATTERN, "redacted_email")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

export function normalizeFeedbackRoute(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] ?? "/";
  const segments = path.split("/").filter(Boolean).map((segment) => segment.toLowerCase());

  // Company routes normally start with a dynamic company prefix. Legacy
  // unprefixed routes are also categorized by their first static segment.
  const prefixedCategory = segments[1] ? COMPANY_ROUTE_CATEGORIES.get(segments[1]) : undefined;
  const unprefixedCategory = segments[0] ? COMPANY_ROUTE_CATEGORIES.get(segments[0]) : undefined;
  const category = prefixedCategory ?? unprefixedCategory;

  if (category) return `/company/${category}`;
  if (segments.length >= 2) return "/company/plugin";
  return "/other";
}

export function recordProductFeedbackDiagnostic(input: {
  code: string;
  component: string;
  route?: string;
  timestamp?: string;
}): void {
  diagnostics.push({
    code: safeLabel(input.code, "unknown_error"),
    component: safeLabel(input.component, "unknown_component"),
    routeTemplate: normalizeFeedbackRoute(input.route ?? window.location.pathname),
    timestamp: input.timestamp ?? new Date().toISOString(),
  });
  if (diagnostics.length > PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT) {
    diagnostics.splice(0, diagnostics.length - PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT);
  }
}

export function readProductFeedbackDiagnostics(): ProductFeedbackDiagnostic[] {
  return diagnostics.map((entry) => ({ ...entry }));
}

export function clearProductFeedbackDiagnostics(): void {
  diagnostics.splice(0, diagnostics.length);
}

export function getBrowserSummary(userAgent: string): string {
  const match = userAgent.match(/(?:Edg|Chrome|Firefox|Version)\/(\d+)/i);
  const family = /Edg\//i.test(userAgent)
    ? "Edge"
    : /Firefox\//i.test(userAgent)
      ? "Firefox"
      : /Chrome\//i.test(userAgent)
        ? "Chrome"
        : /Safari\//i.test(userAgent)
          ? "Safari"
          : "Other";
  return match ? `${family} ${match[1]}` : family;
}

export function getOperatingSystemSummary(userAgent: string): string {
  const windows = userAgent.match(/Windows NT (\d+)(?:\.(\d+))?/i);
  if (windows) return `Windows ${windows[1]}`;
  const android = userAgent.match(/Android (\d+)/i);
  if (android) return `Android ${android[1]}`;
  const ios = userAgent.match(/(?:iPhone OS|CPU OS) (\d+)/i);
  if (ios) return `iOS ${ios[1]}`;
  const mac = userAgent.match(/Mac OS X (\d+)/i);
  if (mac) return `macOS ${mac[1]}`;
  return /Linux/i.test(userAgent) ? "Linux" : "Other";
}
