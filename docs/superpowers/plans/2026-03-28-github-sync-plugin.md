# GitHub Sync Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Paperclip plugin that bidirectionally syncs GitHub issues with Paperclip, assigns agents via labels, and creates PRs when agents complete work.

**Architecture:** Single all-in-one plugin using the Plugin SDK. GitHub App authentication with JWT token management. Hybrid webhook + polling for reliability. Plugin state for all mappings. No external dependencies.

**Tech Stack:** TypeScript, Paperclip Plugin SDK, GitHub REST API, React (UI), esbuild (UI bundling)

**Spec:** `docs/superpowers/specs/2026-03-28-github-sync-plugin-design.md`

**Working directory:** `/Users/sebastienpincemail/Lab/beezzonline/paperclip/.worktrees/github-sync`

---

## File Structure

```
packages/plugins/plugin-github-sync/
├── src/
│   ├── constants.ts          # Plugin ID, keys, config defaults
│   ├── manifest.ts           # Plugin manifest declaration
│   ├── worker.ts             # Plugin setup, event handlers, lifecycle
│   ├── index.ts              # Re-exports manifest + worker
│   ├── github/
│   │   ├── auth.ts           # GitHub App JWT + installation token management
│   │   ├── client.ts         # GitHub API client (issues, PRs, branches, labels, comments)
│   │   ├── webhook.ts        # Webhook signature validation + event parsing
│   │   └── types.ts          # GitHub API response types
│   ├── sync/
│   │   ├── inbound.ts        # GitHub → Paperclip sync logic
│   │   ├── outbound.ts       # Paperclip → GitHub sync logic
│   │   ├── mapping.ts        # State-based bidirectional mapping helpers
│   │   ├── dedup.ts          # Deduplication + anti-loop logic
│   │   └── poll.ts           # Polling job logic
│   └── ui/
│       ├── index.tsx          # UI entry point, exports all slots
│       ├── DashboardWidget.tsx # Sync status overview widget
│       ├── SettingsPage.tsx    # Plugin configuration form
│       └── IssueDetailTab.tsx  # GitHub tab on issue detail
├── scripts/
│   └── build-ui.mjs          # esbuild config for UI bundle
├── package.json
└── tsconfig.json
```

---

## Task 1: Scaffold plugin package

**Files:**
- Create: `packages/plugins/plugin-github-sync/package.json`
- Create: `packages/plugins/plugin-github-sync/tsconfig.json`
- Create: `packages/plugins/plugin-github-sync/scripts/build-ui.mjs`
- Create: `packages/plugins/plugin-github-sync/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@paperclipai/plugin-github-sync",
  "version": "0.1.0",
  "description": "Bidirectional GitHub issue sync with agent assignment and PR creation",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "scripts": {
    "prebuild": "node ../../../../scripts/ensure-plugin-build-deps.mjs",
    "build": "tsc && node ./scripts/build-ui.mjs",
    "clean": "rm -rf dist",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk build && tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*",
    "@paperclipai/shared": "workspace:*"
  },
  "devDependencies": {
    "esbuild": "^0.27.3",
    "@types/node": "^24.6.0",
    "@types/react": "^19.0.8",
    "@types/react-dom": "^19.0.3",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "typescript": "^5.7.3"
  },
  "peerDependencies": {
    "react": ">=18"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2023", "DOM"],
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create build-ui.mjs**

```javascript
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
  ],
  logLevel: "info",
});
```

- [ ] **Step 4: Create src/index.ts**

```typescript
export { default as manifest } from "./manifest.js";
export { default as plugin } from "./worker.js";
```

- [ ] **Step 5: Create .gitignore**

```
dist/
node_modules/
```

- [ ] **Step 6: Install dependencies**

Run: `cd packages/plugins/plugin-github-sync && pnpm install`

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/plugin-github-sync/
git commit -m "feat(github-sync): scaffold plugin package"
```

---

## Task 2: Constants and manifest

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/constants.ts`
- Create: `packages/plugins/plugin-github-sync/src/manifest.ts`

- [ ] **Step 1: Create constants.ts**

```typescript
export const PLUGIN_ID = "paperclip.github-sync";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  poll: "github-poll",
} as const;

export const WEBHOOK_KEYS = {
  githubEvents: "github-events",
} as const;

export const SLOT_IDS = {
  dashboardWidget: "github-sync-dashboard",
  settingsPage: "github-sync-settings",
  issueTab: "github-sync-issue-tab",
} as const;

export const EXPORT_NAMES = {
  dashboardWidget: "DashboardWidget",
  settingsPage: "SettingsPage",
  issueTab: "IssueDetailTab",
} as const;

export const DATA_KEYS = {
  syncStatus: "sync-status",
  issueGithubInfo: "issue-github-info",
} as const;

export const ACTION_KEYS = {
  forceSyncNow: "force-sync-now",
  testConnection: "test-connection",
} as const;

export const STATE_KEYS = {
  repos: "repos",
  unlinkedRepos: "unlinked-repos",
  agentsCache: "agents-cache",
  processedDeliveries: "processed-deliveries",
  rateLimit: "rate-limit",
} as const;

export const DEFAULT_CONFIG = {
  pollIntervalMinutes: 5,
  syncLabelsPrefix: "agent:",
};

export const SYNC_NONCE_PREFIX = "<!-- paperclip-sync:";
export const SYNC_NONCE_SUFFIX = " -->";
export const SYNC_NONCE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const AGENTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const DELIVERY_RING_BUFFER_SIZE = 1000;
export const GITHUB_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry
```

- [ ] **Step 2: Create manifest.ts**

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub Sync",
  description:
    "Bidirectional GitHub issue sync with agent assignment via labels and PR creation by agents.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "agents.read",
    "companies.read",
    "projects.read",
    "activity.log.write",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      githubAppId: {
        type: "string",
        title: "GitHub App ID",
      },
      githubInstallationId: {
        type: "string",
        title: "Installation ID",
      },
      privateKeySecret: {
        type: "string",
        title: "Private Key Secret Reference",
        description: "Secret reference to the GitHub App private key (PEM)",
      },
      orgName: {
        type: "string",
        title: "GitHub Organization",
      },
      companyId: {
        type: "string",
        title: "Paperclip Company ID",
      },
      pollIntervalMinutes: {
        type: "number",
        title: "Poll Interval (minutes)",
        default: DEFAULT_CONFIG.pollIntervalMinutes,
        minimum: 1,
        maximum: 30,
      },
      syncLabelsPrefix: {
        type: "string",
        title: "Agent Label Prefix",
        default: DEFAULT_CONFIG.syncLabelsPrefix,
      },
      webhookSecretRef: {
        type: "string",
        title: "Webhook Secret Reference",
        description: "Secret reference for webhook signature validation",
      },
    },
    required: [
      "githubAppId",
      "githubInstallationId",
      "privateKeySecret",
      "orgName",
      "companyId",
      "webhookSecretRef",
    ],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.poll,
      displayName: "GitHub Poll",
      description: "Polls GitHub for issue and PR changes missed by webhooks.",
      schedule: "*/5 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.githubEvents,
      displayName: "GitHub Events",
      description: "Receives GitHub webhook payloads for issues and pull requests.",
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "GitHub Sync",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "GitHub Sync Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "GitHub",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/constants.ts packages/plugins/plugin-github-sync/src/manifest.ts
git commit -m "feat(github-sync): add constants and manifest"
```

