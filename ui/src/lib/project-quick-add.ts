import { buildProjectWorkspaceInput, deriveProjectNameFromRepoUrl } from "./project-workspace";

const PAPERCLIP_PROJECT_ROUTE_SEGMENTS = new Set([
  "activity",
  "budget",
  "configuration",
  "context",
  "issues",
  "overview",
  "projects",
  "source",
  "workspaces",
]);

export type QuickProjectInputKind = "repo" | "link" | "name";

export interface QuickProjectDraft {
  kind: QuickProjectInputKind;
  name: string;
  quickLink?: {
    url: string;
  };
  workspace?: ReturnType<typeof buildProjectWorkspaceInput>;
}

function looksLikeQuickAddRepoUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return false;

    const hostname = parsed.hostname.toLowerCase();
    const lastSegment = segments[segments.length - 1] ?? "";
    return (
      hostname === "github.com" ||
      hostname.includes("github") ||
      hostname.startsWith("git.") ||
      /\.git$/i.test(lastSegment)
    );
  } catch {
    return false;
  }
}

export function looksLikeHttpLink(value: string) {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function titleizeToken(value: string) {
  const cleaned = value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
  if (!cleaned) return "";

  return cleaned
    .split(" ")
    .map((word) => {
      if (!word) return word;
      if (/[A-Z]/.test(word.slice(1))) return word;
      return `${word[0]!.toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function decodeUrlSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function deriveProjectNameFromLinkUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeUrlSegment);
    const projectsIndex = segments.findIndex((segment) => segment.toLowerCase() === "projects");
    const projectRef = projectsIndex >= 0 ? segments[projectsIndex + 1] : null;
    if (projectRef) {
      const name = titleizeToken(projectRef);
      if (name) return name;
    }

    const lastMeaningfulSegment = [...segments]
      .reverse()
      .find((segment) => !PAPERCLIP_PROJECT_ROUTE_SEGMENTS.has(segment.toLowerCase()));
    if (lastMeaningfulSegment) {
      const name = titleizeToken(lastMeaningfulSegment);
      if (name) return name;
    }

    const hostname = parsed.hostname.replace(/^www\./i, "");
    const firstHostLabel = hostname.split(".")[0] ?? hostname;
    return titleizeToken(firstHostLabel) || hostname || "New Project";
  } catch {
    return "New Project";
  }
}

export function buildQuickProjectDraft(rawValue: string): QuickProjectDraft | null {
  const value = rawValue.trim();
  if (!value) return null;

  if (looksLikeQuickAddRepoUrl(value)) {
    return {
      kind: "repo",
      name: deriveProjectNameFromRepoUrl(value),
      workspace: buildProjectWorkspaceInput({ repoUrl: value }),
    };
  }

  if (looksLikeHttpLink(value)) {
    return {
      kind: "link",
      name: deriveProjectNameFromLinkUrl(value),
      quickLink: { url: value },
    };
  }

  return {
    kind: "name",
    name: value,
  };
}
