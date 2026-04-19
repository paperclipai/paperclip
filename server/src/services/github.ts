/**
 * GitHub file service — proxies GitHub Contents API for reading and writing
 * files in a project's linked repository.
 *
 * Uses the company-scoped `GITHUB_TOKEN` secret for authentication.
 * All write operations go through GitHub's PUT /contents endpoint which
 * provides built-in SHA-based conflict detection.
 */

import type { Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import { projectService } from "./projects.js";
import { badRequest, notFound, conflict, forbidden } from "../errors.js";

export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
  encoding: string;
  htmlUrl: string;
}

export interface GitHubFileWriteResult {
  path: string;
  sha: string;
  commitSha: string;
  htmlUrl: string;
}

interface GitHubApiError {
  message: string;
  documentation_url?: string;
}

/** Parse owner/repo from a GitHub URL (HTTPS or git@). */
function parseRepoFromUrl(repoUrl: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  const httpsMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  // SSH: git@github.com:owner/repo.git
  const sshMatch = repoUrl.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  return null;
}

async function githubFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Paperclip-GitHub-Sync/1.0",
      ...(init?.headers ?? {}),
    },
  });
}

export function githubService(db: Db) {
  const secrets = secretService(db);
  const projects = projectService(db);

  /** Resolve a GitHub token for the given company from secrets. */
  async function resolveGitHubToken(companyId: string): Promise<string> {
    const secret = await secrets.getByName(companyId, "GITHUB_TOKEN");
    if (!secret) {
      throw badRequest(
        "No GITHUB_TOKEN secret configured for this company. " +
          "Create a company secret named GITHUB_TOKEN with a GitHub personal access token.",
      );
    }
    // Resolve latest version value
    const { env } = await secrets.resolveEnvBindings(companyId, {
      GITHUB_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" },
    });
    const token = env.GITHUB_TOKEN;
    if (!token) {
      throw badRequest("GITHUB_TOKEN secret is empty.");
    }
    return token;
  }

  /** Resolve owner/repo from a project's primary workspace repoUrl. */
  async function resolveRepo(projectId: string): Promise<{ owner: string; repo: string; companyId: string }> {
    const project = await projects.getById(projectId);
    if (!project) throw notFound("Project not found");

    const workspace = project.primaryWorkspace;
    if (!workspace?.repoUrl) {
      throw badRequest("Project has no linked GitHub repository. Set repoUrl on the project workspace.");
    }

    const parsed = parseRepoFromUrl(workspace.repoUrl);
    if (!parsed) {
      throw badRequest(`Cannot parse GitHub owner/repo from URL: ${workspace.repoUrl}`);
    }

    return { ...parsed, companyId: project.companyId };
  }

  return {
    /**
     * Read a file from the project's GitHub repository.
     * Returns the file content (base64-decoded), SHA, and metadata.
     */
    async getFile(projectId: string, filePath: string, ref?: string): Promise<GitHubFileContent> {
      const { owner, repo, companyId } = await resolveRepo(projectId);
      const token = await resolveGitHubToken(companyId);

      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`);
      if (ref) url.searchParams.set("ref", ref);

      const res = await githubFetch(url.toString(), token);

      if (res.status === 404) {
        throw notFound(`File not found: ${filePath}`);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as GitHubApiError | null;
        throw badRequest(`GitHub API error: ${body?.message ?? res.statusText}`);
      }

      const data = await res.json();

      // GitHub returns an array for directories
      if (Array.isArray(data)) {
        throw badRequest(`Path is a directory, not a file: ${filePath}`);
      }

      return {
        name: data.name,
        path: data.path,
        sha: data.sha,
        size: data.size,
        content: Buffer.from(data.content, "base64").toString("utf-8"),
        encoding: "utf-8",
        htmlUrl: data.html_url,
      };
    },

    /**
     * Write (create or update) a file in the project's GitHub repository.
     * Uses the SHA for optimistic concurrency — if the file has changed since
     * the caller last read it, GitHub returns 409 and we surface a conflict error.
     */
    async putFile(
      projectId: string,
      filePath: string,
      opts: {
        content: string;
        message: string;
        sha?: string; // required for updates, omit for creates
        branch?: string;
      },
    ): Promise<GitHubFileWriteResult> {
      const { owner, repo, companyId } = await resolveRepo(projectId);
      const token = await resolveGitHubToken(companyId);

      const body: Record<string, unknown> = {
        message: opts.message,
        content: Buffer.from(opts.content, "utf-8").toString("base64"),
      };
      if (opts.sha) body.sha = opts.sha;
      if (opts.branch) body.branch = opts.branch;

      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
      const res = await githubFetch(url, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 409) {
        throw conflict(
          "Version conflict: the file has been modified since you last loaded it. " +
            "Reload the file to get the latest version before saving.",
        );
      }

      if (res.status === 404) {
        throw notFound(`Repository or path not found: ${owner}/${repo}/${filePath}`);
      }

      if (res.status === 403) {
        throw forbidden("GitHub token does not have write access to this repository.");
      }

      if (!res.ok) {
        const errorBody = (await res.json().catch(() => null)) as GitHubApiError | null;
        throw badRequest(`GitHub API error: ${errorBody?.message ?? res.statusText}`);
      }

      const data = await res.json();

      return {
        path: data.content.path,
        sha: data.content.sha,
        commitSha: data.commit.sha,
        htmlUrl: data.content.html_url,
      };
    },

    /**
     * List files in a directory of the project's GitHub repository.
     */
    async listFiles(
      projectId: string,
      dirPath: string = "",
      ref?: string,
    ): Promise<Array<{ name: string; path: string; type: "file" | "dir"; sha: string; size: number }>> {
      const { owner, repo, companyId } = await resolveRepo(projectId);
      const token = await resolveGitHubToken(companyId);

      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`);
      if (ref) url.searchParams.set("ref", ref);

      const res = await githubFetch(url.toString(), token);

      if (res.status === 404) {
        throw notFound(`Path not found: ${dirPath || "/"}`);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as GitHubApiError | null;
        throw badRequest(`GitHub API error: ${body?.message ?? res.statusText}`);
      }

      const data = await res.json();
      if (!Array.isArray(data)) {
        // Single file, not a directory — return it as a single-element array
        return [{ name: data.name, path: data.path, type: "file", sha: data.sha, size: data.size }];
      }

      return data.map((item: { name: string; path: string; type: string; sha: string; size: number }) => ({
        name: item.name,
        path: item.path,
        type: item.type === "dir" ? ("dir" as const) : ("file" as const),
        sha: item.sha,
        size: item.size ?? 0,
      }));
    },

    /** Expose for route-level use */
    resolveRepo,
    resolveGitHubToken,
  };
}
