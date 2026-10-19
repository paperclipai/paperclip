import { AsyncLocalStorage } from "node:async_hooks";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { GIT_MIRROR_JOB_KEY, readGitMirrorConfig } from "../src/wiki/git-mirror-config.js";
import {
  gitBlobSha,
  githubAppJwt,
  gitMirrorTuning,
  isMirrorablePath,
  requestForcedGitMirrorRewrite,
  syncGitMirror,
  type GitMirrorStatus,
} from "../src/wiki/git-mirror.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222", version: "latest" };
const INSTALLATION_TOKEN = "ghs_installation_token_for_tests_only";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

type RepoFiles = Record<string, string | Buffer>;
type FetchCall = { method: string; path: string; authorization: string | null; body: unknown };

class FakeGitHub {
  calls: FetchCall[] = [];
  commit = "c1".padEnd(40, "0");
  files: RepoFiles;
  permissions: Record<string, string> = { contents: "read", metadata: "read" };
  tokenRepositories = ["acme/handbook"];
  token = INSTALLATION_TOKEN;
  truncated = false;
  corrupt = new Set<string>();
  failBranchWith: number | null = null;
  branchName = "main";
  /** Mint replies 401 echoing this prefix plus the JWT it received. */
  echoJwtOnMint: string | null = null;
  /** Paths whose tree entry reports a smaller size than the blob really has. */
  understatedSizes = new Set<string>();
  malformedTreeSha = false;
  branchMessage = "Bad credentials";
  /** While set, blob responses wait for it: lets a test hold a run mid-sync. */
  gate: Promise<void> | null = null;
  inFlightBlobs = 0;
  maxInFlightBlobs = 0;

  constructor(files: RepoFiles) {
    this.files = files;
  }

  treeSha(): string {
    return this.malformedTreeSha ? "../../evil" : `f${this.commit.slice(1)}`;
  }

  bytes(path: string): Buffer {
    const value = this.files[path]!;
    return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({
      method,
      path: parsed.pathname + parsed.search,
      authorization: headers.authorization ?? null,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const repoBase = "/repos/acme/handbook";
    if (method === "POST" && parsed.pathname === "/app/installations/77/access_tokens") {
      if (this.echoJwtOnMint !== null) {
        return json(401, { message: `${this.echoJwtOnMint}${headers.authorization?.replace(/^Bearer /, "") ?? ""}` });
      }
      return json(201, {
        token: this.token,
        expires_at: "2026-10-03T17:00:00Z",
        permissions: this.permissions,
        repositories: this.tokenRepositories.map((fullName) => ({ name: fullName.split("/")[1], full_name: fullName })),
      });
    }
    if (parsed.pathname === `${repoBase}/branches/${this.branchName}`) {
      if (this.failBranchWith) return json(this.failBranchWith, { message: this.branchMessage });
      return json(200, { name: "main", commit: { sha: this.commit, commit: { tree: { sha: this.treeSha() } } } });
    }
    if (parsed.pathname === `${repoBase}/git/trees/${this.treeSha()}`) {
      const tree = [
        { path: "wiki", mode: "040000", type: "tree", sha: "d".repeat(40) },
        { path: "wiki/link.md", mode: "120000", type: "blob", sha: "e".repeat(40), size: 10 },
        ...Object.keys(this.files).map((path) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: gitBlobSha(this.bytes(path)),
          size: this.understatedSizes.has(path) ? 10 : this.bytes(path).length,
        })),
      ];
      return json(200, { sha: this.treeSha(), truncated: this.truncated, tree });
    }
    const blob = parsed.pathname.match(new RegExp(`^${repoBase}/git/blobs/([0-9a-f]{40})$`));
    if (blob) {
      this.inFlightBlobs += 1;
      this.maxInFlightBlobs = Math.max(this.maxInFlightBlobs, this.inFlightBlobs);
      try {
        if (this.gate) await this.gate;
      } finally {
        this.inFlightBlobs -= 1;
      }
      const path = Object.keys(this.files).find((candidate) => gitBlobSha(this.bytes(candidate)) === blob[1]);
      if (!path) return json(404, { message: "Not Found" });
      const content = this.corrupt.has(path) ? Buffer.from("tampered") : this.bytes(path);
      return json(200, { sha: blob[1], encoding: "base64", content: content.toString("base64") });
    }
    return json(404, { message: "Not Found" });
  };

  blobCalls(): number {
    return this.calls.filter((call) => call.path.includes("/git/blobs/")).length;
  }
}

function mirrorConfig(overrides: Record<string, unknown> = {}) {
  return {
    gitMirror: {
      enabled: true,
      repository: "acme/handbook",
      branch: "main",
      spaceSlug: "default",
      githubAppId: "12345",
      githubAppInstallationId: "77",
      githubAppPrivateKey: SECRET,
      ...overrides,
    },
  };
}

/** A value as plugin state (a jsonb column) returns it: JSON only, object keys shorter first, then bytewise. */
function jsonbRoundTrip(value: unknown): unknown {
  const order = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(order);
    if (node === null || typeof node !== "object") return node;
    const keys = Object.keys(node).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return Object.fromEntries(keys.map((key) => [key, order((node as Record<string, unknown>)[key])]));
  };
  return value === undefined ? value : order(JSON.parse(JSON.stringify(value)));
}

/**
 * The host binds each ctx.db parameter through Drizzle, which renders an array as a parenthesized list of
 * parameters, so an array never reaches Postgres as one value. Lists travel as JSON text instead.
 */
function assertHostParams(sql: string, params: readonly unknown[] = []): void {
  if (params.some((param) => Array.isArray(param))) {
    throw new Error(`ctx.db got an array parameter, which the host renders as a list: ${sql.replace(/\s+/g, " ").slice(0, 100)}`);
  }
}

/** Plugin state and the database as the host gives them, where the harness stubs would hide the difference. */
function hostFaithful(harness: TestHarness): void {
  const { state, db } = harness.ctx;
  const get = state.get.bind(state);
  const set = state.set.bind(state);
  state.get = async (input) => jsonbRoundTrip(await get(input)) as Awaited<ReturnType<typeof get>>;
  state.set = async (input, value) => set(input, jsonbRoundTrip(value));
  const query = db.query.bind(db);
  const execute = db.execute.bind(db);
  db.query = (async (sql: string, params?: unknown[]) => {
    assertHostParams(sql, params);
    return query(sql, params);
  }) as typeof db.query;
  db.execute = async (sql: string, params?: unknown[]) => {
    assertHostParams(sql, params);
    return execute(sql, params);
  };
}

async function setup(files: RepoFiles, config: Record<string, unknown> = mirrorConfig()) {
  const harness = createTestHarness({ manifest });
  hostFaithful(harness);
  const github = new FakeGitHub(files);
  harness.ctx.http.fetch = github.fetch;
  harness.ctx.secrets.resolve = async (ref, options) => {
    expect(ref).toEqual(SECRET);
    expect(options).toMatchObject({ companyId: COMPANY_ID, configPath: "gitMirror.githubAppPrivateKey" });
    return PRIVATE_KEY_PEM;
  };
  harness.setConfig(config);
  await harness.ctx.localFolders.configure({ companyId: COMPANY_ID, folderKey: "wiki-root", path: "/srv/wiki", access: "readWrite" });
  await plugin.definition.setup(harness.ctx);
  return { harness, github };
}

async function read(harness: TestHarness, path: string): Promise<string | null> {
  try {
    return await harness.ctx.localFolders.readText(COMPANY_ID, "wiki-root", path);
  } catch {
    return null;
  }
}

/** The sync itself; the action, the job and config changes only queue it (see "Git mirror wiring"). */
function sync(harness: TestHarness, force = false) {
  return syncGitMirror(harness.ctx, COMPANY_ID, { force });
}

const HANDBOOK: RepoFiles = {
  "AGENTS.md": "# Agents\n",
  "IDEA.md": "# Idea\n",
  "wiki/index.md": "# Index\n\n[[projects/v3/index]]\n",
  "wiki/log.md": "# Log\n",
  "wiki/projects/v3/index.md": "# v3\n",
  ".github/PULL_REQUEST_TEMPLATE.md": "hidden\n",
  "raw/assets/diagram.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  "scripts/check.py": "print(1)\n",
};

