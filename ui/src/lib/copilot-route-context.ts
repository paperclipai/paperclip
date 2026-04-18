import type { CopilotRouteContext } from "@paperclipai/shared";
import { toCompanyRelativePath } from "./company-routes";

function decodeSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readSearchFilters(params: URLSearchParams): Record<string, string> | undefined {
  const filters: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (Object.keys(filters).length >= 12) break;
    if (!key.trim() || !value.trim()) continue;
    filters[key.slice(0, 64)] = value.slice(0, 128);
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

export function extractContextIssueRef(pathname: string, search: string): string | null {
  const relative = toCompanyRelativePath(`${pathname}${search}`);
  const url = new URL(relative, "http://paperclip.local");
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "issues") return null;
  return decodeSegment(segments[1]) ?? null;
}

export function buildCopilotRouteContext(pathname: string, search: string): CopilotRouteContext {
  const relative = toCompanyRelativePath(`${pathname}${search}`);
  const url = new URL(relative, "http://paperclip.local");
  const segments = url.pathname.split("/").filter(Boolean);
  const pageKind = segments[0] ?? "dashboard";
  const context: CopilotRouteContext = {
    pageKind,
    pagePath: `${url.pathname}${url.search}`,
    filters: readSearchFilters(url.searchParams),
  };

  if (pageKind === "agents" && segments[1]) {
    context.entityType = "agent";
    context.entityId = decodeSegment(segments[1]);
  } else if (pageKind === "issues" && segments[1]) {
    context.entityType = "issue";
    context.entityId = decodeSegment(segments[1]);
  } else if (pageKind === "projects" && segments[1]) {
    context.entityType = "project";
    context.entityId = decodeSegment(segments[1]);
  } else if (pageKind === "goals" && segments[1]) {
    context.entityType = "goal";
    context.entityId = decodeSegment(segments[1]);
  } else if (pageKind === "approvals" && segments[1] && segments[1] !== "pending" && segments[1] !== "all") {
    context.entityType = "approval";
    context.entityId = decodeSegment(segments[1]);
  } else if (pageKind === "execution-workspaces" && segments[1]) {
    context.entityType = "execution_workspace";
    context.entityId = decodeSegment(segments[1]);
  } else if (pageKind === "roadmap") {
    context.entityType = "roadmap";
    context.entityId = "company-roadmap";
  } else if (pageKind === "inbox") {
    context.entityType = "inbox";
    context.entityId = decodeSegment(segments[1] ?? "mine");
  }

  return context;
}