---

## Task 3: GitHub authentication module

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/github/types.ts`
- Create: `packages/plugins/plugin-github-sync/src/github/auth.ts`

- [ ] **Step 1: Create github/types.ts**

Define TypeScript types for GitHub API responses and plugin config:

```typescript
export interface GitHubSyncConfig {
  githubAppId: string;
  githubInstallationId: string;
  privateKeySecret: string;
  orgName: string;
  companyId: string;
  pollIntervalMinutes: number;
  syncLabelsPrefix: string;
  webhookSecretRef: string;
}

export interface GitHubInstallationToken {
  token: string;
  expiresAt: Date;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  updated_at: string;
  created_at: string;
  html_url: string;
  user: { login: string; id: number };
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  updated_at: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  archived: boolean;
  html_url: string;
}

export interface GitHubWebhookPayload {
  action: string;
  issue?: GitHubIssue;
  pull_request?: GitHubPullRequest;
  repository: GitHubRepo;
  sender: { id: number; login: string };
  installation?: { id: number };
}

export interface GitHubTreeEntry {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  sha?: string;
  content?: string;
}

export interface GitHubCreateTreeResponse {
  sha: string;
}

export interface GitHubCreateCommitResponse {
  sha: string;
}

export interface GitHubCreatePRResponse {
  number: number;
  html_url: string;
}

export interface GitHubRef {
  ref: string;
  object: { sha: string };
}
```

- [ ] **Step 2: Create github/auth.ts**

GitHub App JWT generation and installation token management. Uses Web Crypto API (available in Node.js) to sign JWTs without external dependencies:

```typescript
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubInstallationToken, GitHubSyncConfig } from "./types.js";
import { GITHUB_TOKEN_REFRESH_MARGIN_MS } from "../constants.js";

let cachedToken: GitHubInstallationToken | null = null;

function base64UrlEncode(data: Uint8Array): string {
  const base64 = Buffer.from(data).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  };

  const encoder = new TextEncoder();
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Import private key
  const pemContents = privateKeyPem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput)),
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function getInstallationToken(
  ctx: PluginContext,
  config: GitHubSyncConfig,
): Promise<string> {
  // Return cached token if still valid
  if (
    cachedToken &&
    cachedToken.expiresAt.getTime() - Date.now() > GITHUB_TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedToken.token;
  }

  const privateKey = await ctx.secrets.resolve(config.privateKeySecret);
  const jwt = await createJwt(config.githubAppId, privateKey);

  const response = await ctx.http.fetch(
    `https://api.github.com/app/installations/${config.githubInstallationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  cachedToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  };

  ctx.logger.info("GitHub installation token refreshed", {
    expiresAt: data.expires_at,
  });

  return cachedToken.token;
}

export function clearTokenCache(): void {
  cachedToken = null;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/github/
git commit -m "feat(github-sync): add GitHub types and auth module"
```

---

## Task 4: GitHub API client

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/github/client.ts`

- [ ] **Step 1: Create github/client.ts**

Wraps all GitHub REST API calls with token management, rate limit tracking, and retry logic:

```typescript
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getInstallationToken } from "./auth.js";
import type {
  GitHubCreateCommitResponse,
  GitHubCreatePRResponse,
  GitHubCreateTreeResponse,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRef,
  GitHubRepo,
  GitHubSyncConfig,
  GitHubTreeEntry,
} from "./types.js";
import { STATE_KEYS } from "../constants.js";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

export class GitHubClient {
  constructor(
    private ctx: PluginContext,
    private config: GitHubSyncConfig,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retryCount = 0,
  ): Promise<T> {
    const token = await getInstallationToken(this.ctx, this.config);
    const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;

    const response = await this.ctx.http.fetch(url, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // Track rate limit
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAt = response.headers.get("x-ratelimit-reset");
    if (remaining && resetAt) {
      await this.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.rateLimit },
        { remaining: parseInt(remaining, 10), resetAt: parseInt(resetAt, 10) * 1000 },
      );
    }

    // Handle rate limit
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
      this.ctx.logger.warn("GitHub rate limit hit, waiting", { waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
      return this.request<T>(method, path, body, retryCount);
    }

    // Retry on server errors
    if (response.status >= 500 && retryCount < MAX_RETRIES) {
      const waitMs = BACKOFF_BASE_MS * Math.pow(4, retryCount);
      this.ctx.logger.warn("GitHub server error, retrying", {
        status: response.status,
        retryCount,
        waitMs,
      });
      await new Promise((r) => setTimeout(r, waitMs));
      return this.request<T>(method, path, body, retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  // Rate limit check
  async isRateLimitSafe(): Promise<boolean> {
    const state = (await this.ctx.state.get({
      scopeKind: "instance",
      stateKey: STATE_KEYS.rateLimit,
    })) as { remaining: number; resetAt: number } | null;
    if (!state) return true;
    if (state.remaining < 100 && Date.now() < state.resetAt) return false;
    return true;
  }

  // Repos
  async listOrgRepos(): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];
    let page = 1;
    while (true) {
      const batch = await this.request<GitHubRepo[]>(
        "GET",
        `/orgs/${this.config.orgName}/repos?per_page=100&page=${page}`,
      );
      repos.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return repos;
  }

  // Issues
  async listIssuesSince(
    repoFullName: string,
    since: string,
  ): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    let page = 1;
    while (true) {
      const batch = await this.request<GitHubIssue[]>(
        "GET",
        `/repos/${repoFullName}/issues?state=all&sort=updated&direction=desc&since=${since}&per_page=100&page=${page}`,
      );
      issues.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    // Filter out PRs (GitHub API includes PRs in issues endpoint)
    return issues.filter((i) => !("pull_request" in i));
  }

  async listOpenIssues(repoFullName: string): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    let page = 1;
    while (true) {
      const batch = await this.request<GitHubIssue[]>(
        "GET",
        `/repos/${repoFullName}/issues?state=open&sort=updated&per_page=100&page=${page}`,
      );
      issues.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return issues.filter((i) => !("pull_request" in i));
  }

  async addComment(
    repoFullName: string,
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/repos/${repoFullName}/issues/${issueNumber}/comments`,
      { body },
    );
  }

  async addLabel(
    repoFullName: string,
    issueNumber: number,
    label: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/repos/${repoFullName}/issues/${issueNumber}/labels`,
      { labels: [label] },
    );
  }

  async removeLabel(
    repoFullName: string,
    issueNumber: number,
    label: string,
  ): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/repos/${repoFullName}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      );
    } catch {
      // Label may not exist, ignore
    }
  }

  // Pull Requests
  async listClosedPRsSince(
    repoFullName: string,
    since: string,
  ): Promise<GitHubPullRequest[]> {
    const prs = await this.request<GitHubPullRequest[]>(
      "GET",
      `/repos/${repoFullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
    );
    // Client-side filter since GitHub doesn't support `since` param on PRs
    return prs.filter((pr) => new Date(pr.updated_at) >= new Date(since));
  }

  async createPR(
    repoFullName: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<GitHubCreatePRResponse> {
    return this.request<GitHubCreatePRResponse>(
      "POST",
      `/repos/${repoFullName}/pulls`,
      { title, body, head, base },
    );
  }

  // Git operations (for pushing code)
  async getRef(repoFullName: string, ref: string): Promise<GitHubRef> {
    return this.request<GitHubRef>(
      "GET",
      `/repos/${repoFullName}/git/ref/${ref}`,
    );
  }

  async createRef(
    repoFullName: string,
    ref: string,
    sha: string,
  ): Promise<void> {
    await this.request("POST", `/repos/${repoFullName}/git/refs`, {
      ref: `refs/${ref}`,
      sha,
    });
  }

  async createTree(
    repoFullName: string,
    baseTreeSha: string,
    entries: GitHubTreeEntry[],
  ): Promise<GitHubCreateTreeResponse> {
    return this.request<GitHubCreateTreeResponse>(
      "POST",
      `/repos/${repoFullName}/git/trees`,
      { base_tree: baseTreeSha, tree: entries },
    );
  }

  async createCommit(
    repoFullName: string,
    message: string,
    treeSha: string,
    parentSha: string,
  ): Promise<GitHubCreateCommitResponse> {
    return this.request<GitHubCreateCommitResponse>(
      "POST",
      `/repos/${repoFullName}/git/commits`,
      { message, tree: treeSha, parents: [parentSha] },
    );
  }

  async updateRef(
    repoFullName: string,
    ref: string,
    sha: string,
  ): Promise<void> {
    await this.request("PATCH", `/repos/${repoFullName}/git/refs/${ref}`, {
      sha,
      force: true,
    });
  }

  // Verify connection
  async verifyConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request<GitHubRepo[]>(
        "GET",
        `/orgs/${this.config.orgName}/repos?per_page=1`,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/github/client.ts
git commit -m "feat(github-sync): add GitHub API client with retry and rate limiting"
```

---

## Task 5: Webhook validation

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/github/webhook.ts`

- [ ] **Step 1: Create github/webhook.ts**

Validates GitHub webhook signatures using Web Crypto API:

```typescript
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubSyncConfig } from "./types.js";

export async function validateWebhookSignature(
  ctx: PluginContext,
  config: GitHubSyncConfig,
  rawBody: string,
  signatureHeader: string | string[] | undefined,
): Promise<boolean> {
  if (!signatureHeader) return false;

  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!signature?.startsWith("sha256=")) return false;

  const secret = await ctx.secrets.resolve(config.webhookSecretRef);
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)),
  );

  const expected = `sha256=${Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/github/webhook.ts
git commit -m "feat(github-sync): add webhook signature validation"
```

