// Read-only Git mirror for one wiki space: copies the Markdown files of one
// GitHub branch into the space's folder on a schedule. Against the repository
// it only issues GET requests (plus minting a read-only installation token),
// so nothing flows back to Git; the write guard in core keeps every other
// plugin writer out of the mirrored space.

import { createHash, createSign } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { WIKI_ROOT_FOLDER_KEY } from "../manifest.js";
import { REQUIRED_WIKI_DIRECTORIES, REQUIRED_WIKI_FILES } from "../templates.js";
import {
  DEFAULT_SPACE_SLUG,
  createSpace,
  findSpaceForMirrorCleanup,
  indexMirroredPage,
  indexedPagePaths,
  isWikiPagePath,
  normalizeSpaceSlug,
  resolveSpace,
  spaceRelativePath,
  unindexMirroredPages,
  type WikiSpace,
} from "./core.js";
import {
  GIT_MIRROR_PRIVATE_KEY_CONFIG_PATH,
  GIT_MIRROR_TOKEN_CONFIG_PATH,
  readGitMirrorConfig,
  type GitMirrorSettings,
} from "./git-mirror-config.js";

const GITHUB_API = "https://api.github.com";
const STATE_NAMESPACE = "llm-wiki";
const STATE_KEY = "git-mirror";
/**
 * Forced-rewrite requests live under their own key as a counter, apart from the sync state: a sync saves its
 * whole state from a snapshot taken when it started, which would erase a request made while it ran.
 */
const FORCE_STATE_KEY = "git-mirror-force";
const MAX_MIRROR_FILES = 5000;
const MAX_MIRROR_FILE_BYTES = 1_000_000;
const MAX_MIRROR_TOTAL_BYTES = 50_000_000;
const MAX_SKIPPED_REPORTED = 50;
/** The only permissions a minted token may carry: what the mint asked for, and GitHub's implicit metadata. */
const ALLOWED_TOKEN_PERMISSIONS = new Set(["contents", "metadata"]);
/** Git object ids from GitHub go into URL paths, so they must be exactly that. */
const OBJECT_ID = /^[0-9a-f]{40}$/;
/** Ledger value for a file the mirror is about to write: never a blob id, so it is always rewritten. */
const PENDING = "pending";

type SecretRef = Parameters<PluginContext["secrets"]["resolve"]>[0];

export type GitMirrorSkip = { path: string; reason: string };

type GitMirrorSource = {
  owner: string;
  repo: string;
  branch: string;
  spaceSlug: string;
  pathPrefix: string | null;
  /** The wiki root's real path: the ledger below only describes files under this root. */
  rootPath: string | null;
};

export type GitMirrorState = {
  source: GitMirrorSource | null;
  commitSha: string | null;
  syncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /**
   * Set (and saved) before the first file changes, cleared only by a complete sync. While set, an unchanged
   * branch head proves nothing: a failed run may have left files from another commit.
   */
  inProgress: boolean;
  /**
   * Set when a run stopped on purpose at its time budget with an accurate ledger (finished files carry
   * their blob ids, the rest are pending): the next run continues instead of rewriting everything.
   */
  resumable: boolean;
  /** The force-request count (FORCE_STATE_KEY) the last forced rewrite took effect for. */
  forceConsumed: number;
  /** Page path (mirroredPagePath) -> Git blob sha of every file the mirror wrote. Only these are ever deleted. */
  files: Record<string, string>;
  skipped: GitMirrorSkip[];
  /** Blobs fetched and judged unmirrorable (not UTF-8, too large), by repository path: not fetched again while unchanged. */
  skippedBlobs: Record<string, { sha: string; reason: string }>;
  /**
   * The space whose page index holds this ledger's pages: a file's blob id is recorded only after its page row
   * is written, and a page row is removed before its file. Kept apart from `source`, so a ledger without it
   * does not read as a changed source.
   */
  indexedSpace: { id: string; companyId: string; wikiId: string } | null;
  /**
   * Set once every owned page's row has been rewritten from disk. A new ledger has it unset, so its first
   * sync replaces any row the space held before the mirror owned those paths.
   */
  indexVerified: boolean;
  /**
   * This sync's index check (takeIndexBacklog), null between syncs: true for a page whose row it still rewrites
   * from disk, false for one it tried and could not read. A page the sync writes leaves it (writing rewrites its
   * row), so the backfill reads only pages no run of this sync has indexed, a run that hands off resumes where it
   * stopped, and a failed check is still on record when the sync finishes.
   */
  indexBacklog: Record<string, boolean> | null;
};

