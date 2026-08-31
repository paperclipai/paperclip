import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { extractProjectMentionIds } from "@paperclipai/shared";

/**
 * Project attribution for agent-created tasks.
 *
 * A project in this control plane is one git repo. An agent filing a task
 * almost always knows which repo it affects, but nothing on the create path
 * asked: an explicit `projectId`, a parent, or a selected workspace stamped the
 * project, and a top-level task filed straight from a run stamped nothing. This
 * module supplies the missing fallback, in strict precedence order, and answers
 * `null` rather than guessing when the signals disagree.
 *
 * It is called from the create route rather than from `issueService.create`,
 * and deliberately so: a project can carry its own authorization policy, so the
 * project has to be known *before* the request's assignment scope and source
 * trust are decided. Resolving it deeper, after those decisions, would let a
 * task settle into a policy-bearing project on a trust verdict that was reached
 * as though it had no project at all.
 */

type DbReader = Pick<Db, "select">;

export interface ProjectRepoWorkspace {
  projectId: string;
  repoUrl: string | null;
  cwd: string | null;
}

/**
 * Longest repo path we will consider when a text URL points *into* a repo
 * (`.../blob/main/src/x.ts`). Deep enough for a nested host namespace, shallow
 * enough that scanning stays trivial.
 */
const MAX_REPO_PATH_SEGMENTS = 5;

const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SCHEME_URL_PATTERN = /\b(?:https?|ssh|git):\/\/[^\s<>"'`)\]}]+/gi;
const SCP_REMOTE_PATTERN = /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._\-/]+/g;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s<>"'`([{])(\/[A-Za-z0-9._\-/]+)/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}>"'`]+$/;

function stripTrailingPunctuation(token: string) {
  return token.replace(TRAILING_PUNCTUATION_PATTERN, "");
}

function normalizeHost(host: string) {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function repoPathSegments(rawPath: string) {
  const segments = rawPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) return null;
  return segments;
}

function stripGitSuffix(segment: string) {
  return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

function splitRemote(raw: string): { host: string; path: string } | null {
  const trimmed = stripTrailingPunctuation(raw.trim());
  if (trimmed.length === 0) return null;

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!url.hostname) return null;
      return { host: normalizeHost(url.hostname), path: url.pathname };
    } catch {
      return null;
    }
  }

  // scp-style remote: [user@]host:owner/repo. The path side must not be a port,
  // which is what separates this from an `host:8080/...` authority.
  const scp = /^(?:[^@\s/]+@)?([A-Za-z0-9.-]+):(?!\d+(?:\/|$))(\S+)$/.exec(trimmed);
  if (!scp) return null;
  return { host: normalizeHost(scp[1]!), path: scp[2]! };
}

/**
 * Fold every remote form of one repo onto a single `host/owner/repo` identity:
 * https, ssh, scp-style, embedded credentials, a `.git` suffix, a `www.` host
 * and casing all collapse. Returns `null` for anything that is not a repo
 * remote.
 */
export function normalizeRepoIdentity(raw: string): string | null {
  const split = splitRemote(raw);
  if (!split) return null;
  const segments = repoPathSegments(split.path);
  if (!segments) return null;
  segments[segments.length - 1] = stripGitSuffix(segments[segments.length - 1]!);
  if (segments[segments.length - 1]!.length === 0) return null;
  return `${split.host}/${segments.join("/")}`.toLowerCase();
}

/**
 * Every repo identity a free-text remote could be naming. A URL that points
 * *into* a repo carries the repo path plus extra segments (`/blob/main/...`),
 * and only the workspace row knows where the repo path ends — so emit each
 * prefix and let the match decide.
 */
function candidateRepoIdentities(raw: string): string[] {
  const split = splitRemote(raw);
  if (!split) return [];
  const segments = repoPathSegments(split.path);
  if (!segments) return [];

  const identities: string[] = [];
  const depth = Math.min(segments.length, MAX_REPO_PATH_SEGMENTS);
  for (let length = 2; length <= depth; length += 1) {
    const prefix = segments.slice(0, length);
    prefix[prefix.length - 1] = stripGitSuffix(prefix[prefix.length - 1]!);
    if (prefix[prefix.length - 1]!.length === 0) continue;
    identities.push(`${split.host}/${prefix.join("/")}`.toLowerCase());
  }
  return identities;
}

function normalizeAbsolutePath(raw: string) {
  const trimmed = stripTrailingPunctuation(raw.trim()).replace(/\/{2,}/g, "/");
  if (!trimmed.startsWith("/")) return null;
  const withoutTrailingSlash = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  return withoutTrailingSlash.length > 1 ? withoutTrailingSlash : null;
}

function collectMatches(pattern: RegExp, text: string, group = 0) {
  const found: string[] = [];
  // Each call gets its own lastIndex; the module-level regexes are /g.
  const scanner = new RegExp(pattern.source, pattern.flags);
  let match = scanner.exec(text);
  while (match) {
    const value = match[group];
    if (value) found.push(value);
    match = scanner.exec(text);
  }
  return found;
}

/**
 * The single project whose git repo this text names, or `null`.
 *
 * `null` covers three cases deliberately: no repo is named, the named repo
 * belongs to no project here, or *several* projects are named — a task that
 * cross-references two repos has not told us which one it affects, and a guess
 * is worse than leaving the field empty.
 */