describe("Git mirror config", () => {
  it("is off unless enabled and applies defaults", () => {
    expect(readGitMirrorConfig({})).toBeNull();
    expect(readGitMirrorConfig({ gitMirror: { repository: "acme/handbook" } })).toBeNull();
    expect(readGitMirrorConfig({ gitMirror: { enabled: true, repository: "acme/handbook" } })).toEqual({
      owner: "acme", repo: "handbook", branch: "main", spaceSlug: "default", auth: { kind: "none" }, error: null,
    });
    expect(readGitMirrorConfig(mirrorConfig())?.auth).toEqual({
      kind: "github_app", appId: "12345", installationId: "77", privateKeyRef: SECRET,
    });
  });

  it("reports misconfiguration instead of guessing", () => {
    expect(readGitMirrorConfig(mirrorConfig({ repository: "acme" }))?.error).toContain("owner/name");
    expect(readGitMirrorConfig(mirrorConfig({ repository: "acme/handbook/extra" }))?.error).toContain("owner/name");
    expect(readGitMirrorConfig(mirrorConfig({ branch: "../main" }))?.error).toContain("branch");
    expect(readGitMirrorConfig(mirrorConfig({ githubAppInstallationId: "77/../../user" }))?.error).toContain("installation ID");
    expect(readGitMirrorConfig(mirrorConfig({ githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----" }))?.error).toContain("Paperclip secret");
    expect(readGitMirrorConfig(mirrorConfig({ token: SECRET }))?.error).toContain("not both");
  });

  it("treats a cleared credential field as absent", () => {
    // The settings form sends "" when the secret picker is cleared.
    expect(readGitMirrorConfig({ gitMirror: { enabled: true, repository: "acme/handbook", token: "" } })?.auth).toEqual({ kind: "none" });
    expect(readGitMirrorConfig({ gitMirror: { enabled: true, repository: "acme/handbook", githubAppPrivateKey: null, token: SECRET } }))
      .toMatchObject({ auth: { kind: "token", tokenRef: SECRET }, error: null });
    expect(readGitMirrorConfig(mirrorConfig({ githubAppPrivateKey: "" }))?.error).toContain("Paperclip secret");
  });

  it("declares credential fields that accept only a secret reference or nothing", () => {
    const fields = (manifest.instanceConfigSchema as { properties: { gitMirror: { properties: Record<string, { format?: string; anyOf?: Array<Record<string, unknown>> }> } } })
      .properties.gitMirror.properties;
    for (const key of ["githubAppPrivateKey", "token"]) {
      expect(fields[key]?.format).toBe("secret-ref");
      expect(fields[key]?.anyOf).toEqual([
        expect.objectContaining({ type: "object", required: ["type", "secretId"] }),
        { type: "string", maxLength: 0 },
        { type: "null" },
      ]);
    }
  });
});

describe("Git mirror primitives", () => {
  it("computes Git blob ids and filters mirrorable paths", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(isMirrorablePath("wiki/projects/v3/index.md")).toBe(true);
    expect(isMirrorablePath("README.MD")).toBe(true);
    expect(isMirrorablePath(".github/PULL_REQUEST_TEMPLATE.md")).toBe(false);
    expect(isMirrorablePath("wiki/.drafts/a.md")).toBe(false);
    expect(isMirrorablePath("raw/assets/diagram.png")).toBe(false);
    expect(isMirrorablePath("wiki//a.md")).toBe(false);
    expect(isMirrorablePath("wiki/a\u0001.md")).toBe(false);
  });

  it("signs a GitHub App JWT the public key verifies", () => {
    const jwt = githubAppJwt("12345", PRIVATE_KEY_PEM, 1_800_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "12345" });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});

describe("Git mirror sync", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("mints a narrowed read-only token and mirrors Markdown into the default space", async () => {
    const { harness, github } = await setup(HANDBOOK);
    const result = await sync(harness);

    expect(result).toMatchObject({ status: "synced", repository: "acme/handbook", spaceSlug: "default", commitSha: github.commit, fileCount: 5 });
    const mint = github.calls[0]!;
    expect(mint).toMatchObject({ method: "POST", path: "/app/installations/77/access_tokens" });
    expect(mint.body).toEqual({ repositories: ["handbook"], permissions: { contents: "read" } });
    expect(mint.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(github.calls.slice(1).every((call) => call.method === "GET" && call.authorization === `Bearer ${INSTALLATION_TOKEN}`)).toBe(true);

    expect(await read(harness, "AGENTS.md")).toBe("# Agents\n");
    expect(await read(harness, "wiki/projects/v3/index.md")).toBe("# v3\n");
    expect(await read(harness, ".github/PULL_REQUEST_TEMPLATE.md")).toBeNull();
    expect(await read(harness, "scripts/check.py")).toBeNull();
    expect(await read(harness, "wiki/link.md")).toBeNull();

    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status).toMatchObject({ enabled: true, repository: "acme/handbook", branch: "main", spaceSlug: "default", commitSha: github.commit, fileCount: 5, lastError: null });
    expect(harness.activity.at(-1)?.message).toContain("5 written, 0 removed");
    const stored = JSON.stringify(harness.getState({ scopeKind: "company", scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" }));
    expect(stored).not.toContain(INSTALLATION_TOKEN);
    expect(stored).not.toContain("PRIVATE KEY");
  });

  it("does nothing more than a branch read while the commit is unchanged", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    github.calls = [];

    const result = await sync(harness);

    expect(result.status).toBe("unchanged");
    expect(github.calls.map((call) => call.path)).toEqual(["/app/installations/77/access_tokens", "/repos/acme/handbook/branches/main"]);
  });

  it("fetches only changed files and removes only files it mirrored", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    await harness.ctx.localFolders.writeTextAtomic(COMPANY_ID, "wiki-root", "wiki/entities/.gitkeep", "");
    github.files = { ...HANDBOOK, "wiki/index.md": "# Index v2\n", "wiki/new.md": "# New\n" };
    delete github.files["wiki/log.md"];
    github.commit = "c2".padEnd(40, "0");
    github.calls = [];

    const result = await sync(harness);

    expect(github.blobCalls()).toBe(2);
    expect(result.written.sort()).toEqual(["wiki/index.md", "wiki/new.md"]);
    expect(result.deleted).toEqual(["wiki/log.md"]);
    expect(await read(harness, "wiki/index.md")).toBe("# Index v2\n");
    expect(await read(harness, "wiki/log.md")).toBeNull();
    expect(await read(harness, "wiki/entities/.gitkeep")).toBe("");
  });

  it("leaves a synced mirror alone on the next run, though its state came back from jsonb in another key order", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    const stored = harness.getState({ scopeKind: "company", scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" }) as {
      source: Record<string, unknown>;
    };
    // The model is live: the stored source's keys are no longer in the order the sync builds them.
    expect(Object.keys(stored.source)).not.toEqual(["owner", "repo", "branch", "spaceSlug", "pathPrefix", "rootPath"]);
    github.calls = [];

    const result = await sync(harness);

    expect(result.status).toBe("unchanged");
    expect(result.deleted).toEqual([]);
    expect(github.blobCalls()).toBe(0);
    expect(await read(harness, "AGENTS.md")).toBe("# Agents\n");
  });

  it("re-fetches every file when forced", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    github.calls = [];

    await sync(harness, true);

    expect(github.blobCalls()).toBe(5);
  });

  it("creates a non-default target space and mirrors under its prefix", async () => {
    const { harness } = await setup(HANDBOOK, mirrorConfig({ spaceSlug: "Handbook" }));

    const result = await sync(harness);

    expect(result.spaceSlug).toBe("handbook");
    expect(await read(harness, "spaces/handbook/wiki/index.md")).toBe("# Index\n\n[[projects/v3/index]]\n");
    expect(await read(harness, "wiki/index.md")).toBeNull();
    // The mirror creates its target without the template's starter files.
    expect(await read(harness, "spaces/handbook/wiki/entities/.gitkeep")).toBeNull();
    expect(await read(harness, "spaces/handbook/.gitignore")).toBeNull();
  });

  it("removes the old copy when the source changes", async () => {
    const { harness } = await setup(HANDBOOK);
    await sync(harness);
    harness.setConfig(mirrorConfig({ spaceSlug: "handbook" }));

    const result = await sync(harness);

    expect(result.deleted.sort()).toEqual(["AGENTS.md", "IDEA.md", "wiki/index.md", "wiki/log.md", "wiki/projects/v3/index.md"]);
    expect(await read(harness, "wiki/projects/v3/index.md")).toBeNull();
    expect(await read(harness, "spaces/handbook/wiki/projects/v3/index.md")).toBe("# v3\n");
  });

  it("keeps a root mirror out of the other spaces' subfolders", async () => {
    const { harness } = await setup({ ...HANDBOOK, "spaces/handbook/wiki/index.md": "# intruder\n" });
    await harness.ctx.localFolders.writeTextAtomic(COMPANY_ID, "wiki-root", "spaces/handbook/wiki/index.md", "# handbook\n");

    const result = await sync(harness);

    // Outside the wiki layout, so it lands under wiki/, never in the other space's folder.
    expect(result.written).toContain("wiki/spaces/handbook/wiki/index.md");
    expect(await read(harness, "wiki/spaces/handbook/wiki/index.md")).toBe("# intruder\n");
    expect(await read(harness, "spaces/handbook/wiki/index.md")).toBe("# handbook\n");
  });

  it("puts Markdown outside the wiki layout under wiki/, and skips what still has no page path", async () => {
    const { harness } = await setup({
      "README.md": "# Readme\n",
      "docs/setup.md": "# Setup\n",
      "wiki/docs/setup.md": "# The wiki's own setup page\n",
      "NOTES.MD": "# Shouted\n",
      "index.md": "# Root index\n",
    });

    const result = await sync(harness);

    expect(result.written.sort()).toEqual(["index.md", "wiki/README.md", "wiki/docs/setup.md"]);
    expect(result.skipped).toEqual([
      // A file already at its page path keeps it, whatever the tree order.
      { path: "docs/setup.md", reason: "its wiki path wiki/docs/setup.md holds wiki/docs/setup.md" },
      { path: "NOTES.MD", reason: "the wiki reads only .md pages" },
    ]);
    expect(await read(harness, "wiki/README.md")).toBe("# Readme\n");
    expect(await read(harness, "wiki/docs/setup.md")).toBe("# The wiki's own setup page\n");
    expect(await read(harness, "README.md")).toBeNull();
    expect(await read(harness, "docs/setup.md")).toBeNull();
  });

  it("keeps the working copy when a changed branch does not exist", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    harness.setConfig(mirrorConfig({ branch: "mian" }));

    await expect(sync(harness)).rejects.toThrow("returned 404");

    for (const path of ["AGENTS.md", "IDEA.md", "wiki/index.md", "wiki/log.md", "wiki/projects/v3/index.md"]) {
      expect(await read(harness, path)).toBe(github.files[path]);
    }
    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status).toMatchObject({ branch: "mian", commitSha: github.commit, fileCount: 5 });
    expect(status.lastError).toContain("404");

    // Fixed: the original branch again, and the copy is still the synced one.
    harness.setConfig(mirrorConfig());
    github.calls = [];
    expect((await sync(harness)).status).toBe("unchanged");
    expect(github.blobCalls()).toBe(0);
  });

  it("deletes nothing for a changed source that fails before its tree checks out", async () => {
    for (const fail of ["credential", "truncated", "limits"] as const) {
      const { harness, github } = await setup(HANDBOOK);
      await sync(harness);
      harness.setConfig(mirrorConfig({ spaceSlug: "handbook" }));
      if (fail === "credential") github.permissions = { contents: "write", metadata: "read" };
      if (fail === "truncated") github.truncated = true;
      if (fail === "limits") {
        // Sixty files just under the per-file limit: past the total, so the tree is refused before any fetch.
        const fetch = github.fetch;
        harness.ctx.http.fetch = async (url, init) => {
          const response = await fetch(url, init);
          if (!url.includes("/git/trees/")) return response;
          const tree = await response.json() as { tree: unknown[] };
          for (let at = 0; at < 60; at += 1) {
            tree.tree.push({ path: `wiki/bulk/b${at}.md`, mode: "100644", type: "blob", sha: "a".repeat(40), size: 999_999 });
          }
          return new Response(JSON.stringify(tree), { status: 200 });
        };
      }

      await expect(sync(harness)).rejects.toThrow(fail === "credential" ? "more than contents: read" : fail === "truncated" ? "too large for one listing" : "the mirror stops at");

      for (const path of ["AGENTS.md", "wiki/index.md", "wiki/projects/v3/index.md"]) {
        expect(await read(harness, path), `${fail}: ${path}`).toBe(HANDBOOK[path]);
      }
      const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
      expect(status.fileCount, fail).toBe(5);
    }
  });

  it("replaces the copy in place when only the branch changes, removing only what the new branch lacks", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    harness.setConfig(mirrorConfig({ branch: "next" }));
    github.branchName = "next";
    github.commit = "d1".padEnd(40, "0");
    github.files = { ...HANDBOOK, "wiki/index.md": "# Index on next\n" };
    delete github.files["wiki/log.md"];
    const deletedPaths: string[] = [];
    const deleteFile = harness.ctx.localFolders.deleteFile.bind(harness.ctx.localFolders);
    harness.ctx.localFolders.deleteFile = async (companyId, folderKey, path) => {
      deletedPaths.push(path);
      return deleteFile(companyId, folderKey, path);
    };

    const result = await sync(harness);

    expect(result).toMatchObject({ status: "synced", branch: "next", commitSha: github.commit, fileCount: 4 });
    expect(deletedPaths).toEqual(["wiki/log.md"]);
    expect(await read(harness, "wiki/index.md")).toBe("# Index on next\n");
    expect(await read(harness, "wiki/projects/v3/index.md")).toBe("# v3\n");
  });

  it("coalesces repeated forced syncs into one queued run", async () => {
    const { harness, github } = await setup(HANDBOOK);
    let release: () => void = () => undefined;
    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = sync(harness);
    await vi.waitFor(() => expect(github.inFlightBlobs).toBe(1));
    const queued = [sync(harness, true), sync(harness, true), sync(harness, true), sync(harness)];
    release();
    const results = await Promise.all([first, ...queued]);

    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    for (const result of results.slice(2)) expect(result).toEqual(results[1]);
  });

  it("refuses the sync action to agents", async () => {
    const { harness, github } = await setup(HANDBOOK);

    await expect(harness.performAction("sync-git-mirror", { companyId: COMPANY_ID, force: true }, { actor: { type: "agent", agentId: "agent-1" } }))
      .rejects.toThrow("Agents cannot run a Git mirror sync");
    expect(github.calls).toHaveLength(0);
    await expect(harness.performAction("sync-git-mirror", { companyId: COMPANY_ID }, { actor: { type: "user", userId: "user-1" } }))
      .resolves.toEqual({ status: "queued" });
    expect(await read(harness, "wiki/index.md")).not.toBeNull();
  });

  it("shares one run between concurrent unforced syncs", async () => {
    const { harness, github } = await setup(HANDBOOK);

    const [first, second] = await Promise.all([sync(harness), sync(harness)]);

    expect(second).toEqual(first);
    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(github.blobCalls()).toBe(5);
  });

  it("queues a forced sync behind the running one and reads the config afresh", async () => {
    const { harness, github } = await setup(HANDBOOK);
    let release: () => void = () => undefined;
    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = sync(harness);
    await vi.waitFor(() => expect(github.inFlightBlobs).toBe(1));
    harness.setConfig(mirrorConfig({ spaceSlug: "handbook" }));
    const second = sync(harness, true);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(github.maxInFlightBlobs).toBe(1);
    expect(firstResult.spaceSlug).toBe("default");
    expect(secondResult.spaceSlug).toBe("handbook");
    expect(await read(harness, "spaces/handbook/wiki/index.md")).not.toBeNull();
    expect(await read(harness, "wiki/index.md")).toBeNull();
  });

  it("accepts a private key stored with escaped newlines", async () => {
    const { harness, github } = await setup(HANDBOOK);
    harness.ctx.secrets.resolve = async () => PRIVATE_KEY_PEM.replace(/\n/g, "\\n");

    await sync(harness);

    expect(github.calls[0]).toMatchObject({ method: "POST", path: "/app/installations/77/access_tokens" });
    expect(await read(harness, "AGENTS.md")).toBe("# Agents\n");
  });

  it("reads a public repository without credentials", async () => {
    const { harness, github } = await setup(HANDBOOK, { gitMirror: { enabled: true, repository: "acme/handbook" } });
    harness.ctx.secrets.resolve = async () => {
      throw new Error("no secret should be read");
    };

    await sync(harness);

    expect(github.calls.every((call) => call.method === "GET" && call.authorization === null)).toBe(true);
  });

  it("refuses an installation token that can write or reaches other repositories", async () => {
    const { harness, github } = await setup(HANDBOOK);
    github.permissions = { contents: "write", metadata: "read" };
    await expect(sync(harness)).rejects.toThrow("grants more than contents: read (contents)");
    github.permissions = { contents: "read", metadata: "read", actions: "read" };
    await expect(sync(harness)).rejects.toThrow("grants more than contents: read (actions)");
    github.permissions = { metadata: "read" };
    await expect(sync(harness)).rejects.toThrow("no contents: read");

    github.permissions = { contents: "read", metadata: "read" };
    github.tokenRepositories = ["acme/handbook", "acme/secrets"];
    await expect(sync(harness)).rejects.toThrow("not narrowed to acme/handbook");
    github.tokenRepositories = ["mallory/handbook"];
    await expect(sync(harness)).rejects.toThrow("not narrowed to acme/handbook");

    expect(await read(harness, "AGENTS.md")).toBeNull();
    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status.commitSha).toBeNull();
    expect(status.lastError).toContain("not narrowed");
  });

  it("matches the repository case-insensitively, as GitHub does", async () => {
    const { harness } = await setup(HANDBOOK, mirrorConfig({ repository: "Acme/Handbook" }));
    harness.ctx.http.fetch = async (url, init) => new FakeGitHub(HANDBOOK).fetch(url.replace("/repos/Acme/Handbook/", "/repos/acme/handbook/"), init);

    await expect(sync(harness)).resolves.toMatchObject({ status: "synced", fileCount: 5 });
  });

  it("refuses a truncated tree instead of mirroring part of it", async () => {
    const { harness, github } = await setup(HANDBOOK);
    github.truncated = true;

    await expect(sync(harness)).rejects.toThrow("refusing a partial mirror");
    expect(github.blobCalls()).toBe(0);
  });

  it("refuses content that does not match its Git object id and redoes the whole sync after the fix", async () => {
    const { harness, github } = await setup(HANDBOOK);
    github.corrupt.add("wiki/log.md");

    await expect(sync(harness)).rejects.toThrow("does not match its Git object id");
    expect(await read(harness, "wiki/log.md")).toBeNull();
    const failed = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(failed.commitSha).toBeNull();

    github.corrupt.clear();
    github.calls = [];
    const result = await sync(harness);
    // The failed run may have left files that no longer match their ledger entries: rewrite them all.
    expect(result.written).toHaveLength(5);
    expect(github.blobCalls()).toBe(5);
    expect(await read(harness, "wiki/log.md")).toBe("# Log\n");
  });

  it("reports GitHub errors without the credential", async () => {
    const { harness, github } = await setup(HANDBOOK);
    github.failBranchWith = 401;
    github.branchMessage = `Bad credentials for ${INSTALLATION_TOKEN}`;

    await expect(sync(harness)).rejects.toThrow("GitHub GET /repos/acme/handbook/branches/main returned 401: Bad credentials for [redacted]");
    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status.lastError).toContain("Bad credentials");
    expect(status.lastError).not.toContain(INSTALLATION_TOKEN);
  });

  it("keeps a transport error that quotes the Authorization header out of state and errors", async () => {
    const { harness } = await setup(HANDBOOK);
    const fake = new FakeGitHub(HANDBOOK);
    harness.ctx.http.fetch = async (url, init) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (url.includes("/branches/")) throw new TypeError(`Headers.append: "${authorization}" is an invalid header value.`);
      return fake.fetch(url, init);
    };

    const failure = await sync(harness).catch((error: Error) => error);

    expect((failure as Error).message).toBe("GitHub GET /repos/acme/handbook/branches/main request failed");
    const stored = JSON.stringify(harness.getState({ scopeKind: "company", scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" }));
    expect(stored).not.toContain(INSTALLATION_TOKEN);
  });

  it("scrubs an echoed JWT before trimming GitHub's message", async () => {
    const { harness, github } = await setup(HANDBOOK);
    github.echoJwtOnMint = "x".repeat(150) + " ";

    const failure = await sync(harness).catch((error: Error) => error);

    const jwtPrefix = githubAppJwt("12345", PRIVATE_KEY_PEM).split(".")[0]!;
    expect((failure as Error).message).toContain("returned 401");
    expect((failure as Error).message).not.toContain(jwtPrefix);
    expect((failure as Error).message).toContain("[redacted]");
  });

  it("refuses malformed object ids from GitHub before they reach a URL", async () => {
    const { harness, github } = await setup(HANDBOOK);
    github.malformedTreeSha = true;

    await expect(sync(harness)).rejects.toThrow("malformed object id");
    expect(github.calls.some((call) => call.path.includes("evil"))).toBe(false);
  });

  it("holds the size limits on the bytes received, not the tree's word", async () => {
    const big = "#".repeat(1_000_001);
    const { harness, github } = await setup({ ...HANDBOOK, "wiki/big.md": big });
    github.understatedSizes.add("wiki/big.md");

    const result = await sync(harness);

    expect(result.skipped).toContainEqual({ path: "wiki/big.md", reason: "larger than 1000000 bytes" });
    expect(await read(harness, "wiki/big.md")).toBeNull();
  });

  it("refuses a token a header cannot carry without echoing it", async () => {
    const token = "github_pat_line_one\nline_two";
    const { harness, github } = await setup(HANDBOOK, { gitMirror: { enabled: true, repository: "acme/handbook", token: SECRET } });
    harness.ctx.secrets.resolve = async () => token;

    const failure = await sync(harness).catch((error: Error) => error);

    expect((failure as Error).message).toBe("The repository token is empty or contains characters an HTTP header cannot carry");
    expect(github.calls).toHaveLength(0);
    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status.lastError).not.toContain("github_pat_line_one");
  });

  it("rewrites every file after a run whose write landed but then failed", async () => {
    const { harness, github } = await setup(HANDBOOK);
    const first = github.commit;
    await sync(harness);
    const write = harness.ctx.localFolders.writeTextAtomic.bind(harness.ctx.localFolders);
    harness.ctx.localFolders.writeTextAtomic = async (companyId, folderKey, path, contents) => {
      const status = await write(companyId, folderKey, path, contents);
      if (path === "wiki/index.md" || path === "wiki/new.md") throw new Error("fsync failed after rename");
      return status;
    };
    github.files = { "wiki/new.md": "# New\n", ...HANDBOOK, "wiki/index.md": "# Index B\n" };
    github.commit = "c2".padEnd(40, "0");
    await expect(sync(harness)).rejects.toThrow("fsync failed after rename");
    expect(await read(harness, "wiki/new.md")).toBe("# New\n");

    harness.ctx.localFolders.writeTextAtomic = write;
    github.files = HANDBOOK;
    github.commit = first;
    const result = await sync(harness);

    expect(result.status).toBe("synced");
    expect(await read(harness, "wiki/index.md")).toBe("# Index\n\n[[projects/v3/index]]\n");
    expect(result.deleted).toEqual(["wiki/new.md"]);
    expect(await read(harness, "wiki/new.md")).toBeNull();
  });

  it("does not fetch a blob again once it was judged unmirrorable", async () => {
    const bad = Buffer.from([0xff, 0xfe, 0x00]);
    const { harness, github } = await setup({ ...HANDBOOK, "wiki/bad.md": bad });
    await sync(harness);
    github.files = { ...HANDBOOK, "wiki/bad.md": bad, "wiki/index.md": "# Index v2\n" };
    github.commit = "c2".padEnd(40, "0");
    github.calls = [];

    const result = await sync(harness);

    expect(result.skipped).toContainEqual({ path: "wiki/bad.md", reason: "not UTF-8 text" });
    expect(github.calls.filter((call) => call.path.endsWith(`/git/blobs/${gitBlobSha(bad)}`))).toHaveLength(0);
    expect(github.blobCalls()).toBe(1);
  });

  it("never claims a local file at a path it skipped or never reached", async () => {
    const { harness, github } = await setup({ ...HANDBOOK, "wiki/local.md": Buffer.from([0xff, 0xfe, 0x00]) });
    await harness.ctx.localFolders.writeTextAtomic(COMPANY_ID, "wiki-root", "wiki/local.md", "operator note\n");
    await harness.ctx.localFolders.writeTextAtomic(COMPANY_ID, "wiki-root", "wiki/zz-later.md", "operator draft\n");

    const result = await sync(harness);
    expect(result.skipped).toContainEqual({ path: "wiki/local.md", reason: "not UTF-8 text" });
    expect(await read(harness, "wiki/local.md")).toBe("operator note\n");

    // A failure part-way leaves later paths unattempted; removing one upstream must not delete the local file.
    github.files = { ...HANDBOOK, "wiki/index.md": "# Index B\n", "wiki/zz-later.md": "# upstream\n" };
    github.commit = "c2".padEnd(40, "0");
    github.corrupt.add("wiki/index.md");
    await expect(sync(harness)).rejects.toThrow("does not match its Git object id");
    github.files = HANDBOOK;
    github.commit = "c3".padEnd(40, "0");
    github.corrupt.clear();
    await sync(harness);

    expect(await read(harness, "wiki/zz-later.md")).toBe("operator draft\n");
    expect(await read(harness, "wiki/local.md")).toBe("operator note\n");
  });

  it("writes and deletes nothing in a root retargeted while a sync runs", async () => {
    const { harness, github } = await setup({ ...HANDBOOK, "wiki/old.md": "# old\n" });
    await sync(harness);
    github.files = { ...HANDBOOK, "wiki/index.md": "# Index v2\n", "wiki/new.md": "# New\n" };
    github.commit = "c2".padEnd(40, "0");
    let release: () => void = () => undefined;
    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = sync(harness);
    await vi.waitFor(() => expect(github.inFlightBlobs).toBe(1));
    await harness.ctx.localFolders.configure({ companyId: COMPANY_ID, folderKey: "wiki-root", path: "/srv/other-root", access: "readWrite" });
    await harness.ctx.localFolders.writeTextAtomic(COMPANY_ID, "wiki-root", "wiki/old.md", "the new root's own file\n");
    await harness.ctx.localFolders.writeTextAtomic(COMPANY_ID, "wiki-root", "wiki/index.md", "the new root's own index\n");
    release();

    await expect(running).rejects.toThrow("root folder changed during the sync");
    expect(await read(harness, "wiki/old.md")).toBe("the new root's own file\n");
    expect(await read(harness, "wiki/index.md")).toBe("the new root's own index\n");
    expect(await read(harness, "wiki/new.md")).toBeNull();
    github.gate = null;
    const next = await sync(harness);
    expect(next.deleted).toEqual([]);
  });

  it("reconciles a new wiki root from scratch and deletes nothing when the root changes", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    await harness.ctx.localFolders.configure({ companyId: COMPANY_ID, folderKey: "wiki-root", path: "/srv/wiki-moved", access: "readWrite" });
    github.calls = [];

    const result = await sync(harness);

    expect(result.status).toBe("synced");
    expect(result.written).toHaveLength(5);
    expect(result.deleted).toEqual([]);
    expect(github.blobCalls()).toBe(5);
  });

  it("does not trust an unchanged head after a failed sync, so a revert is reconciled", async () => {
    const { harness, github } = await setup(HANDBOOK);
    const first = github.commit;
    await sync(harness);
    github.files = { ...HANDBOOK, "wiki/index.md": "# Index B\n", "wiki/log.md": "# Log B\n" };
    github.commit = "c2".padEnd(40, "0");
    github.corrupt.add("wiki/log.md");
    await expect(sync(harness)).rejects.toThrow("does not match its Git object id");
    expect(await read(harness, "wiki/index.md")).toBe("# Index B\n");

    github.files = HANDBOOK;
    github.commit = first;
    github.corrupt.clear();
    const result = await sync(harness);

    expect(result.status).toBe("synced");
    expect(result.written).toHaveLength(5);
    expect(await read(harness, "wiki/index.md")).toBe("# Index\n\n[[projects/v3/index]]\n");
    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status).toMatchObject({ commitSha: first, lastError: null });
  });

  it("prepares a root configured through the host route before mirroring into it", async () => {
    const { harness } = await setup(HANDBOOK);
    const configured = await harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    const status = harness.ctx.localFolders.status.bind(harness.ctx.localFolders);
    let prepared = false;
    harness.ctx.localFolders.status = async (companyId, folderKey) => (prepared
      ? status(companyId, folderKey)
      : { ...configured, writable: false, healthy: false, missingDirectories: ["wiki/entities", "wiki/concepts"] });
    const configure = harness.ctx.localFolders.configure.bind(harness.ctx.localFolders);
    const calls: unknown[] = [];
    harness.ctx.localFolders.configure = async (input) => {
      calls.push(input);
      prepared = true;
      return configure(input);
    };

    await sync(harness);

    expect(calls).toEqual([expect.objectContaining({
      companyId: COMPANY_ID,
      folderKey: "wiki-root",
      path: "/srv/wiki",
      access: "readWrite",
      requiredDirectories: expect.arrayContaining(["wiki/entities", "wiki/concepts", "wiki/synthesis"]),
    })]);
    expect(await read(harness, "wiki/index.md")).not.toBeNull();
  });

  it("needs a configured wiki root folder", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig(mirrorConfig());
    await plugin.definition.setup(harness.ctx);

    await expect(sync(harness)).rejects.toThrow("Configure the LLM Wiki root folder");
  });

  it("syncs right after the mirror config is saved", async () => {
    const { harness, github } = await setup(HANDBOOK);

    await plugin.definition.onConfigChanged?.(mirrorConfig(), { companyId: COMPANY_ID });

    // The hook returns before the sync ends; wait for the whole run so it cannot leak into the next test.
    await vi.waitFor(async () => {
      const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
      expect(status).toMatchObject({ commitSha: github.commit, running: false });
    });
    expect(await read(harness, "wiki/index.md")).not.toBeNull();
    expect(github.blobCalls()).toBe(5);
  });
});

