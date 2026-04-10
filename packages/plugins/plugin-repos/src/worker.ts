import { promises as fs } from "node:fs";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, REGISTRY_PATH } from "./constants.js";

export type RepoEntry = {
  name: string;
  description?: string;
  githubUrl: string;
  localPath: string;
  defaultBranch: string;
  deployUrl?: string | null;
  railwayProjectId?: string | null;
  railwayServiceId?: string | null;
  stack?: string[];
  activeWorktrees?: WorktreeEntry[];
};

export type WorktreeEntry = {
  issueId: string;
  branch: string;
  path: string;
  createdAt: string;
};

export type ReposRegistry = {
  version: number;
  repos: RepoEntry[];
};

export type GitHubStats = {
  openPRs: number;
  lastCommitDate: string | null;
  stars: number | null;
};

export type EnrichedRepo = RepoEntry & {
  isCloned: boolean;
  githubStats?: GitHubStats;
  fetchedAt?: string;
};

export type ReposData = {
  repos: EnrichedRepo[];
  fetchedAt: string;
  registryPath: string;
};

async function readRegistry(): Promise<ReposRegistry> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf-8");
    return JSON.parse(raw) as ReposRegistry;
  } catch {
    return { version: 1, repos: [] };
  }
}

async function isCloned(localPath: string): Promise<boolean> {
  try {
    await fs.access(`${localPath}/.git`);
    return true;
  } catch {
    return false;
  }
}

async function fetchGitHubStats(
  githubUrl: string,
  token: string | null
): Promise<GitHubStats | undefined> {
  try {
    const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) return undefined;
    const [, owner, repo] = match;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const [repoRes, prsRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }),
      fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`, { headers }),
    ]);

    if (!repoRes.ok) return undefined;
    const repoData = await repoRes.json() as { pushed_at?: string; stargazers_count?: number };
    const prsData = prsRes.ok ? (await prsRes.json() as unknown[]) : [];

    return {
      openPRs: Array.isArray(prsData) ? prsData.length : 0,
      lastCommitDate: repoData.pushed_at ?? null,
      stars: repoData.stargazers_count ?? null,
    };
  } catch {
    return undefined;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} plugin starting`);

    ctx.data.register("repos", async () => {
      const registry = await readRegistry();
      let githubToken: string | null = null;

      try {
        const config = (await ctx.state.get({
          scopeKind: "instance",
          stateKey: "config",
        })) as { githubTokenRef?: string } | null;
        if (config?.githubTokenRef) {
          githubToken = await ctx.secrets.resolve(config.githubTokenRef);
        }
      } catch {
        // No token configured — fine, GitHub stats are optional
      }

      const enriched: EnrichedRepo[] = await Promise.all(
        registry.repos.map(async (repo) => {
          const cloned = await isCloned(repo.localPath);
          const stats = await fetchGitHubStats(repo.githubUrl, githubToken);
          return {
            ...repo,
            isCloned: cloned,
            ...(stats ? { githubStats: stats } : {}),
            fetchedAt: new Date().toISOString(),
          };
        })
      );

      return {
        repos: enriched,
        fetchedAt: new Date().toISOString(),
        registryPath: REGISTRY_PATH,
      } satisfies ReposData;
    });

    ctx.logger.info(`${PLUGIN_ID} ready`);
  },

  async onHealth() {
    try {
      await fs.access(REGISTRY_PATH);
      return { status: "ok", message: "Registry accessible" };
    } catch {
      return { status: "ok", message: "Registry not found (will create on first clone)" };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