export type GitMirrorSyncResult = {
  /** "partial": the run reached its time budget; a continuation picks up the remaining files. */
  status: "synced" | "unchanged" | "partial";
  repository: string;
  branch: string;
  spaceSlug: string;
  commitSha: string;
  fileCount: number;
  written: string[];
  deleted: string[];
  skipped: GitMirrorSkip[];
};

export type GitMirrorStatus = {
  enabled: boolean;
  configError: string | null;
  repository: string | null;
  branch: string | null;
  spaceSlug: string | null;
  auth: "github_app" | "token" | "none" | null;
  running: boolean;
  /** A run handed off at its time budget and its continuation has not finished yet. */
  continuing: boolean;
  /** A forced rewrite was requested and has not started yet. */
  forcePending: boolean;
  commitSha: string | null;
  syncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  fileCount: number;
  skipped: GitMirrorSkip[];
};

type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };

/**
 * How long one sync run may work before handing the rest to a continuation. The worker runs each sync in a
 * plugin event whose host invocation scope lasts 15 minutes; a run past it would lose its host access.
 */
export const gitMirrorTuning = { syncBudgetMs: 10 * 60 * 1000 };

const running = new Map<string, Promise<GitMirrorSyncResult>>();

export function isGitMirrorSyncRunning(companyId: string): boolean {
  return running.has(companyId);
}
/** A reserved run still waiting for the one in flight; it has not read its config yet, so it serves any caller. */
const waiting = new Map<string, Promise<GitMirrorSyncResult>>();

function stateScope(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: STATE_KEY };
}

function forceScope(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: FORCE_STATE_KEY };
}

async function readForceRequests(ctx: PluginContext, companyId: string): Promise<number> {
  const stored = await ctx.state.get(forceScope(companyId)) as { requested?: unknown } | null;
  return typeof stored?.requested === "number" && Number.isFinite(stored.requested) ? stored.requested : 0;
}

function emptyState(): GitMirrorState {
  return { source: null, commitSha: null, syncedAt: null, lastAttemptAt: null, lastError: null, inProgress: false, resumable: false, forceConsumed: 0, files: {}, skipped: [], skippedBlobs: {}, indexedSpace: null, indexVerified: false, indexBacklog: null };
}

export async function readGitMirrorState(ctx: PluginContext, companyId: string): Promise<GitMirrorState> {
  const stored = await ctx.state.get(stateScope(companyId));
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return emptyState();
  const value = stored as Partial<GitMirrorState>;
  return {
    ...emptyState(),
    ...value,
    files: typeof value.files === "object" && value.files !== null ? { ...value.files } : {},
    skipped: Array.isArray(value.skipped) ? value.skipped : [],
    skippedBlobs: typeof value.skippedBlobs === "object" && value.skippedBlobs !== null ? { ...value.skippedBlobs } : {},
    indexedSpace: isIndexedSpace(value.indexedSpace) ? { ...value.indexedSpace } : null,
    indexVerified: value.indexVerified === true,
    indexBacklog: typeof value.indexBacklog === "object" && value.indexBacklog !== null && !Array.isArray(value.indexBacklog)
      ? { ...value.indexBacklog }
      : null,
  };
}

function isIndexedSpace(value: unknown): value is { id: string; companyId: string; wikiId: string } {
  const candidate = value as { id?: unknown; companyId?: unknown; wikiId?: unknown } | null;
  return typeof candidate?.id === "string" && typeof candidate.companyId === "string" && typeof candidate.wikiId === "string";
}

/**
 * Take this sync's index check once, before it writes any page: until `indexVerified` is set, every owned,
 * written page (its path may hold a row written before the mirror owned it); after that, only those with no
 * row. Kept in state across hand-offs, so a continuation resumes it instead of starting over.
 */
async function takeIndexBacklog(ctx: PluginContext, state: GitMirrorState, space: WikiSpace): Promise<void> {
  if (state.indexBacklog) return;
  const owned = Object.entries(state.files).filter(([path, sha]) => sha !== PENDING && isWikiPagePath(path)).map(([path]) => path);
  const indexed = state.indexVerified ? await indexedPagePaths(ctx, space) : null;
  state.indexBacklog = Object.fromEntries(owned.filter((path) => !indexed?.has(path)).map((path) => [path, true as const]));
}

type SyncBudget = { outOfTime(): boolean; spend(): void };

/**
 * Rewrite the rows of the pages still due in `indexBacklog` from disk (a page this sync wrote has already left
 * it). Each read spends the sync budget; out of time, it returns false with the rest still due, for a
 * continuation. Each page is tried once per sync, and one it cannot read stays in the backlog as failed, across
 * any hand-off: `indexVerified` is set only when no check failed, so the next sync checks every page again.
 */
