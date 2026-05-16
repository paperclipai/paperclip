import path from "path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { Volume, createFsFromVolume } from "memfs";

import { unprocessable } from "../errors.js";

export type ParsedGitSource = {
  cloneUrl: string;
  hostname: string;
  owner: string;
  repo: string;
  ref: string | null;
  basePath: string;
  filePath: string | null;
  explicitRef: boolean;
};

export type RefResolution = {
  pinnedSha: string;
  trackingRef: string | null;
};

export type RepoSnapshot = {
  sha: string;
  listFiles(): Promise<string[]>;
  readFile(repoPath: string): Promise<string>;
};

const SHA_REGEX = /^[0-9a-f]{40}$/i;

export function buildCloneUrl(hostname: string, owner: string, repo: string): string {
  return `https://${hostname}/${owner}/${repo}.git`;
}

export function parseGitSourceUrl(rawUrl: string): ParsedGitSource {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw unprocessable("Invalid git source URL");
  }
  if (url.protocol !== "https:") {
    throw unprocessable("Source URL must use HTTPS");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw unprocessable("Source URL must include an owner and repository");
  }
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/i, "");

  let ref: string | null = null;
  let basePath = "";
  let filePath: string | null = null;
  let explicitRef = false;
  let tail: string[] = [];

  // Recognise common host-specific URL shapes so users can paste a tree/blob link.
  if (segments[2] === "tree" || segments[2] === "blob") {
    // github.com style
    ref = segments[3] ?? null;
    tail = segments.slice(4);
    explicitRef = ref !== null;
  } else if (segments[2] === "src" && (segments[3] === "branch" || segments[3] === "commit" || segments[3] === "tag")) {
    // gitea / forgejo style
    ref = segments[4] ?? null;
    tail = segments.slice(5);
    explicitRef = ref !== null;
  } else if (segments[2] === "-" && (segments[3] === "tree" || segments[3] === "blob")) {
    // gitlab style: /{owner}/{repo}/-/tree/{ref}/{path}
    ref = segments[4] ?? null;
    tail = segments.slice(5);
    explicitRef = ref !== null;
  } else if (segments[2] === "src" && segments.length >= 4) {
    // bitbucket style: /{owner}/{repo}/src/{ref}/{path}
    ref = segments[3] ?? null;
    tail = segments.slice(4);
    explicitRef = ref !== null;
  }

  if (segments[2] === "blob" || (segments[2] === "-" && segments[3] === "blob")) {
    const joined = tail.join("/");
    filePath = joined || null;
    basePath = filePath ? path.posix.dirname(filePath) : "";
    if (basePath === ".") basePath = "";
  } else if (tail.length > 0) {
    const joined = tail.join("/");
    // Heuristic: if the last segment looks like a file (has an extension), treat as file
    const last = tail[tail.length - 1]!;
    if (/\.[A-Za-z0-9]+$/.test(last)) {
      filePath = joined;
      basePath = path.posix.dirname(joined);
      if (basePath === ".") basePath = "";
    } else {
      basePath = joined;
    }
  }

  return {
    cloneUrl: buildCloneUrl(url.hostname, owner, repo),
    hostname: url.hostname,
    owner,
    repo,
    ref,
    basePath,
    filePath,
    explicitRef,
  };
}

function buildAuthCallback(authToken: string | undefined) {
  if (!authToken) return undefined;
  // Universal pattern: token-as-username works for GitHub PATs (classic and fine-grained),
  // GitLab project/personal access tokens, Gitea/Forgejo tokens, and Bitbucket app passwords
  // when used over the git smart-HTTP protocol.
  return () => ({ username: authToken, password: "x-oauth-basic" });
}