export function matchProjectIdByRepoReference(input: {
  text: string;
  workspaces: ProjectRepoWorkspace[];
}): string | null {
  const { text } = input;
  if (!text.trim()) return null;

  const repoIdentityToProjectIds = new Map<string, Set<string>>();
  const workspaceCwds: Array<{ cwd: string; projectId: string }> = [];
  for (const workspace of input.workspaces) {
    if (workspace.repoUrl) {
      const identity = normalizeRepoIdentity(workspace.repoUrl);
      if (identity) {
        const owners = repoIdentityToProjectIds.get(identity) ?? new Set<string>();
        owners.add(workspace.projectId);
        repoIdentityToProjectIds.set(identity, owners);
      }
    }
    if (workspace.cwd) {
      const cwd = normalizeAbsolutePath(workspace.cwd);
      if (cwd) workspaceCwds.push({ cwd, projectId: workspace.projectId });
    }
  }
  if (repoIdentityToProjectIds.size === 0 && workspaceCwds.length === 0) return null;

  const matchedProjectIds = new Set<string>();

  const remoteTokens = [
    ...collectMatches(SCHEME_URL_PATTERN, text),
    ...collectMatches(SCP_REMOTE_PATTERN, text),
  ];
  for (const token of remoteTokens) {
    for (const identity of candidateRepoIdentities(token)) {
      for (const projectId of repoIdentityToProjectIds.get(identity) ?? []) {
        matchedProjectIds.add(projectId);
      }
    }
  }

  // Scan for filesystem paths only outside the remotes, so a URL path is never
  // re-read as a local checkout path. Blanking is two linear passes rather than
  // one pass per matched token, so a description carrying many links stays cheap.
  const textWithoutRemotes = text
    .replace(new RegExp(SCHEME_URL_PATTERN.source, SCHEME_URL_PATTERN.flags), " ")
    .replace(new RegExp(SCP_REMOTE_PATTERN.source, SCP_REMOTE_PATTERN.flags), " ");
  for (const rawPath of collectMatches(ABSOLUTE_PATH_PATTERN, textWithoutRemotes, 1)) {
    const candidate = normalizeAbsolutePath(rawPath);
    if (!candidate) continue;
    // Most specific checkout wins, so a nested workspace beats its parent.
    let best: { cwd: string; projectId: string } | null = null;
    for (const workspace of workspaceCwds) {
      const isMatch = candidate === workspace.cwd || candidate.startsWith(`${workspace.cwd}/`);
      if (!isMatch) continue;
      if (!best || workspace.cwd.length > best.cwd.length) best = workspace;
    }
    if (best) matchedProjectIds.add(best.projectId);
  }

  return matchedProjectIds.size === 1 ? [...matchedProjectIds][0]! : null;
}

async function resolveMentionedProjectId(
  reader: DbReader,
  companyId: string,
  text: string,
): Promise<string | null> {
  const mentionedIds = [...new Set(extractProjectMentionIds(text))];
  if (mentionedIds.length === 0) return null;

  const rows = await reader
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, mentionedIds)));
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * The project of the issue the creating run is checked out on.
 *
 * The execution-workspace inheritance path already reads this snapshot, but it
 * bails unless the run holds an execution workspace — so with isolated
 * workspaces off, a run working inside a project propagated nothing. This reads
 * the same snapshot without that gate, keeping its ownership checks: the run
 * must belong to this company and to the creating agent.
 */
async function resolveRunContextProjectId(
  reader: DbReader,
  companyId: string,
  input: { agentId: string; runId: string },
): Promise<string | null> {
  const run = await reader
    .select({ agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!run || run.agentId !== input.agentId) return null;

  const context = run.contextSnapshot && typeof run.contextSnapshot === "object"
    ? run.contextSnapshot as Record<string, unknown>
    : null;
  if (!context) return null;
  const paperclipIssue = context.paperclipIssue && typeof context.paperclipIssue === "object"
    ? context.paperclipIssue as Record<string, unknown>
    : null;
  const contextIssueId = readNonEmptyString(context.issueId)
    ?? readNonEmptyString(paperclipIssue?.id);
  if (!contextIssueId) return null;

  const contextIssue = await reader
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return contextIssue?.projectId ?? null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Fallback project for an agent-created issue that has none after every
 * explicit signal (given `projectId`, parent, selected workspace) has been
 * applied. Precedence:
 *
 *   1. an explicit `@project` mention in the text — deliberate author intent
 *   2. the project of the issue the creating run is working on
 *   3. the single project whose git repo the text names
 *   4. `null`
 *
 * Run context outranks the text because the common text failure is a task about
 * repo A that merely links *into* repo B; run context has no such failure mode,
 * and when the two agree the order does not matter.
 */
export async function resolveAgentIssueProjectId(
  reader: DbReader,
  companyId: string,
  input: {
    createdByAgentId: string | null | undefined;
    actorRunId: string | null | undefined;
    title: string | null | undefined;
    description: string | null | undefined;
  },
): Promise<string | null> {
  if (!input.createdByAgentId) return null;

  const text = [input.title ?? "", input.description ?? ""].join("\n").trim();

  if (text.length > 0) {
    const mentionedProjectId = await resolveMentionedProjectId(reader, companyId, text);
    if (mentionedProjectId) return mentionedProjectId;
  }

  if (input.actorRunId) {
    const runContextProjectId = await resolveRunContextProjectId(reader, companyId, {
      agentId: input.createdByAgentId,
      runId: input.actorRunId,
    });
    if (runContextProjectId) return runContextProjectId;
  }

  if (text.length === 0) return null;

  const workspaces = await reader
    .select({
      projectId: projectWorkspaces.projectId,
      repoUrl: projectWorkspaces.repoUrl,
      cwd: projectWorkspaces.cwd,
    })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.companyId, companyId));
  if (workspaces.length === 0) return null;

  return matchProjectIdByRepoReference({ text, workspaces });
}