describe("Git mirror write guard", () => {
  it("refuses plugin writes into the mirrored space", async () => {
    const { harness } = await setup(HANDBOOK);
    await sync(harness);

    await expect(harness.performAction("write-page", { companyId: COMPANY_ID, path: "wiki/index.md", contents: "# edited\n" }))
      .rejects.toThrow("read-only mirror of github.com/acme/handbook@main");
    await expect(harness.performAction("capture-source", { companyId: COMPANY_ID, title: "note", contents: "x" }))
      .rejects.toThrow("read-only mirror");
    await expect(harness.performAction("write-template", { companyId: COMPANY_ID, path: "AGENTS.md", contents: "x" }))
      .rejects.toThrow("read-only mirror");
    await expect(harness.executeTool("wiki_append_log", { companyId: COMPANY_ID, wikiId: "default", entry: "x" }))
      .rejects.toThrow("read-only mirror");
    expect(await read(harness, "wiki/index.md")).toBe("# Index\n\n[[projects/v3/index]]\n");
  });

  it("points a mirrored root without writing bootstrap's starter files", async () => {
    const { harness } = await setup(HANDBOOK);

    await harness.performAction("bootstrap-root", { companyId: COMPANY_ID, path: "/srv/wiki" });

    expect(await read(harness, "AGENTS.md")).toBeNull();
    expect(await read(harness, "wiki/index.md")).toBeNull();
    await expect(harness.performAction("bootstrap-space", { companyId: COMPANY_ID, spaceSlug: "default" }))
      .rejects.toThrow("read-only mirror");
  });

  it("refuses an ordinary create of the mirror's target space", async () => {
    const { harness } = await setup(HANDBOOK, mirrorConfig({ spaceSlug: "handbook" }));

    await expect(harness.performAction("create-space", { companyId: COMPANY_ID, slug: "handbook", displayName: "Handbook" }))
      .rejects.toThrow("read-only mirror");
    expect(await read(harness, "spaces/handbook/AGENTS.md")).toBeNull();
    await harness.performAction("create-space", { companyId: COMPANY_ID, slug: "notes", displayName: "Notes" });
    expect(await read(harness, "spaces/notes/AGENTS.md")).not.toBeNull();
  });

  it("still bootstraps the root when the mirror targets another space", async () => {
    const { harness } = await setup(HANDBOOK, mirrorConfig({ spaceSlug: "handbook" }));

    await harness.performAction("bootstrap-root", { companyId: COMPANY_ID, path: "/srv/wiki" });

    expect(await read(harness, "AGENTS.md")).not.toBeNull();
  });

  it("leaves other spaces writable", async () => {
    const { harness } = await setup(HANDBOOK, mirrorConfig({ spaceSlug: "handbook" }));

    await harness.performAction("write-page", { companyId: COMPANY_ID, path: "wiki/notes.md", contents: "# notes\n" });

    expect(await read(harness, "wiki/notes.md")).toBe("# notes\n");
  });
});

