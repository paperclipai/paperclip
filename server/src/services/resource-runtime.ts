import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { resources } from "@paperclipai/db";
import type { Resource, ResourceManifestAttachment, ResourceOutputResult, ResourceRunOverride, ResourceVersionReference, WorkflowResourceManifest } from "@paperclipai/shared";
import { resourceRunOverridesSchema, workflowResourceManifestSchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

const execFile = promisify(execFileCallback);
const GIT_COMMAND_TIMEOUT_MS = 120_000;

type GitCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  redact?: string[];
  timeoutMs?: number;
};

async function runGit(args: string[], options: GitCommandOptions = {}) {
  try {
    const result = await execFile("git", args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return result.stdout.trim();
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    const redacted = (stderr.trim() || message).replaceAll(/\S+/g, (part) =>
      options.redact?.includes(part) ? "[REDACTED]" : part,
    );
    throw unprocessable(`Git command failed: ${redacted}`);
  }
}

function normalizeRef(ref: string | undefined, fallback: string) {
  const requested = (ref?.trim() || "latest");
  if (requested === "latest") return fallback;
  if (requested.startsWith("branch:")) return requested.slice("branch:".length).trim();
  if (requested.startsWith("tag:")) return requested.slice("tag:".length).trim();
  if (requested.startsWith("commit:")) return requested.slice("commit:".length).trim();
  return requested;
}

function normalizePublishRef(ref: string | undefined, fallback: string) {
  const requested = ref?.trim() || fallback;
  if (requested.startsWith("tag:") || requested.startsWith("commit:") || isCommit(requested)) {
    throw unprocessable(`Resource output must publish to a branch: ${requested}`);
  }
  return requested.startsWith("branch:") ? requested.slice("branch:".length).trim() : requested;
}

function validateBranch(branch: string) {
  if (!branch || branch.startsWith("-") || branch.includes("..") || /[\s~^:?*\\\[\]]/.test(branch)) {
    throw unprocessable("Invalid Git output branch");
  }
  return branch;
}

function generatedBranch(runId: string, resourceKey: string) {
  return validateBranch(`bizbox/run-${runId.slice(0, 12)}-${resourceKey}`);
}

function parseDiffStat(value: string) {
  let insertions = 0;
  let deletions = 0;
  for (const line of value.split("\n")) {
    const [added, removed] = line.split("\t");
    if (added && /^\d+$/.test(added)) insertions += Number(added);
    if (removed && /^\d+$/.test(removed)) deletions += Number(removed);
  }
  return { insertions, deletions };
}

function isCommit(ref: string) {
  return /^[0-9a-f]{7,64}$/i.test(ref);
}

function resolveMountPath(workspaceRoot: string, mountPath: string) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(resolvedRoot, mountPath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw unprocessable(`Resource mount path escapes workspace: ${mountPath}`);
  }
  return resolvedPath;
}