async function backfillPageIndex(
  ctx: PluginContext,
  companyId: string,
  state: GitMirrorState,
  space: WikiSpace,
  budget: SyncBudget,
): Promise<boolean> {
  await takeIndexBacklog(ctx, state, space);
  const backlog = state.indexBacklog ?? {};
  for (const path of Object.keys(backlog)) {
    if (!backlog[path]) continue;
    const sha = state.files[path];
    if (sha !== undefined && sha !== PENDING) {
      if (budget.outOfTime()) return false;
      budget.spend();
      try {
        const contents = await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, path));
        await indexMirroredPage(ctx, space, path, contents);
      } catch {
        backlog[path] = false;
        continue;
      }
    }
    delete backlog[path];
  }
  if (Object.keys(backlog).length === 0) state.indexVerified = true;
  state.indexBacklog = null;
  return true;
}

/**
 * The space whose rows describe the ledger: the one recorded with it, or, for a ledger that recorded none, its
 * source's space looked up by slug, archived or not (null only when no such space exists; a failed
 * lookup throws before any file is deleted, and the next sync tries again).
 */
async function ledgerIndexSpace(
  ctx: PluginContext,
  companyId: string,
  state: GitMirrorState,
): Promise<{ id: string; companyId: string; wikiId: string } | null> {
  if (state.indexedSpace) return state.indexedSpace;
  if (!state.source) return null;
  return findSpaceForMirrorCleanup(ctx, companyId, state.source.spaceSlug);
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** RS256 JWT a GitHub App presents to mint an installation token (valid for at most 10 minutes). */
export function githubAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${base64Url(signature)}`;
}

/** Git's object id for a blob: sha1 over "blob <length>\0" and the bytes. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Markdown outside dot-directories, with a path the local folder API accepts. */
export function isMirrorablePath(path: string): boolean {
  if (!/\.md$/i.test(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

/**
 * Where a repository file lands in the space, so the page tools read, list and search every file the mirror
 * writes: a path they read as written (AGENTS.md, IDEA.md, index.md, log.md, WIKI.md, wiki/**.md) stays put;
 * any other Markdown file goes under wiki/ (README.md -> wiki/README.md, docs/setup.md -> wiki/docs/setup.md).
 * Null when even that is no page path (an upper-case `.MD` extension). Nothing lands outside wiki/ and the
 * root page files, so a root mirror never writes into the other spaces' subfolders.
 */
export function mirroredPagePath(path: string): string | null {
  if (isWikiPagePath(path)) return path;
  const nested = `wiki/${path}`;
  return isWikiPagePath(nested) ? nested : null;
}

const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;

/** Remove every known secret and anything shaped like a GitHub token or JWT from text bound for state or logs. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.replace(TOKEN_SHAPES, "[redacted]");
}

/** A credential goes into an Authorization header; refuse one a header cannot carry before it reaches one. */
function assertHeaderSafe(credential: string, label: string): string {
  if (!/^[\x21-\x7e]{1,2048}$/.test(credential)) {
    throw new Error(`The ${label} is empty or contains characters an HTTP header cannot carry`);
  }
  return credential;
}

async function github(
  ctx: PluginContext,
  method: "GET" | "POST",
  path: string,
  credential: string | null,
  body?: unknown,
): Promise<unknown> {
  const route = path.split("?")[0];
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "paperclip-plugin-llm-wiki",
  };
  if (credential) headers.authorization = `Bearer ${credential}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await ctx.http.fetch(`${GITHUB_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // Transport errors can quote the request (an invalid header echoes its value), so keep only a code.
    const code = (error as { code?: unknown } | null)?.code;
    throw new Error(`GitHub ${method} ${route} request failed${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ""}`);
  }
  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const reported = typeof (parsed as { message?: unknown } | null)?.message === "string"
      ? (parsed as { message: string }).message
      : response.statusText;
    // The route never carries a credential; GitHub's own message is trimmed to printable text and scrubbed.
    // Scrub first: trimming first could cut an echoed credential into a fragment no pattern matches.
    const message = scrubSecrets(reported, credential ? [credential] : []).replace(/[^\x20-\x7e]/g, " ").slice(0, 200);
    throw new Error(`GitHub ${method} ${route} returned ${response.status}: ${message}`);
  }
  return parsed;
}

async function repositoryCredential(
  ctx: PluginContext,
  companyId: string,
  mirror: GitMirrorSettings,
  secrets: string[],
): Promise<string | null> {
  if (mirror.auth.kind === "none") return null;
  if (mirror.auth.kind === "token") {
    const token = await ctx.secrets.resolve(mirror.auth.tokenRef as SecretRef, { companyId, configPath: GIT_MIRROR_TOKEN_CONFIG_PATH });
    secrets.push(token);
    return assertHeaderSafe(token, "repository token");
  }
  const storedKey = await ctx.secrets.resolve(mirror.auth.privateKeyRef as SecretRef, {
    companyId,
    configPath: GIT_MIRROR_PRIVATE_KEY_CONFIG_PATH,
  });
  secrets.push(storedKey);
  // A PEM pasted through a single-line field arrives with escaped newlines.
  const privateKey = storedKey.includes("\n") ? storedKey : storedKey.replace(/\\n/g, "\n");
  let jwt: string;
  try {
    jwt = githubAppJwt(mirror.auth.appId, privateKey);
  } catch {
    throw new Error("The GitHub App private key could not sign a token; store the App's PEM key as the secret");
  }
  secrets.push(jwt);
  const minted = await github(
    ctx,
    "POST",
    `/app/installations/${mirror.auth.installationId}/access_tokens`,
    jwt,
    { repositories: [mirror.repo], permissions: { contents: "read" } },
  ) as { token?: unknown; permissions?: unknown; repositories?: unknown } | null;
  if (typeof minted?.token === "string") secrets.push(minted.token);
  const permissions = typeof minted?.permissions === "object" && minted.permissions !== null
    ? minted.permissions as Record<string, unknown>
    : {};
  const unexpected = Object.entries(permissions)
    .filter(([name, level]) => !ALLOWED_TOKEN_PERMISSIONS.has(name) || level !== "read")
    .map(([name]) => name);
  if (unexpected.length > 0 || permissions.contents !== "read") {
    throw new Error(`Refusing an installation token that grants more than contents: read (${unexpected.join(", ") || "no contents: read"})`);
  }
  const wanted = `${mirror.owner}/${mirror.repo}`.toLowerCase();
  const repositories = Array.isArray(minted?.repositories) ? minted.repositories as Array<{ full_name?: unknown }> : [];
  if (repositories.length !== 1 || String(repositories[0]?.full_name ?? "").toLowerCase() !== wanted) {
    throw new Error(`Refusing an installation token that is not narrowed to ${mirror.owner}/${mirror.repo}`);
  }
  if (typeof minted?.token !== "string" || !minted.token) throw new Error("GitHub returned no installation token");
  return assertHeaderSafe(minted.token, "installation token");
}

async function targetSpace(ctx: PluginContext, companyId: string, mirror: GitMirrorSettings): Promise<WikiSpace> {
  const spaceSlug = normalizeSpaceSlug(mirror.spaceSlug);
  try {
    return await resolveSpace(ctx, { companyId, spaceSlug });
  } catch (error) {
    if (spaceSlug === DEFAULT_SPACE_SLUG || !String((error as Error)?.message ?? "").includes("space not found")) throw error;
    return (await createSpace(ctx, { companyId, slug: spaceSlug, displayName: `${mirror.owner}/${mirror.repo}`, bootstrapFiles: false })).space;
  }
}

function rootIdentity(folder: { realPath: string | null; path: string | null }): string | null {
  return folder.realPath ?? folder.path;
}

/**
 * Field by field over both objects' keys: the stored source comes back from plugin state, a jsonb column,
 * which reorders object keys and drops undefined ones, so its JSON text never matches a freshly built one.
 */
function sameSource(stored: GitMirrorSource, current: GitMirrorSource): boolean {
  const a = stored as Record<string, unknown>;
  const b = current as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((field) => (a[field] ?? null) === (b[field] ?? null));
}

/**
 * Host mutations resolve the folder binding on every call, so a root reconfigured mid-run would receive
 * this run's writes and deletes. Each write, each delete and every state save first confirms the root is
 * still the one the run started on; a mismatch aborts before touching the new root, and the next run drops
 * the ledger for it. A reconfiguration landing between this check and the host call still wins; closing
 * that needs an expected-root parameter on the host mutations.
 */
async function assertRootUnchanged(ctx: PluginContext, companyId: string, rootPath: string | null): Promise<void> {
  const current = rootIdentity(await ctx.localFolders.status(companyId, WIKI_ROOT_FOLDER_KEY));
  if (current !== rootPath) throw new Error("The LLM Wiki root folder changed during the sync; the next sync reconciles the new root");
}

async function runSync(
  ctx: PluginContext,
  companyId: string,
  mirror: GitMirrorSettings,
  options: { force: boolean; budgetMs?: number },
): Promise<GitMirrorSyncResult> {
  const state = await readGitMirrorState(ctx, companyId);
  state.lastAttemptAt = new Date().toISOString();
  const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs;
  // Rewrite every owned file when asked to, or when the previous run stopped part-way without handing off
  // cleanly: its per-file ids may not match the disk (a write can land and still throw).
  const forceRequests = await readForceRequests(ctx, companyId);
  const forceRequested = forceRequests > state.forceConsumed;
  const rewriteAll = options.force || forceRequested || (state.inProgress && !state.resumable);
  const repository = `${mirror.owner}/${mirror.repo}`;
  const written: string[] = [];
  const deleted: string[] = [];
  // Every credential this run touches, scrubbed from anything it stores, logs or throws.
  const secrets: string[] = [];
  const markInProgress = async () => {
    if (state.inProgress) return;
    state.inProgress = true;
    await ctx.state.set(stateScope(companyId), state);
  };
  // Fetches, deletes and index reads spend the budget; every run does at least one so a continuation always advances.
  let ops = 0;
  const outOfTime = () => ops > 0 && Date.now() >= deadline;
  const budget: SyncBudget = { outOfTime, spend: () => { ops += 1; } };
  // Out of time with work left: save an accurate ledger and let a continuation run take over.
  const handOff = async (rootPath: string | null, spaceSlug: string, commitSha: string): Promise<GitMirrorSyncResult> => {
    await assertRootUnchanged(ctx, companyId, rootPath);
    state.resumable = true;
    state.lastError = null;
    await ctx.state.set(stateScope(companyId), state);
    return {
      status: "partial", repository, branch: mirror.branch, spaceSlug, commitSha,
      fileCount: Object.keys(state.files).length, written, deleted, skipped: state.skipped,
    };
  };
  try {
    if (mirror.error) throw new Error(`Git mirror configuration: ${mirror.error}`);
    let folder = await ctx.localFolders.status(companyId, WIKI_ROOT_FOLDER_KEY);
    if (!folder.configured || !folder.path) throw new Error("Configure the LLM Wiki root folder before the Git mirror can sync");
    if (!folder.writable || folder.missingDirectories.length > 0) {
      // Create the folder and the plugin's required directories the way bootstrap does, without its
      // starter files or managed agent: a repository rarely carries wiki/entities, concepts or synthesis,
      // and the Wiki page treats a root missing them as unconfigured.
      folder = await ctx.localFolders.configure({
        companyId,
        folderKey: WIKI_ROOT_FOLDER_KEY,
        path: folder.path,
        access: "readWrite",
        requiredDirectories: [...REQUIRED_WIKI_DIRECTORIES],
        requiredFiles: [...REQUIRED_WIKI_FILES],
      });
    }
    if (!folder.writable) throw new Error("The LLM Wiki root folder is not writable");

    const space = await targetSpace(ctx, companyId, mirror);
    const source: GitMirrorSource = {
      owner: mirror.owner,
      repo: mirror.repo,
      branch: mirror.branch,
      spaceSlug: space.slug,
      pathPrefix: space.pathPrefix,
      rootPath: rootIdentity(folder),
    };
    // A changed source touches nothing until its credential, branch, tree and limits have all checked out:
    // a misspelled branch or a repository past the limits must leave the working copy as it was.
    const previous = state.source && !sameSource(state.source, source) ? state.source : null;

    const credential = await repositoryCredential(ctx, companyId, mirror, secrets);
    const base = `/repos/${encodeURIComponent(mirror.owner)}/${encodeURIComponent(mirror.repo)}`;
    const branch = await github(ctx, "GET", `${base}/branches/${encodeURIComponent(mirror.branch)}`, credential) as {
      commit?: { sha?: unknown; commit?: { tree?: { sha?: unknown } } };
    } | null;
    const commitSha = typeof branch?.commit?.sha === "string" ? branch.commit.sha : null;
    const treeSha = typeof branch?.commit?.commit?.tree?.sha === "string" ? branch.commit.commit.tree.sha : null;
    if (!commitSha || !treeSha) throw new Error(`GitHub returned no commit for ${repository}@${mirror.branch}`);
    if (!OBJECT_ID.test(commitSha) || !OBJECT_ID.test(treeSha)) throw new Error(`GitHub returned a malformed object id for ${repository}@${mirror.branch}`);

    if (!previous && !options.force && !forceRequested && !state.inProgress && state.commitSha === commitSha) {
      await assertRootUnchanged(ctx, companyId, source.rootPath);
      state.source = source;
      state.indexedSpace = { id: space.id, companyId: space.companyId, wikiId: space.wikiId };
      if (!(await backfillPageIndex(ctx, companyId, state, space, budget))) return handOff(source.rootPath, space.slug, commitSha);
      state.lastError = null;
      await ctx.state.set(stateScope(companyId), state);
      return {
        status: "unchanged", repository, branch: mirror.branch, spaceSlug: space.slug, commitSha,
        fileCount: Object.keys(state.files).length, written, deleted, skipped: state.skipped,
      };
    }

    const tree = await github(ctx, "GET", `${base}/git/trees/${treeSha}?recursive=1`, credential) as {
      tree?: TreeEntry[];
      truncated?: unknown;
    } | null;
    if (tree?.truncated) throw new Error(`The ${repository} tree is too large for one listing; refusing a partial mirror`);
    const skipped: GitMirrorSkip[] = [];
    /** Page path (mirroredPagePath) -> the tree entry written there. */
    const wanted = new Map<string, TreeEntry>();
    let totalBytes = 0;
    const entries = (Array.isArray(tree?.tree) ? tree.tree : [])
      .filter((entry) => entry.type === "blob" && entry.mode !== "120000" && isMirrorablePath(entry.path));
    // A file already at its page path keeps it; a file that would move under wiki/ yields to it (stable sort).
    const moves = (entry: TreeEntry) => (mirroredPagePath(entry.path) === entry.path ? 0 : 1);
    entries.sort((a, b) => moves(a) - moves(b));
    for (const entry of entries) {
      if (typeof entry.sha !== "string" || !OBJECT_ID.test(entry.sha)) throw new Error(`GitHub returned a malformed object id for ${entry.path}`);
      const pagePath = mirroredPagePath(entry.path);
      if (!pagePath) {
        skipped.push({ path: entry.path, reason: "the wiki reads only .md pages" });
        continue;
      }
      const holder = wanted.get(pagePath);
      if (holder) {
        skipped.push({ path: entry.path, reason: `its wiki path ${pagePath} holds ${holder.path}` });
        continue;
      }
      if (typeof entry.size === "number" && entry.size > MAX_MIRROR_FILE_BYTES) {
        skipped.push({ path: entry.path, reason: `larger than ${MAX_MIRROR_FILE_BYTES} bytes` });
        continue;
      }
      totalBytes += entry.size ?? 0;
      wanted.set(pagePath, entry);
    }
    if (wanted.size > MAX_MIRROR_FILES) throw new Error(`${repository} has ${wanted.size} Markdown files; the mirror stops at ${MAX_MIRROR_FILES}`);
    if (totalBytes > MAX_MIRROR_TOTAL_BYTES) throw new Error(`${repository} has ${totalBytes} bytes of Markdown; the mirror stops at ${MAX_MIRROR_TOTAL_BYTES}`);

    await markInProgress();
    if (previous) {
      const oldIndexSpace = await ledgerIndexSpace(ctx, companyId, state);
      const sameTarget = previous.rootPath === source.rootPath
        && previous.spaceSlug === source.spaceSlug
        && (previous.pathPrefix ?? null) === (source.pathPrefix ?? null)
        && (!oldIndexSpace || oldIndexSpace.id === space.id);
      if (sameTarget) {
        // Only the repository or branch changed: the old copy stays readable while the new one replaces it.
        // Every owned file is rewritten from the new tree or removed by the delete pass below, and pending
        // marks make that resumable like a forced rewrite.
        for (const path of Object.keys(state.files)) state.files[path] = PENDING;
      } else {
        if (previous.rootPath === source.rootPath) {
          // A different space under the same root: the old copy belongs to nothing now.
          // Until this cleanup finishes, state.source stays the old source, so a continuation resumes it.
          for (const path of Object.keys(state.files)) {
            if (outOfTime()) return handOff(source.rootPath, space.slug, state.commitSha ?? "");
            await assertRootUnchanged(ctx, companyId, source.rootPath);
            if (oldIndexSpace) await unindexMirroredPages(ctx, oldIndexSpace, [path]);
            await ctx.localFolders.deleteFile(companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath({ pathPrefix: previous.pathPrefix }, path));
            delete state.files[path];
            deleted.push(path);
            ops += 1;
          }
        }
        // A different root: the ledger describes files under a folder this plugin no longer points at, so it
        // is dropped without deleting anything here, and the new root is reconciled from scratch. Their page
        // rows go: the read tools would look for those pages under the new root.
        if (oldIndexSpace) await unindexMirroredPages(ctx, oldIndexSpace, Object.keys(state.files));
        state.files = {};
      }
      state.skippedBlobs = {};
      state.commitSha = null;
      state.syncedAt = null;
      state.indexBacklog = null;
    }
    state.source = source;
    state.indexedSpace = { id: space.id, companyId: space.companyId, wikiId: space.wikiId };

    if (rewriteAll) {
      // Marking every owned file pending makes the rewrite resumable: a continuation finds them still pending.
      // Saved together with the consumed request count, so a request counts as served exactly when it takes
      // effect; one made after this run read the count stays pending for the next run.
      for (const path of Object.keys(state.files)) state.files[path] = PENDING;
      state.skippedBlobs = {};
      state.forceConsumed = Math.max(state.forceConsumed, forceRequests);
    }
    await takeIndexBacklog(ctx, state, space);
    // From here a crash leaves the ledger untrustworthy again, until a clean hand-off sets this back.
    state.resumable = false;
    await ctx.state.set(stateScope(companyId), state);

    for (const [path, entry] of [...wanted]) {
      if (state.files[path] === entry.sha) continue;
      const known = state.skippedBlobs[entry.path];
      if (known?.sha === entry.sha) {
        skipped.push({ path: entry.path, reason: known.reason });
        wanted.delete(path);
        continue;
      }
      if (outOfTime()) return handOff(source.rootPath, space.slug, commitSha);
      ops += 1;
      const blob = await github(ctx, "GET", `${base}/git/blobs/${entry.sha}`, credential) as { content?: unknown; encoding?: unknown } | null;
      if (blob?.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`GitHub returned no content for ${path}`);
      const bytes = Buffer.from(blob.content, "base64");
      if (gitBlobSha(bytes) !== entry.sha) throw new Error(`Content of ${entry.path} does not match its Git object id; refusing to write it`);
      // The tree's sizes are GitHub's word; the limits hold on the bytes actually received.
      totalBytes += bytes.length - (entry.size ?? 0);
      if (totalBytes > MAX_MIRROR_TOTAL_BYTES) throw new Error(`${repository} has more than ${MAX_MIRROR_TOTAL_BYTES} bytes of Markdown; the mirror stops there`);
      if (bytes.length > MAX_MIRROR_FILE_BYTES) {
        const reason = `larger than ${MAX_MIRROR_FILE_BYTES} bytes`;
        skipped.push({ path: entry.path, reason });
        state.skippedBlobs[entry.path] = { sha: entry.sha, reason };
        wanted.delete(path);
        continue;
      }
      let contents: string;
      try {
        contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        skipped.push({ path: entry.path, reason: "not UTF-8 text" });
        state.skippedBlobs[entry.path] = { sha: entry.sha, reason: "not UTF-8 text" };
        wanted.delete(path);
        continue;
      }
      await assertRootUnchanged(ctx, companyId, source.rootPath);
      if (!(path in state.files)) {
        // Claim a new path only now, validated and about to be written, and save the claim first: a write
        // can land and still throw, and the file must stay owned (deleted or rewritten later) if it does.
        state.files[path] = PENDING;
        await ctx.state.set(stateScope(companyId), state);
      }
      await ctx.localFolders.writeTextAtomic(companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, path), contents);
      // The blob id is recorded only once the page row matches the file, so a failed index write is redone.
      await indexMirroredPage(ctx, space, path, contents);
      state.files[path] = entry.sha;
      if (state.indexBacklog) delete state.indexBacklog[path];
      delete state.skippedBlobs[entry.path];
      written.push(path);
    }

    for (const path of Object.keys(state.files).filter((candidate) => !wanted.has(candidate))) {
      if (outOfTime()) return handOff(source.rootPath, space.slug, commitSha);
      await assertRootUnchanged(ctx, companyId, source.rootPath);
      await unindexMirroredPages(ctx, space, [path]);
      await ctx.localFolders.deleteFile(companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, path));
      delete state.files[path];
      deleted.push(path);
      ops += 1;
    }
    const treePaths = new Set((Array.isArray(tree?.tree) ? tree.tree : []).map((entry) => entry.path));
    for (const path of Object.keys(state.skippedBlobs)) if (!treePaths.has(path)) delete state.skippedBlobs[path];

    await assertRootUnchanged(ctx, companyId, source.rootPath);
    if (!(await backfillPageIndex(ctx, companyId, state, space, budget))) return handOff(source.rootPath, space.slug, commitSha);
    state.commitSha = commitSha;
    state.syncedAt = new Date().toISOString();
    state.lastError = null;
    state.inProgress = false;
    state.skipped = skipped.slice(0, MAX_SKIPPED_REPORTED);
    await ctx.state.set(stateScope(companyId), state);
    if (written.length > 0 || deleted.length > 0) {
      await ctx.activity.log({
        companyId,
        message: `LLM Wiki mirrored ${repository}@${mirror.branch} (${commitSha.slice(0, 12)}) into space "${space.slug}": ${written.length} written, ${deleted.length} removed`,
        entityType: "plugin",
        metadata: { repository, branch: mirror.branch, commitSha, spaceSlug: space.slug, written: written.length, deleted: deleted.length },
      });
    }
    return {
      status: "synced", repository, branch: mirror.branch, spaceSlug: space.slug, commitSha,
      fileCount: Object.keys(state.files).length, written, deleted, skipped: state.skipped,
    };
  } catch (error) {
    // Keep the per-file progress so the next run resumes; the commit only advances on a complete sync.
    const message = scrubSecrets(error instanceof Error ? error.message : String(error), secrets);
    state.lastError = message;
    await ctx.state.set(stateScope(companyId), state);
    throw new Error(message);
  }
}

/**
 * Sync one company's mirror now. The company's slot is reserved before the first await, so concurrent
 * callers share one run; a forced call (a config save, Sync now) queues behind the current run and then
 * reads the config afresh, and further calls join that queued run. Each run releases only its own
 * reservation.
 */
export function syncGitMirror(
  ctx: PluginContext,
  companyId: string,
  options: { force?: boolean; budgetMs?: number } = {},
): Promise<GitMirrorSyncResult> {
  // At most one run in flight and one queued behind it per company: repeated forced calls join the queued one.
  const queued = waiting.get(companyId);
  if (queued) return queued;
  const previous = running.get(companyId);
  if (previous && !options.force) return previous;
  // Read inside only after the first await, by which time the assignment below has happened.
  let run!: Promise<GitMirrorSyncResult>;
  run = (async () => {
    if (previous) {
      await previous.catch(() => undefined);
      if (waiting.get(companyId) === run) waiting.delete(companyId);
    }
    const mirror = readGitMirrorConfig(await ctx.config.get(companyId));
    if (!mirror) throw new Error("The Git mirror is not enabled for this company");
    return runSync(ctx, companyId, mirror, { force: options.force === true, budgetMs: options.budgetMs });
  })();
  running.set(companyId, run);
  if (previous) waiting.set(companyId, run);
  const release = () => {
    if (running.get(companyId) === run) running.delete(companyId);
  };
  run.then(release, release);
  return run;
}

/** Record a forced rewrite request before it is queued, so it survives a lost event or a worker crash. */
/**
 * Per-company queue for the force counter's read-then-write. Only this worker writes the counter, so running
 * the increments one at a time makes each one atomic: overlapping requests cannot overwrite each other.
 */
const forceRequestQueues = new Map<string, Promise<void>>();

export function requestForcedGitMirrorRewrite(ctx: PluginContext, companyId: string): Promise<void> {
  const previous = forceRequestQueues.get(companyId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await ctx.state.set(forceScope(companyId), { requested: (await readForceRequests(ctx, companyId)) + 1 });
  });
  forceRequestQueues.set(companyId, next);
  const release = () => {
    if (forceRequestQueues.get(companyId) === next) forceRequestQueues.delete(companyId);
  };
  next.then(release, release);
  return next;
}

export async function getGitMirrorStatus(ctx: PluginContext, companyId: string): Promise<GitMirrorStatus> {
  const mirror = readGitMirrorConfig(await ctx.config.get(companyId));
  const state = await readGitMirrorState(ctx, companyId);
  let spaceSlug = mirror?.spaceSlug ?? null;
  try {
    if (spaceSlug) spaceSlug = normalizeSpaceSlug(spaceSlug);
  } catch {
    // Reported through configError on the next sync attempt.
  }
  return {
    enabled: mirror !== null,
    configError: mirror?.error ?? null,
    repository: mirror ? `${mirror.owner}/${mirror.repo}` : null,
    branch: mirror?.branch ?? null,
    spaceSlug,
    auth: mirror?.auth.kind ?? null,
    running: running.has(companyId),
    continuing: state.inProgress && state.resumable,
    forcePending: (await readForceRequests(ctx, companyId)) > state.forceConsumed,
    commitSha: state.commitSha,
    syncedAt: state.syncedAt,
    lastAttemptAt: state.lastAttemptAt,
    lastError: state.lastError,
    fileCount: Object.keys(state.files).length,
    skipped: state.skipped,
  };
}