describe("Git mirror wiring", () => {
  const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";

  /**
   * Every GitHub request a sync makes must run inside the plugin's own company-scoped event handler. The
   * async context, not a global counter, decides: a sync started outside an event is caught even when it
   * overlaps one.
   */
  function traceEventScope(harness: TestHarness, github: FakeGitHub) {
    const scope = new AsyncLocalStorage<true>();
    const outside: string[] = [];
    const emit = harness.ctx.events.emit.bind(harness.ctx.events);
    harness.ctx.events.emit = (name, companyId, payload) => scope.run(true, () => emit(name, companyId, payload));
    harness.ctx.http.fetch = async (url, init) => {
      if (scope.getStore() !== true) outside.push(url);
      return github.fetch(url, init);
    };
    return outside;
  }

  it("runs the scheduled sync from the companies reported by onConfigChanged, never by listing companies", async () => {
    const { harness, github } = await setup(HANDBOOK);
    const outside = traceEventScope(harness, github);
    harness.ctx.companies.list = async () => {
      throw new Error("the host refuses companies.list from a job");
    };
    harness.ctx.config.get = async (companyId?: string) => (companyId === COMPANY_ID ? mirrorConfig() : {});
    await plugin.definition.onConfigChanged?.({}, { companyId: OTHER_COMPANY_ID });
    await plugin.definition.onConfigChanged?.(mirrorConfig(), { companyId: COMPANY_ID });
    github.calls = [];
    github.commit = "c9".padEnd(40, "0");

    await harness.runJob(GIT_MIRROR_JOB_KEY);

    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(await read(harness, "wiki/index.md")).not.toBeNull();
    expect(outside).toEqual([]);
  });

  it("stops scheduling a company whose mirror is turned off", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await plugin.definition.onConfigChanged?.(mirrorConfig(), { companyId: COMPANY_ID });
    await plugin.definition.onConfigChanged?.({ gitMirror: { enabled: false } }, { companyId: COMPANY_ID });
    github.calls = [];

    await harness.runJob(GIT_MIRROR_JOB_KEY);

    expect(github.calls).toHaveLength(0);
  });

  async function settled(harness: TestHarness, github: FakeGitHub) {
    await vi.waitFor(async () => {
      const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
      expect(status).toMatchObject({ commitSha: github.commit, running: false });
    });
  }

  it("queues a config-change sync through the event, so it does not outlive the settled configChanged call", async () => {
    const { harness, github } = await setup(HANDBOOK);
    const outside = traceEventScope(harness, github);

    await plugin.definition.onConfigChanged?.(mirrorConfig(), { companyId: COMPANY_ID });
    await settled(harness, github);

    expect(github.blobCalls()).toBe(5);
    expect(outside).toEqual([]);
  });

  it("queues Sync now through the event, so it does not outlive the settled action call", async () => {
    const { harness, github } = await setup(HANDBOOK);
    const outside = traceEventScope(harness, github);

    await expect(harness.performAction("sync-git-mirror", { companyId: COMPANY_ID, force: true }, { actor: { type: "user", userId: "user-1" } }))
      .resolves.toEqual({ status: "queued" });
    await settled(harness, github);

    expect(github.blobCalls()).toBe(5);
    expect(outside).toEqual([]);
  });

  it("reconciles a config change made during a running sync in a follow-up run", async () => {
    const { harness, github } = await setup(HANDBOOK);
    const outside = traceEventScope(harness, github);
    let release: () => void = () => undefined;
    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = harness.performAction("sync-git-mirror", { companyId: COMPANY_ID }, { actor: { type: "user", userId: "user-1" } });
    await vi.waitFor(() => expect(github.inFlightBlobs).toBe(1));
    harness.setConfig(mirrorConfig({ branch: "next" }));
    github.branchName = "next";
    github.commit = "d1".padEnd(40, "0");
    await plugin.definition.onConfigChanged?.(mirrorConfig({ branch: "next" }), { companyId: COMPANY_ID });
    release();
    await first;

    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status).toMatchObject({ branch: "next", commitSha: github.commit, running: false });
    expect(github.calls.filter((call) => call.path.endsWith("/branches/next"))).toHaveLength(1);
    expect(outside).toEqual([]);
  });

  it("hands a run that reaches its time budget to a continuation until the mirror is complete", async () => {
    const { harness, github } = await setup(HANDBOOK);
    const budget = gitMirrorTuning.syncBudgetMs;
    gitMirrorTuning.syncBudgetMs = 0;
    try {
      await harness.performAction("sync-git-mirror", { companyId: COMPANY_ID }, { actor: { type: "user", userId: "user-1" } });
    } finally {
      gitMirrorTuning.syncBudgetMs = budget;
    }

    // One file per run, each run in a fresh event: five runs, five token mints, five blob fetches.
    expect(github.blobCalls()).toBe(5);
    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(5);
    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status).toMatchObject({ commitSha: github.commit, fileCount: 5, lastError: null });
    expect(await read(harness, "wiki/projects/v3/index.md")).toBe("# v3\n");
  });

  it("keeps a forced rewrite resumable across hand-offs, fetching each file once", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    github.calls = [];
    const budget = gitMirrorTuning.syncBudgetMs;
    gitMirrorTuning.syncBudgetMs = 0;
    try {
      await harness.performAction("sync-git-mirror", { companyId: COMPANY_ID, force: true }, { actor: { type: "user", userId: "user-1" } });
    } finally {
      gitMirrorTuning.syncBudgetMs = budget;
    }

    expect(github.blobCalls()).toBe(5);
  });

  it("runs one sync for an event delivered twice, instead of chaining follow-ups", async () => {
    const { harness, github } = await setup(HANDBOOK);
    // A second setup registers the handler again, the way a stale host subscription delivers each event twice.
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("sync-git-mirror", { companyId: COMPANY_ID }, { actor: { type: "user", userId: "user-1" } });
    await settled(harness, github);

    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(github.blobCalls()).toBe(5);
  });

  it("finishes a source-change cleanup across hand-offs when the budget runs out mid-cleanup", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    harness.setConfig(mirrorConfig({ spaceSlug: "handbook" }));
    // Which event run (each emit starts one) performed each deletion of the old copy.
    let eventRun = 0;
    const emit = harness.ctx.events.emit.bind(harness.ctx.events);
    harness.ctx.events.emit = async (name, companyId, payload) => {
      eventRun += 1;
      return emit(name, companyId, payload);
    };
    const deletedInRun: number[] = [];
    const deleteFile = harness.ctx.localFolders.deleteFile.bind(harness.ctx.localFolders);
    harness.ctx.localFolders.deleteFile = async (companyId, folderKey, path) => {
      if (!path.startsWith("spaces/")) deletedInRun.push(eventRun);
      return deleteFile(companyId, folderKey, path);
    };
    const budget = gitMirrorTuning.syncBudgetMs;
    gitMirrorTuning.syncBudgetMs = 0;
    try {
      await plugin.definition.onConfigChanged?.(mirrorConfig({ spaceSlug: "handbook" }), { companyId: COMPANY_ID });
      await settled(harness, github);
    } finally {
      gitMirrorTuning.syncBudgetMs = budget;
    }

    // The cleanup spends the budget too: one deletion per run, each run in a fresh event.
    expect(deletedInRun).toHaveLength(5);
    expect(new Set(deletedInRun).size).toBe(5);

    for (const path of ["AGENTS.md", "IDEA.md", "wiki/index.md", "wiki/log.md", "wiki/projects/v3/index.md"]) {
      expect(await read(harness, path)).toBeNull();
      expect(await read(harness, `spaces/handbook/${path}`)).not.toBeNull();
    }
    const status = await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID });
    expect(status).toMatchObject({ spaceSlug: "handbook", fileCount: 5, continuing: false, lastError: null });
  });

  it("keeps a forced request whose event was lost, and applies it on the next scheduled sync", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    await plugin.definition.onConfigChanged?.(mirrorConfig(), { companyId: COMPANY_ID });
    const emit = harness.ctx.events.emit.bind(harness.ctx.events);
    harness.ctx.events.emit = async () => undefined;
    await harness.performAction("sync-git-mirror", { companyId: COMPANY_ID, force: true }, { actor: { type: "user", userId: "user-1" } });
    harness.ctx.events.emit = emit;
    expect((await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID })).forcePending).toBe(true);
    github.calls = [];

    await harness.runJob(GIT_MIRROR_JOB_KEY);

    expect(github.blobCalls()).toBe(5);
    expect((await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID })).forcePending).toBe(false);
  });

  it("keeps a forced request made while an older sync runs, even when that sync saves after it", async () => {
    const { harness, github } = await setup(HANDBOOK);
    await sync(harness);
    await plugin.definition.onConfigChanged?.(mirrorConfig(), { companyId: COMPANY_ID });
    github.commit = "c2".padEnd(40, "0");
    github.files = { ...HANDBOOK, "wiki/index.md": "# Index v2\n" };
    let release: () => void = () => undefined;
    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const older = harness.performAction("sync-git-mirror", { companyId: COMPANY_ID }, { actor: { type: "user", userId: "user-1" } });
    await vi.waitFor(() => expect(github.inFlightBlobs).toBe(1));
    await harness.performAction("sync-git-mirror", { companyId: COMPANY_ID, force: true }, { actor: { type: "user", userId: "user-1" } });
    // The older run's successor event (its follow-up) is lost, as at a crash hand-off.
    const emit = harness.ctx.events.emit.bind(harness.ctx.events);
    harness.ctx.events.emit = async () => undefined;
    release();
    await older;
    harness.ctx.events.emit = emit;
    github.gate = null;

    expect((await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID })).forcePending).toBe(true);
    github.calls = [];
    await harness.runJob(GIT_MIRROR_JOB_KEY);

    expect(github.blobCalls()).toBe(5);
    expect((await harness.getData<GitMirrorStatus>("git-mirror", { companyId: COMPANY_ID })).forcePending).toBe(false);
  });

  it("counts every one of several overlapping forced requests", async () => {
    const { harness } = await setup(HANDBOOK);
    const forceKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror-force" };
    // The first request's read stalls, so the others would read the same count without the queue.
    const get = harness.ctx.state.get.bind(harness.ctx.state);
    let stall = true;
    harness.ctx.state.get = async (scope) => {
      if (stall && scope.stateKey === "git-mirror-force") {
        stall = false;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return get(scope);
    };

    await Promise.all([1, 2, 3].map(() => requestForcedGitMirrorRewrite(harness.ctx, COMPANY_ID)));

    expect(harness.getState(forceKey)).toEqual({ requested: 3 });
  });

  it("refuses Sync now when the mirror is off", async () => {
    const { harness, github } = await setup(HANDBOOK, {});

    await expect(harness.performAction("sync-git-mirror", { companyId: COMPANY_ID }, { actor: { type: "user", userId: "user-1" } }))
      .rejects.toThrow("not enabled");
    expect(github.calls).toHaveLength(0);
  });
});