---

## Task 6: Mapping and deduplication helpers

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/sync/mapping.ts`
- Create: `packages/plugins/plugin-github-sync/src/sync/dedup.ts`

- [ ] **Step 1: Create sync/mapping.ts**

State-based bidirectional mapping helpers:

```typescript
import type { PluginContext } from "@paperclipai/plugin-sdk";

// Issue mappings: GitHub <-> Paperclip
export async function getIssueMapping(
  ctx: PluginContext,
  githubRef: string,
): Promise<string | null> {
  return (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `issue:${githubRef}:paperclipId`,
  })) as string | null;
}

export async function setIssueMapping(
  ctx: PluginContext,
  githubRef: string,
  paperclipId: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `issue:${githubRef}:paperclipId` },
    paperclipId,
  );
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `issue:${paperclipId}:githubRef` },
    githubRef,
  );
}

export async function getGithubRefForIssue(
  ctx: PluginContext,
  paperclipId: string,
): Promise<string | null> {
  return (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `issue:${paperclipId}:githubRef`,
  })) as string | null;
}

// PR mappings
export async function setPRMapping(
  ctx: PluginContext,
  prRef: string,
  paperclipIssueId: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `pr:${prRef}:paperclipIssueId` },
    paperclipIssueId,
  );
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `issue:${paperclipIssueId}:prRef` },
    prRef,
  );
}

export async function getIssueForPR(
  ctx: PluginContext,
  prRef: string,
): Promise<string | null> {
  return (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `pr:${prRef}:paperclipIssueId`,
  })) as string | null;
}

// Repo to project mappings
export async function getProjectIdForRepo(
  ctx: PluginContext,
  repoFullName: string,
): Promise<string | null> {
  return (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `repo:${repoFullName}:projectId`,
  })) as string | null;
}

export async function setProjectIdForRepo(
  ctx: PluginContext,
  repoFullName: string,
  projectId: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `repo:${repoFullName}:projectId` },
    projectId,
  );
}

// Repo cursor
export async function getRepoCursor(
  ctx: PluginContext,
  repoFullName: string,
): Promise<{ lastPollAt: string } | null> {
  return (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `repo:${repoFullName}:cursor`,
  })) as { lastPollAt: string } | null;
}

export async function setRepoCursor(
  ctx: PluginContext,
  repoFullName: string,
  lastPollAt: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `repo:${repoFullName}:cursor` },
    { lastPollAt },
  );
}

// Issue updated_at tracking
export async function getIssueUpdatedAt(
  ctx: PluginContext,
  githubRef: string,
): Promise<string | null> {
  return (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `issue:${githubRef}:updatedAt`,
  })) as string | null;
}

export async function setIssueUpdatedAt(
  ctx: PluginContext,
  githubRef: string,
  updatedAt: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `issue:${githubRef}:updatedAt` },
    updatedAt,
  );
}
```

- [ ] **Step 2: Create sync/dedup.ts**

Deduplication and anti-loop logic:

```typescript
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  DELIVERY_RING_BUFFER_SIZE,
  STATE_KEYS,
  SYNC_NONCE_PREFIX,
  SYNC_NONCE_SUFFIX,
  SYNC_NONCE_TTL_MS,
} from "../constants.js";

// Webhook delivery deduplication (ring buffer)
export async function isDeliveryProcessed(
  ctx: PluginContext,
  deliveryId: string,
): Promise<boolean> {
  const deliveries = ((await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.processedDeliveries,
  })) ?? []) as string[];
  return deliveries.includes(deliveryId);
}

export async function markDeliveryProcessed(
  ctx: PluginContext,
  deliveryId: string,
): Promise<void> {
  const deliveries = ((await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.processedDeliveries,
  })) ?? []) as string[];

  deliveries.push(deliveryId);
  if (deliveries.length > DELIVERY_RING_BUFFER_SIZE) {
    deliveries.splice(0, deliveries.length - DELIVERY_RING_BUFFER_SIZE);
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.processedDeliveries },
    deliveries,
  );
}

// Anti-loop nonces
function generateNonce(): string {
  return crypto.randomUUID();
}

export function embedNonce(body: string, nonce: string): string {
  return `${body}\n${SYNC_NONCE_PREFIX}${nonce}${SYNC_NONCE_SUFFIX}`;
}

export function extractNonce(body: string): string | null {
  const start = body.indexOf(SYNC_NONCE_PREFIX);
  if (start === -1) return null;
  const nonceStart = start + SYNC_NONCE_PREFIX.length;
  const end = body.indexOf(SYNC_NONCE_SUFFIX, nonceStart);
  if (end === -1) return null;
  return body.substring(nonceStart, end);
}