async function withGitErrors<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP Error: 401/i.test(message)) {
      throw unprocessable(`${label}: authentication required or token rejected`);
    }
    if (/HTTP Error: 403/i.test(message)) {
      throw unprocessable(`${label}: access forbidden`);
    }
    if (/HTTP Error: 404/i.test(message) || /repository not found/i.test(message)) {
      throw unprocessable(`${label}: repository not found`);
    }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
      throw unprocessable(`${label}: could not connect to host`);
    }
    throw unprocessable(`${label}: ${message}`);
  }
}

export async function resolveGitRef(
  parsed: ParsedGitSource,
  authToken?: string,
): Promise<RefResolution> {
  const onAuth = buildAuthCallback(authToken);

  if (parsed.ref && SHA_REGEX.test(parsed.ref.trim())) {
    return {
      pinnedSha: parsed.ref.trim().toLowerCase(),
      trackingRef: parsed.explicitRef ? parsed.ref.trim() : null,
    };
  }

  const refs = await withGitErrors(`Resolve refs for ${parsed.cloneUrl}`, () =>
    git.listServerRefs({
      http,
      url: parsed.cloneUrl,
      onAuth,
      symrefs: true,
      protocolVersion: 2,
    }),
  );

  const findExact = (fullRef: string) => refs.find((r) => r.ref === fullRef);

  if (!parsed.ref) {
    const head = refs.find((r) => r.ref === "HEAD");
    if (!head?.oid) {
      throw unprocessable(`Could not determine default branch for ${parsed.cloneUrl}`);
    }
    const target = head.target?.replace(/^refs\/heads\//, "") ?? null;
    return { pinnedSha: head.oid, trackingRef: target };
  }

  const wanted = parsed.ref.replace(/^refs\/(heads|tags)\//, "");
  const branch = findExact(`refs/heads/${wanted}`);
  if (branch?.oid) return { pinnedSha: branch.oid, trackingRef: wanted };

  // Prefer the peeled (annotated) tag oid when present, else the tag object oid.
  const peeled = findExact(`refs/tags/${wanted}^{}`);
  if (peeled?.oid) return { pinnedSha: peeled.oid, trackingRef: wanted };
  const tag = findExact(`refs/tags/${wanted}`);
  if (tag?.oid) return { pinnedSha: tag.oid, trackingRef: wanted };

  throw unprocessable(`Ref '${parsed.ref}' not found in ${parsed.cloneUrl}`);
}

export async function openRepoSnapshot(
  parsed: ParsedGitSource,
  trackingRef: string | null,
  expectedSha: string,
  authToken?: string,
): Promise<RepoSnapshot> {
  const volume = new Volume();
  const fs = createFsFromVolume(volume) as unknown as Parameters<typeof git.clone>[0]["fs"];
  const dir = "/repo";
  const onAuth = buildAuthCallback(authToken);

  await withGitErrors(`Clone ${parsed.cloneUrl}`, async () => {
    await git.clone({
      fs,
      http,
      dir,
      url: parsed.cloneUrl,
      ref: trackingRef ?? expectedSha,
      singleBranch: true,
      depth: 1,
      noCheckout: true,
      onAuth,
    });
  });

  // Re-resolve to the actual commit cloned. If upstream moved between resolveGitRef and
  // clone, we trust what we cloned (snapshot is self-consistent).
  const sha = await git.resolveRef({ fs, dir, ref: "HEAD" });

  async function listFiles(): Promise<string[]> {
    const out: string[] = [];
    await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: sha })],
      map: async (filepath, entries) => {
        if (filepath === ".") return;
        const entry = entries?.[0];
        if (!entry) return;
        const type = await entry.type();
        if (type === "blob") {
          out.push(filepath);
        }
      },
    });
    return out;
  }

  async function readFile(repoPath: string): Promise<string> {
    const normalized = repoPath.replace(/^\/+/, "");
    const { blob } = await git.readBlob({ fs, dir, oid: sha, filepath: normalized });
    return new TextDecoder("utf-8").decode(blob);
  }

  return { sha, listFiles, readFile };
}