/**
 * The plugin's page table, as far as the mirror and the read tools use it: the harness database is a stub,
 * so this answers the statements that touch wiki_pages and leaves every other statement to it.
 */
class PageIndex {
  rows = new Map<string, { spaceId: string; path: string; title: string; pageType: string | null; backlinks: string[]; hash: string }>();
  failInsertFor: string | null = null;
  revisionInserts = 0;
  rowInserts = 0;

  install(harness: TestHarness): void {
    const execute = harness.ctx.db.execute.bind(harness.ctx.db);
    const query = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.execute = async (sql: string, params: unknown[] = []) => {
      assertHostParams(sql, params);
      if (sql.includes("wiki_page_revisions")) this.revisionInserts += 1;
      if (/INSERT INTO \S*wiki_pages\b/.test(sql)) {
        const [, , , spaceId, path, title, pageType, backlinks, hash] = params as string[];
        if (path === this.failInsertFor) {
          this.failInsertFor = null;
          throw new Error("database unavailable");
        }
        this.rows.set(`${spaceId}|${path}`, { spaceId, path, title, pageType, backlinks: JSON.parse(backlinks), hash });
        this.rowInserts += 1;
        return { rowCount: 1 };
      }
      if (/DELETE FROM \S*wiki_pages\b/.test(sql)) {
        expect(sql).toContain("jsonb_array_elements_text($4::jsonb)");
        const [, , spaceId, pathsJson] = params as [string, string, string, string];
        const paths = JSON.parse(pathsJson) as string[];
        for (const path of paths) this.rows.delete(`${spaceId}|${path}`);
        return { rowCount: paths.length };
      }
      return execute(sql, params);
    };
    harness.ctx.db.query = (async (sql: string, params: unknown[] = []) => {
      assertHostParams(sql, params);
      if (!/FROM \S*wiki_pages\b/.test(sql)) return query(sql, params);
      const inSpace = (spaceId: unknown) => [...this.rows.values()].filter((row) => row.spaceId === spaceId).sort((a, b) => a.path.localeCompare(b.path));
      if (sql.includes("backlinks ? $3")) {
        return inSpace(params[3]).filter((row) => row.backlinks.includes(params[2] as string)).map(({ path, title }) => ({ path, title }));
      }
      if (sql.includes("UNION ALL")) {
        const needle = String(params[2]).replace(/%/g, "").toLowerCase();
        return inSpace(params[4])
          .filter((row) => row.path.toLowerCase().includes(needle) || row.title.toLowerCase().includes(needle))
          .map((row) => ({ kind: "page", path: row.path, title: row.title, match_text: row.pageType }));
      }
      return inSpace(params[2]).map((row) => ({ path: row.path, title: row.title, page_type: row.pageType }));
    }) as typeof harness.ctx.db.query;
  }