async function credentialContext(db: Db, resource: Resource): Promise<{ env: NodeJS.ProcessEnv; token: string | null }> {
  if (!resource.credentialRef) return { env: process.env, token: null };
  validateCredentialRepository(resource.repository);
  const token = await secretService(db).resolveSecretValue(resource.companyId, resource.credentialRef, "latest");
  const value = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${value}`,
    }, token };
}

async function resolveRemoteRef(resource: Resource, requestedRef: string, env: NodeJS.ProcessEnv) {
  if (isCommit(requestedRef)) {
    return requestedRef;
  }

  const candidates = [
    `refs/heads/${requestedRef}`,
    `refs/tags/${requestedRef}`,
    requestedRef,
  ];
  for (const candidate of candidates) {
    try {
      const output = await runGit(["ls-remote", "--refs", resource.repository, candidate], { env });
      const commit = output.split(/\s+/)[0];
      if (commit) return commit;
    } catch {
      // Try next ref form. Final failure below is the user-facing error.
    }
  }
  throw notFound(`Git ref not found: ${requestedRef}`);
}

async function assertPublishBranchAvailable(resource: Resource, branch: string, env: NodeJS.ProcessEnv) {
  if (resource.repository.startsWith("/") || resource.repository.startsWith(".")) {
    const output = await runGit(["-C", resource.repository, "for-each-ref", `refs/heads/${branch}`, "--format=%(refname)"], { env });
    if (output) throw conflict(`Git output branch already exists: ${branch}`);
    return;
  }
  const output = await runGit(["ls-remote", "--heads", resource.repository, `refs/heads/${branch}`], { env });
  if (output) throw conflict(`Git output branch already exists: ${branch}`);
}

async function resolveLocalRef(resource: Resource, requestedRef: string) {
  const env = process.env;
  const candidate = requestedRef === "HEAD" ? "HEAD" : requestedRef;
  try {
    return await runGit(["-C", resource.repository, "rev-parse", `${candidate}^{commit}`], { env });
  } catch {
    throw notFound(`Git ref not found: ${requestedRef}`);
  }
}

async function copyResourceTree(sourcePath: string, destinationPath: string) {
  await fs.rm(destinationPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.cp(sourcePath, destinationPath, { recursive: true });
}

async function copyWorkingTreeContents(sourcePath: string, destinationPath: string) {
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    await fs.cp(path.join(sourcePath, entry.name), path.join(destinationPath, entry.name), { recursive: true, force: true });
  }
}

async function clearWorkingTreeContents(destinationPath: string) {
  const entries = await fs.readdir(destinationPath, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.name !== ".git")
    .map((entry) => fs.rm(path.join(destinationPath, entry.name), { recursive: true, force: true })));
}

function resourceEnvKey(resourceKey: string) {
  return `BIZBOX_RESOURCE_${resourceKey.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_PATH`;
}

export function validateCredentialRepository(repository: string) {
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw unprocessable("Credential-backed Resources require an HTTPS Git repository");
  }
  if (url.protocol !== "https:") {
    throw unprocessable("Credential-backed Resources require an HTTPS Git repository");
  }
  const allowedHosts = (process.env.BIZBOX_GIT_CREDENTIAL_HOSTS ?? "github.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw unprocessable(`Credential-backed Git host is not allowed: ${url.hostname}`);
  }
}

type PreparedResource = {
  resource: Resource;
  attachment: ResourceManifestAttachment;
  mountPath: string;
  repoPath: string;
  expectedCommit: string;
  outputBaselineCommit: string | null;
  resolvedRef: string;
};

export interface PreparedResourceRun {
  environment: Record<string, string>;
  inputVersions: ResourceVersionReference[];
  publish: () => Promise<ResourceOutputResult[]>;
}

export type PullRequestProvider = {
  create: (input: {
    repository: string;
    token: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<{ id: string; url: string }>;
};

function githubRepository(repository: string) {
  const match = repository.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw unprocessable("Pull requests are supported only for GitHub Resources");
  return { owner: match[1], repo: match[2] };
}

export function githubPullRequestProvider(fetchImpl: typeof fetch = fetch): PullRequestProvider {
  return {
    create: async ({ repository, token, head, base, title, body }) => {
      const { owner, repo } = githubRepository(repository);
      let response: Response;
      try {
        response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify({ title, body, head, base }),
        });
      } catch {
        throw unprocessable("GitHub pull request creation failed");
      }
      if (!response.ok) throw unprocessable("GitHub pull request creation failed");
      const data = await response.json() as { number?: number; html_url?: string };
      if (typeof data.number !== "number" || typeof data.html_url !== "string") {
        throw unprocessable("GitHub pull request response was invalid");
      }
      return { id: String(data.number), url: data.html_url };
    },
  };
}

function rowToResource(row: typeof resources.$inferSelect): Resource {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    type: row.type as Resource["type"],
    repository: row.repository,
    sourcePath: row.sourcePath ?? null,
    defaultRef: row.defaultRef,
    mountPath: row.mountPath,
    credentialRef: row.credentialRef ?? null,
    labels: row.labels && typeof row.labels === "object" && !Array.isArray(row.labels) ? row.labels as Record<string, string> : {},
    status: row.status as Resource["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function resourceRuntimeService(db: Db) {
  return {
    prepare: async (input: {
      companyId: string;
      runId: string;
      workspaceRoot: string;
      manifest: unknown;
      overrides?: ResourceRunOverride[];
      pullRequestProvider?: PullRequestProvider;
    }): Promise<PreparedResourceRun | null> => {
      if (input.manifest === undefined || input.manifest === null) return null;
      const parsed = workflowResourceManifestSchema.safeParse(input.manifest);
      if (!parsed.success) throw unprocessable("Invalid workflow Resource manifest", parsed.error.flatten());
      const manifest = parsed.data as WorkflowResourceManifest;
      if (manifest.resources.length === 0) return null;
      const parsedOverrides = resourceRunOverridesSchema.safeParse(input.overrides ?? []);
      if (!parsedOverrides.success) throw unprocessable("Invalid Resource run overrides", parsedOverrides.error.flatten());
      const manifestIds = new Set(manifest.resources.map((attachment) => attachment.resourceId));
      for (const override of parsedOverrides.data) {
        if (!manifestIds.has(override.resourceId)) throw unprocessable(`Resource override is not declared by workflow: ${override.resourceId}`);
      }
      const overridesById = new Map(parsedOverrides.data.map((override) => [override.resourceId, override]));

      const ids = manifest.resources.map((attachment) => attachment.resourceId);
      const rows = await db.select().from(resources).where(and(eq(resources.companyId, input.companyId), inArray(resources.id, ids)));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const prepared: PreparedResource[] = [];
      const usedMounts = new Set<string>();
      const usedEnvironmentKeys = new Set<string>();
      const resourcesRoot = path.join(input.workspaceRoot, "resources");
      const stagingRoot = path.join(input.workspaceRoot, ".resource-staging");
      const environment: Record<string, string> = {
        BIZBOX_RESOURCE_WORKSPACE_ROOT: path.resolve(resourcesRoot),
      };

      for (const attachment of manifest.resources) {
        const row = byId.get(attachment.resourceId);
        if (!row) throw notFound(`Resource not found in company: ${attachment.resourceId}`);
        if (row.status !== "active") throw unprocessable(`Resource is archived: ${row.key}`);
        if (row.type !== "git") throw unprocessable(`Unsupported Resource Type: ${row.type}`);
        const resource = rowToResource(row);
        if (resource.sourcePath && (path.isAbsolute(resource.sourcePath) || resource.sourcePath.split(/[\\/]/).includes(".."))) {
          throw unprocessable(`Resource source path is unsafe: ${resource.sourcePath}`);
        }
        const mountPath = resolveMountPath(resourcesRoot, resource.mountPath);
        if (usedMounts.has(mountPath)) throw conflict(`Resource mount path is used more than once: ${resource.mountPath}`);
        usedMounts.add(mountPath);
        const environmentKey = resourceEnvKey(resource.key);
        if (usedEnvironmentKeys.has(environmentKey)) {
          throw conflict(`Resource environment key is used more than once: ${environmentKey}`);
        }
        usedEnvironmentKeys.add(environmentKey);

        const credential = await credentialContext(db, resource);
        const env = credential.env;
        const override = overridesById.get(attachment.resourceId);
        const requestedRef = normalizeRef(override?.version ?? attachment.version, resource.defaultRef);
        const expectedCommit = resource.repository.startsWith("/") || resource.repository.startsWith(".")
          ? await resolveLocalRef(resource, requestedRef)
          : await resolveRemoteRef(resource, requestedRef, env);
        const output = attachment.output ?? { action: "none" as const };
        const outputBranch = output.action === "pull_request"
          ? validateBranch(output.branch ?? generatedBranch(input.runId, resource.key))
          : null;
        const outputBaselineCommit = attachment.mode !== "input" && output.action !== "none"
          ? (resource.repository.startsWith("/") || resource.repository.startsWith(".")
            ? await resolveLocalRef(resource, normalizePublishRef(output.targetRef, resource.defaultRef))
            : await resolveRemoteRef(resource, normalizePublishRef(output.targetRef, resource.defaultRef), env))
          : null;
        if (outputBranch) await assertPublishBranchAvailable(resource, outputBranch, env);
        // Full Git Resources are cloned directly into their mount. A
        // source_path needs a hidden staging checkout so only that subtree is
        // exposed at the mount; the staging directory remains inside this run
        // temp root and is removed with it.
        const repoPath = resource.sourcePath
          ? path.join(stagingRoot, resource.key, "repo")
          : mountPath;
        await fs.mkdir(path.dirname(repoPath), { recursive: true });
        await fs.mkdir(path.dirname(mountPath), { recursive: true });
        await runGit(["clone", "--no-checkout", resource.repository, repoPath], { env });
        await runGit(["checkout", "--detach", expectedCommit], { cwd: repoPath, env });
        const sourcePath = resource.sourcePath ? path.join(repoPath, resource.sourcePath) : repoPath;
        try {
          await fs.access(sourcePath);
        } catch {
          throw notFound(`Resource source path not found: ${resource.sourcePath ?? "."}`);
        }
        if (resource.sourcePath) {
          await copyResourceTree(sourcePath, mountPath);
        }
        environment[environmentKey] = mountPath;
        prepared.push({
          resource,
          attachment,
          mountPath,
          repoPath,
          expectedCommit,
          outputBaselineCommit,
          resolvedRef: requestedRef,
        });
      }

      const inputVersions = prepared.map((item) => ({
        resourceId: item.resource.id,
        resourceKey: item.resource.key,
        requestedRef: overridesById.get(item.resource.id)?.version ?? item.attachment.version ?? "latest",
        resolvedRef: item.resolvedRef,
        commit: item.expectedCommit,
        mountPath: item.resource.mountPath,
        published: false,
      }));

      return {
        environment,
        inputVersions,
        publish: async () => {
          const results: ResourceOutputResult[] = [];
          try {
            for (const item of prepared) {
            const output = item.attachment.output ?? { action: "none" as const };
            if (item.attachment.mode === "input" || output.action === "none") {
              results.push({
                resourceId: item.resource.id,
                inputCommit: item.expectedCommit,
                action: output.action,
                status: "discarded",
              });
              continue;
            }
            const targetRef = normalizePublishRef(output.targetRef, item.resource.defaultRef);
            const credential = await credentialContext(db, item.resource);
            const env = credential.env;
            const currentCommit = item.resource.repository.startsWith("/") || item.resource.repository.startsWith(".")
              ? await resolveLocalRef(item.resource, targetRef)
              : await resolveRemoteRef(item.resource, targetRef, env);
            if (currentCommit !== item.outputBaselineCommit) {
              throw conflict(`Resource changed while workflow was running: ${item.resource.key}`);
            }
            const rebasingOutput = item.outputBaselineCommit !== item.expectedCommit;
            const outputSnapshotPath = rebasingOutput
              ? path.join(path.dirname(item.repoPath), "output-working-tree")
              : null;
            if (outputSnapshotPath) {
              await fs.rm(outputSnapshotPath, { recursive: true, force: true });
              await fs.mkdir(outputSnapshotPath, { recursive: true });
              await copyWorkingTreeContents(item.repoPath, outputSnapshotPath);
              await runGit(["reset", "--hard", item.outputBaselineCommit!], { cwd: item.repoPath, env });
              await runGit(["clean", "-fd"], { cwd: item.repoPath, env });
              if (item.resource.sourcePath) {
                await copyResourceTree(outputSnapshotPath, path.join(item.repoPath, item.resource.sourcePath));
              } else {
                await clearWorkingTreeContents(item.repoPath);
                await copyWorkingTreeContents(outputSnapshotPath, item.repoPath);
              }
            }
            if (item.resource.sourcePath) {
              await copyResourceTree(item.mountPath, path.join(item.repoPath, item.resource.sourcePath));
            }
            const status = await runGit(["status", "--porcelain"], { cwd: item.repoPath, env });
            if (!status) {
              results.push({ resourceId: item.resource.id, inputCommit: item.expectedCommit, action: output.action, status: "no_changes" });
              continue;
            }
            await runGit(["add", "-A"], { cwd: item.repoPath, env });
            const diffStat = await runGit(["diff", "--cached", "--numstat"], { cwd: item.repoPath, env });
            const changedFiles = (await runGit(["diff", "--cached", "--name-only"], { cwd: item.repoPath, env })).split("\n").filter(Boolean);
            const { insertions, deletions } = parseDiffStat(diffStat);
            const branch = output.action === "pull_request"
              ? validateBranch(output.branch ?? generatedBranch(input.runId, item.resource.key))
              : undefined;
            if (branch) await runGit(["switch", "-c", branch], { cwd: item.repoPath, env, redact: credential.token ? [credential.token] : [] });
            const title = output.title?.trim() || `Update ${item.resource.key}`;
            await runGit(["-c", "user.name=Bizbox", "-c", "user.email=bizbox@localhost", "commit", "-m", title], { cwd: item.repoPath, env, redact: credential.token ? [credential.token] : [] });
            const commit = await runGit(["rev-parse", "HEAD"], { cwd: item.repoPath, env });
            const pushRef = branch ?? targetRef;
            await runGit(["push", "origin", `HEAD:refs/heads/${pushRef}`], { cwd: item.repoPath, env, redact: credential.token ? [credential.token] : [] });
            if (output.action === "push") {
              results.push({ resourceId: item.resource.id, inputCommit: item.expectedCommit, outputCommit: commit, action: output.action, branch: pushRef, targetRef, changedFiles, insertions, deletions, status: "pushed" });
              continue;
            }
            if (!credential.token) throw unprocessable("Pull request output requires a Resource credential");
            const provider = input.pullRequestProvider ?? githubPullRequestProvider();
            const pullRequest = await provider.create({
              repository: item.resource.repository,
              token: credential.token,
              head: pushRef,
              base: targetRef,
              title,
              body: output.body?.trim() ?? "",
            });
            results.push({ resourceId: item.resource.id, inputCommit: item.expectedCommit, outputCommit: commit, action: output.action, branch: pushRef, targetRef, pullRequestId: pullRequest.id, pullRequestUrl: pullRequest.url, changedFiles, insertions, deletions, status: "pull_request_created" });
            }
          } catch (error) {
            if (error && typeof error === "object") {
              Object.assign(error, { resourceOutputs: results });
            }
            throw error;
          }
          for (const version of inputVersions) {
            const result = results.find((item) => item.resourceId === version.resourceId);
            version.published = result?.status === "pushed" || result?.status === "pull_request_created";
          }
          return results;
        },
      };
    },
  };
}