export async function createSyncNonce(
  ctx: PluginContext,
  githubRef: string,
): Promise<string> {
  const nonce = generateNonce();
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `sync:${githubRef}:nonce` },
    { nonce, createdAt: Date.now() },
  );
  return nonce;
}

export async function isOwnSyncEvent(
  ctx: PluginContext,
  githubRef: string,
  body: string,
): Promise<boolean> {
  const nonce = extractNonce(body);
  if (!nonce) return false;

  const stored = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `sync:${githubRef}:nonce`,
  })) as { nonce: string; createdAt: number } | null;

  if (!stored) return false;
  return stored.nonce === nonce;
}

export async function cleanExpiredNonces(
  ctx: PluginContext,
  githubRef: string,
): Promise<void> {
  const stored = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `sync:${githubRef}:nonce`,
  })) as { nonce: string; createdAt: number } | null;

  if (stored && Date.now() - stored.createdAt > SYNC_NONCE_TTL_MS) {
    await ctx.state.delete({
      scopeKind: "instance",
      stateKey: `sync:${githubRef}:nonce`,
    });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/sync/
git commit -m "feat(github-sync): add mapping and deduplication helpers"
```

---

## Task 7: Inbound sync (GitHub → Paperclip)

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/sync/inbound.ts`

- [ ] **Step 1: Create sync/inbound.ts**

Processes GitHub issue events and creates/updates Paperclip issues:

```typescript
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubIssue, GitHubSyncConfig } from "../github/types.js";
import { AGENTS_CACHE_TTL_MS, STATE_KEYS } from "../constants.js";
import {
  getIssueMapping,
  getIssueUpdatedAt,
  getProjectIdForRepo,
  setIssueMapping,
  setIssueUpdatedAt,
} from "./mapping.js";
import type { GitHubClient } from "../github/client.js";

interface CachedAgents {
  agents: Array<{ id: string; urlKey: string; name: string }>;
  cachedAt: number;
}

async function resolveAgent(
  ctx: PluginContext,
  config: GitHubSyncConfig,
  urlKey: string,
): Promise<{ id: string; name: string } | null> {
  // Check cache first
  const cached = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.agentsCache,
  })) as CachedAgents | null;

  let agents: CachedAgents["agents"];

  if (cached && Date.now() - cached.cachedAt < AGENTS_CACHE_TTL_MS) {
    agents = cached.agents;
  } else {
    const agentList = await ctx.agents.list({ companyId: config.companyId });
    agents = agentList.map((a) => ({
      id: a.id,
      urlKey: a.urlKey,
      name: a.name,
    }));
    await ctx.state.set(
      { scopeKind: "instance", stateKey: STATE_KEYS.agentsCache },
      { agents, cachedAt: Date.now() },
    );
  }

  const match = agents.find((a) => a.urlKey === urlKey);
  return match ? { id: match.id, name: match.name } : null;
}

function extractAgentLabel(
  labels: Array<{ name: string }>,
  prefix: string,
): string | null {
  const label = labels.find((l) => l.name.startsWith(prefix));
  if (!label) return null;
  return label.name.slice(prefix.length);
}

export async function processGitHubIssue(
  ctx: PluginContext,
  config: GitHubSyncConfig,
  ghClient: GitHubClient,
  repoFullName: string,
  issue: GitHubIssue,
): Promise<void> {
  const githubRef = `${repoFullName}#${issue.number}`;

  // Check dedup by updated_at
  const lastUpdatedAt = await getIssueUpdatedAt(ctx, githubRef);
  if (lastUpdatedAt && lastUpdatedAt === issue.updated_at) {
    return; // Already processed this version
  }

  // Resolve project
  const projectId = await getProjectIdForRepo(ctx, repoFullName);
  if (!projectId) {
    ctx.logger.warn("No project mapping for repo, skipping", { repoFullName });
    return;
  }

  // Resolve agent from label
  const agentUrlKey = extractAgentLabel(issue.labels, config.syncLabelsPrefix);
  let assigneeAgentId: string | null | undefined = undefined; // undefined = no change

  if (agentUrlKey) {
    const agent = await resolveAgent(ctx, config, agentUrlKey);
    if (agent) {
      assigneeAgentId = agent.id;
    } else {
      ctx.logger.warn("Agent not found for label", { agentUrlKey, githubRef });
      await ghClient.addComment(
        repoFullName,
        issue.number,
        `Agent \`${agentUrlKey}\` not found in Paperclip. Issue imported without assignment.`,
      );
    }
  } else {
    // No agent label present — if issue had one before, unassign
    // We only unassign if the issue already exists (update scenario)
    assigneeAgentId = null;
  }

  // Check if we already have this issue
  const existingId = await getIssueMapping(ctx, githubRef);

  if (existingId) {
    // Update existing issue
    const patch: Record<string, unknown> = {
      title: issue.title,
      description: issue.body ?? undefined,
    };

    if (issue.state === "closed") {
      patch.status = "cancelled";
    }

    // Only include assigneeAgentId if we have an explicit value (agent found or label removed)
    if (assigneeAgentId !== undefined) {
      patch.assigneeAgentId = assigneeAgentId;
    }

    await ctx.issues.update(
      existingId,
      patch as Parameters<typeof ctx.issues.update>[1],
      config.companyId,
    );

    await ctx.activity.log({
      companyId: config.companyId,
      message: `GitHub issue ${githubRef} synced (updated)`,
      entityType: "issue",
      entityId: existingId,
    });
  } else {
    // Create new issue
    if (issue.state === "closed") {
      // Don't import already-closed issues
      return;
    }

    const created = await ctx.issues.create({
      companyId: config.companyId,
      projectId,
      title: issue.title,
      description: issue.body ?? undefined,
      assigneeAgentId: assigneeAgentId ?? undefined,
    });

    await setIssueMapping(ctx, githubRef, created.id);

    // Set status to todo if not already (may need update after create)
    if (created.status !== "todo") {
      try {
        await ctx.issues.update(created.id, { status: "todo" }, config.companyId);
      } catch {
        ctx.logger.warn("Could not set initial status to todo", { issueId: created.id });
      }
    }

    await ctx.activity.log({
      companyId: config.companyId,
      message: `GitHub issue ${githubRef} imported`,
      entityType: "issue",
      entityId: created.id,
    });
  }

  // Track updated_at for dedup
  await setIssueUpdatedAt(ctx, githubRef, issue.updated_at);

  await ctx.metrics.write("github_sync.events_processed", 1, {
    type: "issue",
    direction: "inbound",
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/sync/inbound.ts
git commit -m "feat(github-sync): add inbound sync (GitHub -> Paperclip)"
```

---

## Task 8: Outbound sync (Paperclip → GitHub)

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/sync/outbound.ts`

- [ ] **Step 1: Create sync/outbound.ts**

Handles Paperclip issue events and syncs status/comments/PRs back to GitHub:

```typescript
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { GitHubSyncConfig } from "../github/types.js";
import type { GitHubClient } from "../github/client.js";
import { getGithubRefForIssue, setPRMapping } from "./mapping.js";
import { createSyncNonce, embedNonce } from "./dedup.js";

function parseGithubRef(ref: string): { repoFullName: string; number: number } {
  const [repo, num] = ref.split("#");
  return { repoFullName: repo, number: parseInt(num, 10) };
}

const STATUS_LABELS: Record<string, string> = {
  in_progress: "status:in-progress",
  in_review: "status:in-review",
  done: "status:done",
  cancelled: "status:cancelled",
};

async function removeAllStatusLabels(
  ghClient: GitHubClient,
  repoFullName: string,
  issueNumber: number,
): Promise<void> {
  for (const label of Object.values(STATUS_LABELS)) {
    await ghClient.removeLabel(repoFullName, issueNumber, label);
  }
}

export async function handleIssueUpdated(
  ctx: PluginContext,
  config: GitHubSyncConfig,
  ghClient: GitHubClient,
  event: PluginEvent,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  // Check if this issue is linked to GitHub
  const githubRef = await getGithubRefForIssue(ctx, issueId);
  if (!githubRef) return; // Not a synced issue

  const { repoFullName, number: issueNumber } = parseGithubRef(githubRef);
  const issue = await ctx.issues.get(issueId, config.companyId);
  if (!issue) return;

  const status = issue.status;

  // Create anti-loop nonce
  const nonce = await createSyncNonce(ctx, githubRef);

  // Update status label on GitHub
  if (STATUS_LABELS[status]) {
    await removeAllStatusLabels(ghClient, repoFullName, issueNumber);
    await ghClient.addLabel(repoFullName, issueNumber, STATUS_LABELS[status]);
  }

  // Post status-specific comments
  if (status === "in_progress") {
    const agent = issue.assigneeAgentId
      ? await ctx.agents.get(issue.assigneeAgentId, config.companyId)
      : null;
    const agentName = agent?.name ?? "an agent";
    const comment = embedNonce(
      `Taken by agent **${agentName}**`,
      nonce,
    );
    await ghClient.addComment(repoFullName, issueNumber, comment);
  }

  if (status === "in_review") {
    // Trigger PR creation
    await createPRForIssue(ctx, config, ghClient, issueId, githubRef);

    const comment = embedNonce(
      `Agent work completed. Awaiting review.`,
      nonce,
    );
    await ghClient.addComment(repoFullName, issueNumber, comment);
  }

  if (status === "done") {
    const comment = embedNonce(
      `Issue resolved.`,
      nonce,
    );
    await ghClient.addComment(repoFullName, issueNumber, comment);
  }

  await ctx.metrics.write("github_sync.events_processed", 1, {
    type: "issue",
    direction: "outbound",
  });
}

export async function createPRForIssue(
  ctx: PluginContext,
  config: GitHubSyncConfig,
  ghClient: GitHubClient,
  issueId: string,
  githubRef: string,
): Promise<void> {
  const { repoFullName, number: issueNumber } = parseGithubRef(githubRef);
  const issue = await ctx.issues.get(issueId, config.companyId);
  if (!issue) return;

  const agent = issue.assigneeAgentId
    ? await ctx.agents.get(issue.assigneeAgentId, config.companyId)
    : null;

  if (!agent) {
    ctx.logger.warn("No agent assigned, skipping PR creation", { issueId });
    return;
  }

  const agentUrlKey = agent.urlKey ?? "agent";

  // Get default branch ref
  let baseSha: string;
  try {
    const ref = await ghClient.getRef(repoFullName, "heads/main");
    baseSha = ref.object.sha;
  } catch {
    try {
      const ref = await ghClient.getRef(repoFullName, "heads/master");
      baseSha = ref.object.sha;
    } catch (e) {
      ctx.logger.error("Could not find main or master branch", { repoFullName, error: String(e) });
      return;
    }
  }

  // Create branch
  let branchName = `agent/${agentUrlKey}/issue-${issueNumber}`;
  try {
    await ghClient.createRef(repoFullName, `heads/${branchName}`, baseSha);
  } catch {
    // Branch may already exist, use timestamp suffix
    branchName = `${branchName}-${Date.now()}`;
    await ghClient.createRef(repoFullName, `heads/${branchName}`, baseSha);
  }

  // Note: actual code push (tree/commit/update-ref) would happen here
  // when workspace file access is implemented. For now, create an empty branch + PR.

  // Create PR
  const defaultBranch = "main"; // TODO: detect from repo
  const pr = await ghClient.createPR(
    repoFullName,
    branchName,
    defaultBranch,
    `[Agent: ${agent.name}] ${issue.title}`,
    `${issue.description ?? ""}\n\n---\n*Created by Paperclip GitHub Sync*`,
  );

  // Store PR mapping
  const prRef = `${repoFullName}#${pr.number}`;
  await setPRMapping(ctx, prRef, issueId);

  // Comment on the original issue with PR link
  const nonce = await createSyncNonce(ctx, githubRef);
  await ghClient.addComment(
    repoFullName,
    issueNumber,
    embedNonce(`PR opened: ${pr.html_url}`, nonce),
  );

  await ctx.activity.log({
    companyId: config.companyId,
    message: `PR #${pr.number} created for issue ${githubRef}`,
    entityType: "issue",
    entityId: issueId,
    metadata: { prUrl: pr.html_url, prNumber: pr.number },
  });

  await ctx.metrics.write("github_sync.events_processed", 1, {
    type: "pr",
    direction: "outbound",
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/sync/outbound.ts
git commit -m "feat(github-sync): add outbound sync (Paperclip -> GitHub)"
```

---

## Task 9: Polling job

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/sync/poll.ts`

- [ ] **Step 1: Create sync/poll.ts**

Handles repo discovery and issue polling:

```typescript
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubSyncConfig } from "../github/types.js";
import type { GitHubClient } from "../github/client.js";
import { STATE_KEYS } from "../constants.js";
import { getRepoCursor, setRepoCursor } from "./mapping.js";
import { processGitHubIssue } from "./inbound.js";
import { getIssueForPR } from "./mapping.js";
import { cleanExpiredNonces } from "./dedup.js";

export async function discoverRepos(
  ctx: PluginContext,
  config: GitHubSyncConfig,
  ghClient: GitHubClient,
): Promise<void> {
  const ghRepos = await ghClient.listOrgRepos();
  const activeRepos = ghRepos.filter((r) => !r.archived);

  // Get all existing projects (paginated)
  const projects = [];
  let offset = 0;
  while (true) {
    const batch = await ctx.projects.list({ companyId: config.companyId, limit: 100, offset });
    projects.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }
  const projectsByName = new Map(projects.map((p) => [p.name, p.id]));

  const trackedRepos: string[] = [];
  const unlinkedRepos: string[] = [];

  for (const repo of activeRepos) {
    const projectId = projectsByName.get(repo.name);
    if (projectId) {
      trackedRepos.push(repo.full_name);
      // Store mapping
      await ctx.state.set(
        { scopeKind: "instance", stateKey: `repo:${repo.full_name}:projectId` },
        projectId,
      );
    } else {
      unlinkedRepos.push(repo.full_name);
    }
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.repos },
    trackedRepos,
  );
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.unlinkedRepos },
    unlinkedRepos,
  );

  ctx.logger.info("Repo discovery complete", {
    tracked: trackedRepos.length,
    unlinked: unlinkedRepos.length,
  });
}

export async function pollAllRepos(
  ctx: PluginContext,
  config: GitHubSyncConfig,
  ghClient: GitHubClient,
): Promise<void> {
  const startTime = Date.now();

  // Check rate limit
  if (!(await ghClient.isRateLimitSafe())) {
    ctx.logger.warn("Skipping poll cycle due to rate limit");
    return;
  }

  const repos = ((await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.repos,
  })) ?? []) as string[];

  if (repos.length === 0) {
    ctx.logger.info("No tracked repos, running discovery first");
    await discoverRepos(ctx, config, ghClient);
    return;
  }

  let totalIssuesProcessed = 0;
  let totalPRsProcessed = 0;

  for (const repoFullName of repos) {
    try {
      const cursor = await getRepoCursor(ctx, repoFullName);
      const since = cursor?.lastPollAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Clean expired nonces for this repo's issues
      // (lightweight: only cleans if nonce exists and is expired)
      const repoIssueKeys = await ghClient.listIssuesSince(repoFullName, since);

      // Poll issues
      const issues = repoIssueKeys;
      for (const issue of issues) {
        const ref = `${repoFullName}#${issue.number}`;
        await cleanExpiredNonces(ctx, ref);
        try {
          await processGitHubIssue(ctx, config, ghClient, repoFullName, issue);
          totalIssuesProcessed++;
        } catch (err) {
          ctx.logger.error("Error processing issue", {
            repo: repoFullName,
            issue: issue.number,
            error: String(err),
          });
          await ctx.metrics.write("github_sync.errors", 1, { type: "inbound_issue" });
        }
      }

      // Poll merged PRs
      const closedPRs = await ghClient.listClosedPRsSince(repoFullName, since);
      for (const pr of closedPRs) {
        if (pr.merged) {
          const prRef = `${repoFullName}#${pr.number}`;
          const issueId = await getIssueForPR(ctx, prRef);
          if (issueId) {
            try {
              const issue = await ctx.issues.get(issueId, config.companyId);
              if (issue && issue.status === "in_review") {
                await ctx.issues.update(issueId, { status: "done" }, config.companyId);
                await ctx.activity.log({
                  companyId: config.companyId,
                  message: `PR ${prRef} merged, issue marked done`,
                  entityType: "issue",
                  entityId: issueId,
                });
                totalPRsProcessed++;
              }
            } catch (err) {
              ctx.logger.error("Error processing merged PR", {
                prRef,
                error: String(err),
              });
            }
          }
        }
      }

      // Update cursor
      await setRepoCursor(ctx, repoFullName, new Date().toISOString());
    } catch (err) {
      ctx.logger.error("Error polling repo", {
        repo: repoFullName,
        error: String(err),
      });
      await ctx.metrics.write("github_sync.errors", 1, { type: "poll_repo" });
    }
  }

  const durationMs = Date.now() - startTime;
  await ctx.metrics.write("github_sync.poll_duration_ms", durationMs);

  ctx.logger.info("Poll cycle complete", {
    repos: repos.length,
    issuesProcessed: totalIssuesProcessed,
    prsProcessed: totalPRsProcessed,
    durationMs,
  });
}

export async function initialSync(
  ctx: PluginContext,
  config: GitHubSyncConfig,
  ghClient: GitHubClient,
): Promise<void> {
  ctx.logger.info("Starting initial sync");

  await discoverRepos(ctx, config, ghClient);

  const repos = ((await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.repos,
  })) ?? []) as string[];

  let totalImported = 0;

  for (const repoFullName of repos) {
    try {
      const issues = await ghClient.listOpenIssues(repoFullName);
      for (const issue of issues) {
        try {
          await processGitHubIssue(ctx, config, ghClient, repoFullName, issue);
          totalImported++;
        } catch (err) {
          ctx.logger.error("Error importing issue during initial sync", {
            repo: repoFullName,
            issue: issue.number,
            error: String(err),
          });
        }
      }
      await setRepoCursor(ctx, repoFullName, new Date().toISOString());
    } catch (err) {
      ctx.logger.error("Error during initial sync for repo", {
        repo: repoFullName,
        error: String(err),
      });
    }
  }

  const unlinkedRepos = ((await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.unlinkedRepos,
  })) ?? []) as string[];

  await ctx.activity.log({
    companyId: config.companyId,
    message: `Initial sync: ${repos.length} repos linked, ${totalImported} issues imported, ${unlinkedRepos.length} repos unlinked`,
  });

  ctx.logger.info("Initial sync complete", {
    reposLinked: repos.length,
    issuesImported: totalImported,
    reposUnlinked: unlinkedRepos.length,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/sync/poll.ts
git commit -m "feat(github-sync): add polling job and initial sync"
```

---

## Task 10: Main worker (plugin setup and lifecycle)

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/worker.ts`

- [ ] **Step 1: Create worker.ts**

Ties everything together — registers event handlers, jobs, webhooks, data endpoints, and actions:

```typescript
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { GitHubClient } from "./github/client.js";
import { clearTokenCache } from "./github/auth.js";
import { validateWebhookSignature } from "./github/webhook.js";
import type { GitHubSyncConfig, GitHubWebhookPayload } from "./github/types.js";
import { processGitHubIssue } from "./sync/inbound.js";
import { handleIssueUpdated } from "./sync/outbound.js";
import { discoverRepos, initialSync, pollAllRepos } from "./sync/poll.js";
import { isDeliveryProcessed, isOwnSyncEvent, markDeliveryProcessed } from "./sync/dedup.js";
import { getIssueForPR, getProjectIdForRepo } from "./sync/mapping.js";
import { getGithubRefForIssue } from "./sync/mapping.js";
import {
  ACTION_KEYS,
  DATA_KEYS,
  JOB_KEYS,
  STATE_KEYS,
  WEBHOOK_KEYS,
} from "./constants.js";

function getConfig(raw: Record<string, unknown>): GitHubSyncConfig {
  return {
    githubAppId: raw.githubAppId as string,
    githubInstallationId: raw.githubInstallationId as string,
    privateKeySecret: raw.privateKeySecret as string,
    orgName: raw.orgName as string,
    companyId: raw.companyId as string,
    pollIntervalMinutes: (raw.pollIntervalMinutes as number) ?? 5,
    syncLabelsPrefix: (raw.syncLabelsPrefix as string) ?? "agent:",
    webhookSecretRef: raw.webhookSecretRef as string,
  };
}

let currentCtx: PluginContext | null = null;
let ghClient: GitHubClient | null = null;
let pluginConfig: GitHubSyncConfig | null = null;
let initialized = false;

async function ensureInitialized(ctx: PluginContext): Promise<{
  config: GitHubSyncConfig;
  client: GitHubClient;
}> {
  if (!pluginConfig || !ghClient) {
    const rawConfig = await ctx.config.get();
    pluginConfig = getConfig(rawConfig);
    ghClient = new GitHubClient(ctx, pluginConfig);
  }

  if (!initialized) {
    // Check if we have repos tracked — if not, do initial sync
    const repos = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: STATE_KEYS.repos,
    })) as string[] | null;

    if (!repos || repos.length === 0) {
      await initialSync(ctx, pluginConfig, ghClient);
    }
    initialized = true;
  }

  return { config: pluginConfig, client: ghClient };
}

const plugin = definePlugin({
  async setup(ctx) {
    currentCtx = ctx;
    ctx.logger.info("GitHub Sync plugin starting");

    // --- Job: Periodic polling ---
    ctx.jobs.register(JOB_KEYS.poll, async () => {
      const { config, client } = await ensureInitialized(ctx);
      await pollAllRepos(ctx, config, client);

      // Periodic repo discovery (every 12th run ≈ hourly at 5min intervals)
      const pollCount = ((await ctx.state.get({
        scopeKind: "instance",
        stateKey: "poll-count",
      })) ?? 0) as number;

      if (pollCount % 12 === 0) {
        await discoverRepos(ctx, config, client);
      }

      await ctx.state.set(
        { scopeKind: "instance", stateKey: "poll-count" },
        pollCount + 1,
      );
    });

    // --- Events: Outbound sync ---
    ctx.events.on("issue.updated", async (event) => {
      try {
        const { config, client } = await ensureInitialized(ctx);
        if (event.companyId !== config.companyId) return;
        await handleIssueUpdated(ctx, config, client, event);
      } catch (err) {
        ctx.logger.error("Error in outbound sync (updated)", { error: String(err) });
        await ctx.metrics.write("github_sync.errors", 1, { type: "outbound" });
      }
    });

    ctx.events.on("issue.created", async (event) => {
      try {
        const { config, client } = await ensureInitialized(ctx);
        if (event.companyId !== config.companyId) return;
        // For now, issue.created outbound is a no-op — issues originate from GitHub.
        // This handler is a hook for future bidirectional creation support.
        ctx.logger.debug("Issue created event received", { entityId: event.entityId });
      } catch (err) {
        ctx.logger.error("Error in outbound sync (created)", { error: String(err) });
      }
    });

    // --- Data: UI endpoints ---
    ctx.data.register(DATA_KEYS.syncStatus, async (params) => {
      const { config } = await ensureInitialized(ctx);

      const repos = ((await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.repos,
      })) ?? []) as string[];

      const unlinkedRepos = ((await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.unlinkedRepos,
      })) ?? []) as string[];

      const rateLimit = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.rateLimit,
      })) as { remaining: number; resetAt: number } | null;

      return {
        connected: true,
        orgName: config.orgName,
        trackedRepos: repos.length,
        unlinkedRepos,
        rateLimit,
      };
    });

    ctx.data.register(DATA_KEYS.issueGithubInfo, async (params) => {
      const issueId = params.issueId as string;
      if (!issueId) return null;

      const githubRef = await getGithubRefForIssue(ctx, issueId);
      if (!githubRef) return null;

      const [repoFullName, number] = githubRef.split("#");
      const prRef = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: `issue:${issueId}:prRef`,
      })) as string | null;

      const updatedAt = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: `issue:${githubRef}:updatedAt`,
      })) as string | null;

      return {
        githubRef,
        repoFullName,
        issueNumber: parseInt(number, 10),
        issueUrl: `https://github.com/${repoFullName}/issues/${number}`,
        prRef,
        prUrl: prRef ? `https://github.com/${prRef.split("#")[0]}/pull/${prRef.split("#")[1]}` : null,
        lastSyncedAt: updatedAt,
      };
    });

    // --- Actions: UI actions ---
    ctx.actions.register(ACTION_KEYS.forceSyncNow, async () => {
      const { config, client } = await ensureInitialized(ctx);
      await pollAllRepos(ctx, config, client);
      return { success: true };
    });

    ctx.actions.register(ACTION_KEYS.testConnection, async () => {
      const { client } = await ensureInitialized(ctx);
      return client.verifyConnection();
    });

    ctx.logger.info("GitHub Sync plugin ready");
  },

  async onWebhook(input: PluginWebhookInput) {
    if (!currentCtx) throw new Error("Plugin not initialized");
    const ctx = currentCtx;
    const { config, client } = await ensureInitialized(ctx);

    if (input.endpointKey !== WEBHOOK_KEYS.githubEvents) {
      ctx.logger.warn("Unknown webhook endpoint", { endpointKey: input.endpointKey });
      return;
    }

    // Validate signature
    const valid = await validateWebhookSignature(
      ctx,
      config,
      input.rawBody,
      input.headers["x-hub-signature-256"],
    );
    if (!valid) {
      ctx.logger.warn("Invalid webhook signature");
      await ctx.metrics.write("github_sync.errors", 1, { type: "webhook_auth" });
      return;
    }

    // Deduplicate by delivery ID
    const deliveryId = Array.isArray(input.headers["x-github-delivery"])
      ? input.headers["x-github-delivery"][0]
      : input.headers["x-github-delivery"];
    if (deliveryId && (await isDeliveryProcessed(ctx, deliveryId))) {
      ctx.logger.debug("Duplicate delivery, skipping", { deliveryId });
      return;
    }

    const payload = input.parsedBody as GitHubWebhookPayload;

    // Check for own sync events (anti-loop)
    if (payload.issue?.body) {
      const githubRef = `${payload.repository.full_name}#${payload.issue.number}`;
      if (await isOwnSyncEvent(ctx, githubRef, payload.issue.body)) {
        ctx.logger.debug("Own sync event, skipping", { githubRef });
        if (deliveryId) await markDeliveryProcessed(ctx, deliveryId);
        return;
      }
    }

    // Process based on event type
    const eventType = Array.isArray(input.headers["x-github-event"])
      ? input.headers["x-github-event"][0]
      : input.headers["x-github-event"];

    if (eventType === "issues" && payload.issue) {
      await processGitHubIssue(
        ctx,
        config,
        client,
        payload.repository.full_name,
        payload.issue,
      );
    }

    if (eventType === "pull_request" && payload.pull_request) {
      if (payload.action === "closed" && payload.pull_request.merged) {
        const prRef = `${payload.repository.full_name}#${payload.pull_request.number}`;
        const issueId = await getIssueForPR(ctx, prRef);
        if (issueId) {
          const issue = await ctx.issues.get(issueId, config.companyId);
          if (issue && issue.status === "in_review") {
            await ctx.issues.update(issueId, { status: "done" }, config.companyId);
            await ctx.activity.log({
              companyId: config.companyId,
              message: `PR ${prRef} merged via webhook, issue marked done`,
              entityType: "issue",
              entityId: issueId,
            });
          }
        }
      }
    }

    if (deliveryId) await markDeliveryProcessed(ctx, deliveryId);
    await ctx.metrics.write("github_sync.api_calls", 1, { source: "webhook" });
  },

  async onHealth() {
    if (!pluginConfig || !ghClient) {
      return { status: "degraded" as const, message: "Not yet initialized" };
    }

    const result = await ghClient.verifyConnection();
    if (!result.ok) {
      return { status: "error" as const, message: `GitHub connection failed: ${result.error}` };
    }

    return { status: "ok" as const, message: "Connected to GitHub" };
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    pluginConfig = getConfig(newConfig);
    ghClient = null; // Force recreation with new config
    clearTokenCache();
    initialized = false;
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const errors: string[] = [];

    for (const field of ["githubAppId", "githubInstallationId", "privateKeySecret", "orgName", "companyId", "webhookSecretRef"]) {
      if (!config[field] || typeof config[field] !== "string") {
        errors.push(`${field} is required`);
      }
    }

    const poll = config.pollIntervalMinutes;
    if (poll !== undefined && (typeof poll !== "number" || poll < 1 || poll > 30)) {
      errors.push("pollIntervalMinutes must be between 1 and 30");
    }

    return {
      ok: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/worker.ts
git commit -m "feat(github-sync): add main worker with event handlers, jobs, and webhooks"
```

---

## Task 11: UI components

**Files:**
- Create: `packages/plugins/plugin-github-sync/src/ui/index.tsx`
- Create: `packages/plugins/plugin-github-sync/src/ui/DashboardWidget.tsx`
- Create: `packages/plugins/plugin-github-sync/src/ui/SettingsPage.tsx`
- Create: `packages/plugins/plugin-github-sync/src/ui/IssueDetailTab.tsx`

- [ ] **Step 1: Create DashboardWidget.tsx**

```tsx
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

interface SyncStatus {
  connected: boolean;
  orgName: string;
  trackedRepos: number;
  unlinkedRepos: string[];
  rateLimit: { remaining: number; resetAt: number } | null;
}

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<SyncStatus>("sync-status", {
    companyId: context.companyId,
  });

  if (loading) return <div style={{ padding: 16 }}>Loading...</div>;
  if (error) return <div style={{ padding: 16, color: "red" }}>Error: {error.message}</div>;
  if (!data) return <div style={{ padding: 16 }}>Not configured</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor: data.connected ? "#22c55e" : "#ef4444",
            display: "inline-block",
          }}
        />
        <strong>GitHub: {data.orgName}</strong>
      </div>

      <div style={{ fontSize: 14, marginBottom: 8 }}>
        {data.trackedRepos} repos tracked
      </div>

      {data.unlinkedRepos.length > 0 && (
        <div style={{ fontSize: 12, color: "#f59e0b", marginBottom: 8 }}>
          {data.unlinkedRepos.length} repos unlinked (create matching Paperclip projects)
        </div>
      )}

      {data.rateLimit && (
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          API: {data.rateLimit.remaining} calls remaining
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create SettingsPage.tsx**

```tsx
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { useState } from "react";

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const testConnection = usePluginAction("test-connection");
  const forceSyncNow = usePluginAction("force-sync-now");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const handleTestConnection = async () => {
    setTestResult("Testing...");
    try {
      const result = (await testConnection({})) as { ok: boolean; error?: string };
      setTestResult(result.ok ? "Connected!" : `Failed: ${result.error}`);
    } catch (err) {
      setTestResult(`Error: ${String(err)}`);
    }
  };

  const handleForceSync = async () => {
    setSyncing(true);
    try {
      await forceSyncNow({});
      setSyncing(false);
    } catch {
      setSyncing(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 600 }}>
      <h2 style={{ marginBottom: 16 }}>GitHub Sync Settings</h2>

      <p style={{ marginBottom: 16, color: "#6b7280", fontSize: 14 }}>
        Configuration is managed via the plugin instance config. Use the buttons
        below to test and trigger sync.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <button
          onClick={handleTestConnection}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            cursor: "pointer",
            backgroundColor: "#f9fafb",
          }}
        >
          Test Connection
        </button>

        <button
          onClick={handleForceSync}
          disabled={syncing}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            cursor: syncing ? "not-allowed" : "pointer",
            backgroundColor: syncing ? "#e5e7eb" : "#f9fafb",
          }}
        >
          {syncing ? "Syncing..." : "Force Sync Now"}
        </button>
      </div>

      {testResult && (
        <div
          style={{
            padding: 12,
            borderRadius: 6,
            backgroundColor: testResult.startsWith("Connected") ? "#dcfce7" : "#fef2f2",
            fontSize: 14,
          }}
        >
          {testResult}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create IssueDetailTab.tsx**

```tsx
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";

interface GithubInfo {
  githubRef: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  prRef: string | null;
  prUrl: string | null;
  lastSyncedAt: string | null;
}

export function IssueDetailTab({ context }: PluginDetailTabProps) {
  const { data, loading, error } = usePluginData<GithubInfo | null>(
    "issue-github-info",
    { issueId: context.entityId },
  );

  if (loading) return <div style={{ padding: 16 }}>Loading...</div>;
  if (error) return <div style={{ padding: 16, color: "red" }}>Error: {error.message}</div>;
  if (!data) return <div style={{ padding: 16, color: "#9ca3af" }}>Not linked to GitHub</div>;

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ marginBottom: 12 }}>GitHub Issue</h3>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Reference</div>
        <a
          href={data.issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2563eb", textDecoration: "none" }}
        >
          {data.githubRef}
        </a>
      </div>

      {data.prRef && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Pull Request</div>
          <a
            href={data.prUrl!}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#2563eb", textDecoration: "none" }}
          >
            {data.prRef}
          </a>
        </div>
      )}

      {data.lastSyncedAt && (
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          Last synced: {new Date(data.lastSyncedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create ui/index.tsx**

```tsx
export { DashboardWidget } from "./DashboardWidget.js";
export { SettingsPage } from "./SettingsPage.js";
export { IssueDetailTab } from "./IssueDetailTab.js";
```

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/plugin-github-sync/src/ui/
git commit -m "feat(github-sync): add UI components (dashboard, settings, issue tab)"
```

---

## Task 12: Build and verify

- [ ] **Step 1: Build the plugin**

Run: `cd packages/plugins/plugin-github-sync && pnpm build`

Expected: TypeScript compiles successfully, UI bundle created in `dist/`

- [ ] **Step 2: Fix any type errors**

If compilation fails, fix type errors and re-run.

- [ ] **Step 3: Verify dist output**

Run: `ls -la packages/plugins/plugin-github-sync/dist/`

Expected: `manifest.js`, `worker.js`, `ui/index.js` all present

- [ ] **Step 4: Run typecheck**

Run: `cd packages/plugins/plugin-github-sync && pnpm typecheck`

Expected: No errors

- [ ] **Step 5: Commit build artifacts config** (if needed)

```bash
git add -A packages/plugins/plugin-github-sync/
git commit -m "feat(github-sync): finalize plugin build configuration"
```

---

## Task 13: Final integration commit

- [ ] **Step 1: Final commit with all files**

```bash
git add packages/plugins/plugin-github-sync/
git commit -m "feat(github-sync): complete GitHub Sync plugin v0.1.0

Bidirectional GitHub issue sync with:
- Agent assignment via labels (agent:<urlKey>)
- PR creation by agents
- Hybrid webhook + polling for reliability
- Dashboard widget, settings page, and issue detail tab
- Anti-loop nonce mechanism
- Rate limiting and retry logic"
```

- [ ] **Step 3: Verify clean git status**

Run: `git status`

Expected: Clean working tree