  paths(spaceId?: string): string[] {
    return [...this.rows.values()].filter((row) => !spaceId || row.spaceId === spaceId).map((row) => row.path).sort();
  }
}

const INDEXED_HANDBOOK: RepoFiles = {
  ...HANDBOOK,
  "README.md": "# Readme\n\nStart with the setup page.\n",
  "docs/setup.md": "# Setup guide\n",
  "wiki/projects/v3/how-it-works.md": [
    "---",
    "# a YAML comment, not a heading",
    "title: \"Frontmatter title\"",
    "---",
    "",
    "# How v3 works",
    "",
    "See [[projects/v3/index]], [[projects/v3/gaps#g-1|the gaps]] and [[wiki/log]].",
    "",
    "```",
    "[[projects/v3/in-a-code-example]]",
    "```",
    "",
  ].join("\n"),
};

async function setupIndexed(files: RepoFiles, config?: Record<string, unknown>) {
  const ready = await setup(files, config);
  const index = new PageIndex();
  index.install(ready.harness);
  return { ...ready, index };
}

async function toolText(harness: TestHarness, tool: string, params: Record<string, unknown> = {}): Promise<string> {
  const result = await harness.executeTool<{ content?: string }>(tool, { companyId: COMPANY_ID, wikiId: "default", ...params });
  return result.content ?? "";
}

describe("Git mirror page index", () => {
  it("indexes every mirrored page so the read tools list, search and follow it", async () => {
    const { harness, index } = await setupIndexed(INDEXED_HANDBOOK);

    await sync(harness);

    expect(index.paths()).toEqual([
      "AGENTS.md",
      "IDEA.md",
      "wiki/README.md",
      "wiki/docs/setup.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/projects/v3/how-it-works.md",
      "wiki/projects/v3/index.md",
    ]);
    const howRow = [...index.rows.values()].find((row) => row.path === "wiki/projects/v3/how-it-works.md")!;
    expect(howRow.title).toBe("How v3 works");
    expect(howRow.pageType).toBe("projects");
    // Code is not told apart from prose: the code example's link is recorded too (documented).
    expect(howRow.backlinks).toEqual(["wiki/log.md", "wiki/projects/v3/gaps.md", "wiki/projects/v3/in-a-code-example.md", "wiki/projects/v3/index.md"]);
    expect(index.revisionInserts).toBe(0);

    expect(await toolText(harness, "wiki_list_pages")).toContain("wiki/projects/v3/how-it-works.md - How v3 works");
    expect(await toolText(harness, "wiki_search", { query: "how v3" })).toBe("page: wiki/projects/v3/how-it-works.md - How v3 works");
    expect((await toolText(harness, "wiki_list_backlinks", { path: "wiki/projects/v3/index.md" })).split("\n")).toEqual([
      "wiki/index.md - Index",
      "wiki/projects/v3/how-it-works.md - How v3 works",
    ]);
    expect(await toolText(harness, "wiki_read_page", { path: "wiki/projects/v3/how-it-works.md" })).toContain("# How v3 works");

    // Files outside the wiki layout land under wiki/, where the same tools read, list and search them.
    expect(await toolText(harness, "wiki_read_page", { path: "wiki/README.md" })).toContain("Start with the setup page.");
    expect(await toolText(harness, "wiki_read_page", { path: "wiki/docs/setup.md" })).toBe("# Setup guide\n");
    expect(await toolText(harness, "wiki_search", { query: "readme" })).toBe("page: wiki/README.md - Readme");
    expect(await toolText(harness, "wiki_search", { query: "setup guide" })).toBe("page: wiki/docs/setup.md - Setup guide");
    expect(await toolText(harness, "wiki_list_pages")).toContain("wiki/docs/setup.md - Setup guide");
  });

  it("updates the rows of changed pages and removes the rows of deleted ones", async () => {
    const { harness, github, index } = await setupIndexed(INDEXED_HANDBOOK);
    await sync(harness);
    github.files = { ...INDEXED_HANDBOOK, "wiki/index.md": "# Index, second edition\n\n[[projects/v3/index]]\n" };
    delete github.files["wiki/projects/v3/how-it-works.md"];
    github.commit = "c2".padEnd(40, "0");

    await sync(harness);

    expect(index.paths()).not.toContain("wiki/projects/v3/how-it-works.md");
    expect([...index.rows.values()].find((row) => row.path === "wiki/index.md")?.title).toBe("Index, second edition");
    expect(await toolText(harness, "wiki_list_backlinks", { path: "wiki/projects/v3/index.md" })).toBe("wiki/index.md - Index, second edition");
  });

  it("redoes a page whose index row failed to write", async () => {
    const { harness, github, index } = await setupIndexed(INDEXED_HANDBOOK);
    index.failInsertFor = "wiki/projects/v3/index.md";

    await expect(sync(harness)).rejects.toThrow("database unavailable");
    github.calls = [];
    await sync(harness);

    expect(index.paths()).toContain("wiki/projects/v3/index.md");
    expect(github.blobCalls()).toBeGreaterThan(0);
  });

  it("backfills the rows of pages mirrored before the index existed, without fetching them again", async () => {
    const { harness, github, index } = await setupIndexed(INDEXED_HANDBOOK);
    await sync(harness);
    // A ledger written before the index existed: every page mirrored, no row.
    index.rows.clear();
    github.calls = [];

    const result = await sync(harness);

    expect(result.status).toBe("unchanged");
    expect(github.blobCalls()).toBe(0);
    expect(index.paths()).toEqual([
      "AGENTS.md",
      "IDEA.md",
      "wiki/README.md",
      "wiki/docs/setup.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/projects/v3/how-it-works.md",
      "wiki/projects/v3/index.md",
    ]);
  });

  it("replaces rows the space held before the mirror owned the paths, once, from disk", async () => {
    const { harness, github, index } = await setupIndexed(INDEXED_HANDBOOK);
    await sync(harness);
    const spaceId = [...index.rows.values()][0]!.spaceId;
    // A ledger from before the index existed, over a row an agent wrote before the mirror took the path.
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" };
    const stored = harness.getState(stateKey) as Record<string, unknown>;
    await harness.ctx.state.set(stateKey, { ...stored, indexedSpace: undefined, indexVerified: undefined });
    index.rows.set(`${spaceId}|wiki/projects/v3/index.md`, {
      spaceId, path: "wiki/projects/v3/index.md", title: "Previous local title", pageType: "projects", backlinks: ["wiki/old.md"], hash: "old",
    });
    github.calls = [];

    const result = await sync(harness);

    expect(result.status).toBe("unchanged");
    expect(github.blobCalls()).toBe(0);
    expect(index.rows.get(`${spaceId}|wiki/projects/v3/index.md`)).toMatchObject({ title: "v3", backlinks: [] });
  });

  it("keeps checking every page until one pass reads them all", async () => {
    const { harness, index } = await setupIndexed(INDEXED_HANDBOOK);
    await sync(harness);
    const spaceId = [...index.rows.values()][0]!.spaceId;
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" };
    const stored = harness.getState(stateKey) as Record<string, unknown>;
    await harness.ctx.state.set(stateKey, { ...stored, indexedSpace: undefined, indexVerified: undefined });
    const stale = { spaceId, path: "wiki/projects/v3/index.md", title: "Previous local title", pageType: "projects", backlinks: [] as string[], hash: "old" };
    index.rows.set(`${spaceId}|wiki/projects/v3/index.md`, { ...stale });
    index.rows.set(`${spaceId}|wiki/index.md`, { ...stale, path: "wiki/index.md" });
    const readText = harness.ctx.localFolders.readText.bind(harness.ctx.localFolders);
    harness.ctx.localFolders.readText = async (companyId, folderKey, relativePath) => {
      if (relativePath === "wiki/index.md") throw new Error("disk busy");
      return readText(companyId, folderKey, relativePath);
    };

    await sync(harness);
    expect(index.rows.get(`${spaceId}|wiki/projects/v3/index.md`)?.title).toBe("v3");
    expect(index.rows.get(`${spaceId}|wiki/index.md`)?.title).toBe("Previous local title");
    harness.ctx.localFolders.readText = readText;

    await sync(harness);
    expect(index.rows.get(`${spaceId}|wiki/index.md`)?.title).toBe("Index");
  });

  it("reads no page back from disk in a sync that wrote it", async () => {
    const { harness } = await setupIndexed(INDEXED_HANDBOOK);
    const reads: string[] = [];
    const readText = harness.ctx.localFolders.readText.bind(harness.ctx.localFolders);
    harness.ctx.localFolders.readText = async (companyId, folderKey, relativePath) => {
      reads.push(relativePath);
      return readText(companyId, folderKey, relativePath);
    };

    expect((await sync(harness)).status).toBe("synced");

    expect(reads).toEqual([]);
  });

  it("spends the time budget on the index check and resumes it where it stopped", async () => {
    const pages = Object.fromEntries(Array.from({ length: 50 }, (_, at) => [`wiki/notes/n${String(at).padStart(2, "0")}.md`, `# Note ${at}\n`]));
    const { harness, github, index } = await setupIndexed(pages);
    await sync(harness);
    // A ledger from before the index existed: every page's row is due for a check from disk.
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" };
    const stored = harness.getState(stateKey) as Record<string, unknown>;
    await harness.ctx.state.set(stateKey, { ...stored, indexedSpace: undefined, indexVerified: undefined });
    index.rows.clear();
    // Each read takes 100 ms of a 1,000 ms budget.
    let now = Date.parse("2026-10-19T06:00:00Z");
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const reads: string[] = [];
    const readText = harness.ctx.localFolders.readText.bind(harness.ctx.localFolders);
    harness.ctx.localFolders.readText = async (companyId, folderKey, relativePath) => {
      reads.push(relativePath);
      now += 100;
      return readText(companyId, folderKey, relativePath);
    };
    github.calls = [];
    try {
      const statuses: string[] = [];
      for (let run = 0; run < 10; run += 1) {
        const result = await syncGitMirror(harness.ctx, COMPANY_ID, { budgetMs: 1_000 });
        statuses.push(result.status);
        if (result.status !== "partial") break;
      }

      expect(statuses).toEqual(["partial", "partial", "partial", "partial", "unchanged"]);
    } finally {
      dateNow.mockRestore();
    }
    // Every page read once across the runs, none twice, and no file fetched again.
    expect(reads).toHaveLength(50);
    expect(new Set(reads).size).toBe(50);
    expect(github.blobCalls()).toBe(0);
    expect(index.paths()).toHaveLength(50);
    expect((harness.getState(stateKey) as { indexVerified?: unknown }).indexVerified).toBe(true);
  });

  it("keeps a failed index check on record across a hand-off, so a later sync retries it", async () => {
    const { harness, index } = await setupIndexed({ "wiki/a.md": "# A\n", "wiki/b.md": "# B\n" });
    await sync(harness);
    const spaceId = [...index.rows.values()][0]!.spaceId;
    // A ledger from before the index existed, over rows the space held before the mirror owned both paths.
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" };
    const stored = harness.getState(stateKey) as Record<string, unknown>;
    await harness.ctx.state.set(stateKey, { ...stored, indexedSpace: undefined, indexVerified: undefined });
    const stale = { spaceId, title: "Previous local title", pageType: "notes", backlinks: [] as string[], hash: "old" };
    index.rows.set(`${spaceId}|wiki/a.md`, { ...stale, path: "wiki/a.md" });
    index.rows.set(`${spaceId}|wiki/b.md`, { ...stale, path: "wiki/b.md" });
    // The first read fails once and takes the whole 1,000 ms budget, so the rest of the check is handed off.
    let now = Date.parse("2026-10-19T06:00:00Z");
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const reads: string[] = [];
    let failed: string | null = null;
    const readText = harness.ctx.localFolders.readText.bind(harness.ctx.localFolders);
    harness.ctx.localFolders.readText = async (companyId, folderKey, relativePath) => {
      reads.push(relativePath);
      if (failed === null) {
        failed = relativePath;
        now += 1_000;
        throw new Error("disk busy");
      }
      now += 10;
      return readText(companyId, folderKey, relativePath);
    };
    const statuses: string[] = [];
    try {
      for (let run = 0; run < 5; run += 1) {
        const result = await syncGitMirror(harness.ctx, COMPANY_ID, { budgetMs: 1_000 });
        statuses.push(result.status);
        if (result.status !== "partial") break;
      }
    } finally {
      dateNow.mockRestore();
      harness.ctx.localFolders.readText = readText;
    }
    const other = failed === "wiki/a.md" ? "wiki/b.md" : "wiki/a.md";

    expect(statuses).toEqual(["partial", "unchanged"]);
    expect([...reads].sort()).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect(index.rows.get(`${spaceId}|${other}`)?.title).not.toBe("Previous local title");
    // The continuation did not read the failed page again, and did not certify its stale row either.
    expect(index.rows.get(`${spaceId}|${failed}`)?.title).toBe("Previous local title");
    expect((harness.getState(stateKey) as { indexVerified?: unknown }).indexVerified).toBe(false);

    expect((await sync(harness)).status).toBe("unchanged");
    expect(index.rows.get(`${spaceId}|${failed}`)?.title).not.toBe("Previous local title");
    expect((harness.getState(stateKey) as { indexVerified?: unknown }).indexVerified).toBe(true);
  });

  it("removes a pre-index ledger's rows from its old space when the source changes", async () => {
    const { harness, index } = await setupIndexed(INDEXED_HANDBOOK);
    await sync(harness);
    const defaultSpaceId = [...index.rows.values()][0]!.spaceId;
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" };
    const stored = harness.getState(stateKey) as Record<string, unknown>;
    await harness.ctx.state.set(stateKey, { ...stored, indexedSpace: undefined, indexVerified: undefined });
    harness.setConfig(mirrorConfig({ spaceSlug: "handbook" }));

    await sync(harness);

    expect(index.paths(defaultSpaceId)).toEqual([]);
  });

  it("keeps a pre-index ledger's files when its old space cannot be looked up, and cleans up on the next sync", async () => {
    const { harness, index } = await setupIndexed(INDEXED_HANDBOOK);
    await sync(harness);
    const defaultSpaceId = [...index.rows.values()][0]!.spaceId;
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" };
    const stored = harness.getState(stateKey) as Record<string, unknown>;
    await harness.ctx.state.set(stateKey, { ...stored, indexedSpace: undefined, indexVerified: undefined });
    harness.setConfig(mirrorConfig({ spaceSlug: "handbook" }));
    const query = harness.ctx.db.query.bind(harness.ctx.db);
    let failOnce = true;
    harness.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      if (failOnce && sql.includes("wiki_spaces") && sql.includes("slug = 'default'")) {
        failOnce = false;
        throw new Error("database unavailable");
      }
      return query(sql, params);
    }) as typeof harness.ctx.db.query;

    await expect(sync(harness)).rejects.toThrow("database unavailable");
    expect(await read(harness, "wiki/projects/v3/index.md")).toBe("# v3\n");
    expect(index.paths(defaultSpaceId)).not.toEqual([]);

    await sync(harness);
    expect(index.paths(defaultSpaceId)).toEqual([]);
  });

  it("finds a pre-index ledger's old space even when it is archived", async () => {
    const { harness, index } = await setupIndexed(INDEXED_HANDBOOK, mirrorConfig({ spaceSlug: "handbook" }));
    await sync(harness);
    const handbookSpaceId = [...index.rows.values()][0]!.spaceId;
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "llm-wiki", stateKey: "git-mirror" };
    const stored = harness.getState(stateKey) as Record<string, unknown>;
    await harness.ctx.state.set(stateKey, { ...stored, indexedSpace: undefined, indexVerified: undefined });
    // The archived space answers only a lookup that does not filter out archived spaces.
    const query = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("wiki_spaces") && params?.[2] === "handbook" && !sql.includes("archived")) return [{ id: handbookSpaceId }];
      return query(sql, params);
    }) as typeof harness.ctx.db.query;
    harness.setConfig(mirrorConfig({ spaceSlug: "default" }));

    await sync(harness);

    expect(index.paths(handbookSpaceId)).toEqual([]);
  });

  it("removes the old copy's rows when the source changes", async () => {
    const { harness, index } = await setupIndexed(INDEXED_HANDBOOK);
    await sync(harness);
    const defaultSpaceId = [...index.rows.values()][0]!.spaceId;
    harness.setConfig(mirrorConfig({ spaceSlug: "handbook" }));

    await sync(harness);

    expect(index.paths(defaultSpaceId)).toEqual([]);
    expect(index.paths()).toContain("wiki/projects/v3/how-it-works.md");
  });
});

describe("Mirrored page links", () => {
  it("takes the title from the first heading outside closed fenced code; an unclosed fence hides nothing", async () => {
    const { harness, index } = await setupIndexed({
      "wiki/concepts/tilde.md": "~~~md\n# Fake\n~~~\n# Real tilde\n",
      "wiki/concepts/longer.md": "````\n```\n# Fake\n````\n# Real longer\n",
      "wiki/concepts/info.md": "``` not`a fence\n# Real info\n```\n",
      "wiki/concepts/unclosed.md": "```\n# Shown, the fence never closes\n\n[[projects/after]]\n",
      "wiki/concepts/list.md": "- ~~~md\n  [[projects/in-list]]\n  ~~~\n\n# Real list\n[[projects/real]]\n",
    });

    await sync(harness);

    const rows = new Map([...index.rows.values()].map((row) => [row.path, row]));
    expect(rows.get("wiki/concepts/tilde.md")?.title).toBe("Real tilde");
    expect(rows.get("wiki/concepts/longer.md")?.title).toBe("Real longer");
    expect(rows.get("wiki/concepts/info.md")?.title).toBe("Real info");
    expect(rows.get("wiki/concepts/unclosed.md")?.title).toBe("Shown, the fence never closes");
    expect(rows.get("wiki/concepts/unclosed.md")?.backlinks).toEqual(["wiki/projects/after.md"]);
    expect(rows.get("wiki/concepts/list.md")?.title).toBe("Real list");
    expect(rows.get("wiki/concepts/list.md")?.backlinks).toEqual(["wiki/projects/in-list.md", "wiki/projects/real.md"]);
  });

  it("takes the title from the first level-one heading line with text", async () => {
    const { harness, index } = await setupIndexed({
      "wiki/concepts/bare.md": "#\nordinary prose\n# Real bare\n",
      "wiki/concepts/empty.md": "# #\n# Real empty\n",
      "wiki/concepts/closing.md": "# Real closing ##\n",
      "wiki/concepts/sharp.md": "# C# notes\n",
      "wiki/concepts/none.md": "no heading here\n",
      "wiki/concepts/nbsp.md": "# \u00a0First title\n# Second title\n",
      "wiki/concepts/tab.md": "#\tTabbed title\n",
    });

    await sync(harness);

    const titles = Object.fromEntries([...index.rows.values()].map((row) => [row.path, row.title]));
    expect(titles).toMatchObject({
      "wiki/concepts/bare.md": "Real bare",
      "wiki/concepts/empty.md": "Real empty",
      "wiki/concepts/closing.md": "Real closing",
      "wiki/concepts/sharp.md": "C# notes",
      "wiki/concepts/none.md": "none",
      "wiki/concepts/nbsp.md": "First title",
      "wiki/concepts/tab.md": "Tabbed title",
    });
  });

  it("indexes no path the page tools would read differently, so no row outlives its file", async () => {
    const { harness, github, index } = await setupIndexed({ ...HANDBOOK, " wiki/spaced.md": "# Spaced\n" });

    const first = await sync(harness);
    // The read tools would read " wiki/spaced.md" as "wiki/spaced.md", so it moves under wiki/, to a path
    // they read exactly as written; file and row share it.
    expect(first.written).toContain("wiki/ wiki/spaced.md");
    expect(await read(harness, "wiki/ wiki/spaced.md")).toBe("# Spaced\n");
    expect(index.paths().filter((path) => path.includes("spaced"))).toEqual(["wiki/ wiki/spaced.md"]);
    github.files = { ...HANDBOOK };
    github.commit = "c2".padEnd(40, "0");

    const second = await sync(harness);

    expect(second.deleted).toEqual(["wiki/ wiki/spaced.md"]);
    expect(index.paths()).toEqual(["AGENTS.md", "IDEA.md", "wiki/index.md", "wiki/log.md", "wiki/projects/v3/index.md"]);
  });

  it("reads Windows line endings, empty frontmatter and URLs in any case like the plain forms", async () => {
    const { harness, index } = await setupIndexed({
      "wiki/concepts/crlf.md": "# #\r\n# Real crlf ##\r\n[[projects/crlf]]\r\n",
      "wiki/concepts/empty-frontmatter.md": "---\n---\n\n# First real title\n[[projects/real]]\n\n---\n\n# Later title\n",
      "wiki/concepts/url.md": "# Url\n[elsewhere](HTTPS://example.com/wiki/external.md) [[projects/kept]]\n",
    });

    await sync(harness);

    const rows = new Map([...index.rows.values()].map((row) => [row.path, row]));
    expect(rows.get("wiki/concepts/crlf.md")).toMatchObject({ title: "Real crlf", backlinks: ["wiki/projects/crlf.md"] });
    expect(rows.get("wiki/concepts/empty-frontmatter.md")).toMatchObject({ title: "First real title", backlinks: ["wiki/projects/real.md"] });
    expect(rows.get("wiki/concepts/url.md")?.backlinks).toEqual(["wiki/projects/kept.md"]);
  });

  it("keeps a link whose label is a URL and drops wiki paths inside any URL", async () => {
    const { extractMirroredPageLinks } = await import("../src/wiki/core.js");
    expect(extractMirroredPageLinks([
      "[https://example.com](AGENTS.md) [label](<IDEA.md> \"Title\") [titled](index.md \"A title\") [a [bracketed] label](log.md)",
      "https://example.com/foo(bar)/wiki/external.md and HTTP://Example.com/wiki/upper.md, then wiki/bare.md",
    ].join("\n"))).toEqual(["AGENTS.md", "IDEA.md", "index.md", "log.md", "wiki/bare.md"]);
  });

  it("resolves every wikilink from the wiki folder and keeps any page name a destination can carry", async () => {
    const { extractMirroredPageLinks } = await import("../src/wiki/core.js");
    expect(extractMirroredPageLinks([
      "[[index]] [[log|the log]] [x](wiki/café.md) [y](<wiki/with spaces.md>) [z](<AGENTS.md#section)one>)",
    ].join("\n"))).toEqual(["AGENTS.md", "wiki/café.md", "wiki/index.md", "wiki/log.md", "wiki/with spaces.md"]);
  });

  it("reads links whose destination or title starts on the next line, with parentheses, and in any script", async () => {
    const { extractMirroredPageLinks } = await import("../src/wiki/core.js");
    expect(extractMirroredPageLinks([
      "[Agent setup](AGENTS.md",
      "  \"Agent instructions\")",
      "[Index](",
      "  index.md)",
      "[Version](wiki/releases/v(2).md) and the bare wiki/café.md, but not xwiki/no.md",
    ].join("\n"))).toEqual(["AGENTS.md", "index.md", "wiki/café.md", "wiki/releases/v(2).md"]);
  });

  it("drops wiki paths inside an emphasized URL and closing hashes before odd whitespace", async () => {
    const { extractMirroredPageLinks } = await import("../src/wiki/core.js");
    expect(extractMirroredPageLinks("_https://github.com/other/repo/blob/main/wiki/setup.md#install_ and *HTTPS://x.org/wiki/b.md* but wiki/local.md\n"))
      .toEqual(["wiki/local.md"]);
    const { harness, index } = await setupIndexed({ "wiki/concepts/hashes.md": "# Handbook ##\u00a0\n" });

    await sync(harness);

    expect([...index.rows.values()].find((row) => row.path === "wiki/concepts/hashes.md")?.title).toBe("Handbook");
  });

  it("closes a fence only at a line of fence characters and spaces or tabs", async () => {
    const { harness, index } = await setupIndexed({ "wiki/concepts/nbsp-fence.md": "~~~sh\n# Kept\n~~~\u00a0\n# Later\n" });

    await sync(harness);

    expect([...index.rows.values()].find((row) => row.path === "wiki/concepts/nbsp-fence.md")?.title).toBe("Kept");
  });

  it("reads links from the body, not the frontmatter", async () => {
    const { extractMirroredPageLinks } = await import("../src/wiki/core.js");
    expect(extractMirroredPageLinks("---\nrelated: \"[[projects/in-frontmatter]]\"\n---\n\n[[projects/in-body]]\n")).toEqual(["wiki/projects/in-body.md"]);
  });

  it("keeps every link inside the wiki tree, whatever form names it", async () => {
    const { extractMirroredPageLinks } = await import("../src/wiki/core.js");
    expect(extractMirroredPageLinks([
      "[[wiki/../../escape.md]] [escape](wiki/../../escape.md) wiki/./dot.md [[wiki//double]] [[projects/ok]]",
    ].join("\n"))).toEqual(["wiki/projects/ok.md"]);
  });

  it("resolves wikilinks from the wiki root, skips malformed targets and URLs, and reads code as text", async () => {
    const { extractMirroredPageLinks } = await import("../src/wiki/core.js");
    expect(extractMirroredPageLinks([
      "[[sources/steering-2026-09]] [[wiki/concepts/a.md]] [[IDEA]] [[projects/x#rules|rules]]",
      "[[capabilities/<slug>]] [[../escape]] [[/abs]] [[a//b]] `[[inline/code]]`",
      "[markdown](wiki/concepts/b.md) [elsewhere](https://example.com/wiki/c.md)",
    ].join("\n"))).toEqual([
      "wiki/IDEA.md",
      "wiki/capabilities/<slug>.md",
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
      "wiki/inline/code.md",
      "wiki/projects/x.md",
      "wiki/sources/steering-2026-09.md",
    ]);
  });
});
