import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstancePath, resolveStateRepoPath } from "@paperclipai/shared";

async function run(file: string, args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(result.stderr || `${file} exited ${code}`), result));
    });
    child.stdin.end(options.input);
  });
}
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
] as const;

export type StateRepoActor = { name: string; email: string };
export type StateRepoMemorySource = { agentId: string; root: string };
type Entry = { oid: string; mode: string };

async function git(repo: string, args: string[], input?: string | Buffer) {
  return run("git", ["--git-dir", repo, ...args], {
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function walk(root: string): Promise<Array<[string, Buffer]>> {
  const files: Array<[string, Buffer]> = [];
  async function visit(current: string, prefix = "") {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push([relative, await fs.readFile(absolute)]);
    }
  }
  await visit(root);
  return files;
}

function scan(files: Map<string, Buffer>, knownSecrets: string[]) {
  for (const [filePath, content] of files) {
    const text = content.toString("utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) throw new Error(`State repo secret scan blocked ${filePath}`);
    }
    for (const secret of knownSecrets) {
      if (secret.length >= 8 && text.includes(secret)) {
        const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 12);
        throw new Error(`State repo secret scan blocked ${filePath} (known-secret:${fingerprint})`);
      }
    }
  }
}

async function writeTree(repo: string, entries: Map<string, Entry>) {
  type Node = { files: Map<string, Entry>; dirs: Map<string, Node> };
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [filePath, entry] of entries) {
    const parts = filePath.split("/");
    const name = parts.pop()!;
    let node = root;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) { child = { files: new Map(), dirs: new Map() }; node.dirs.set(part, child); }
      node = child;
    }
    node.files.set(name, entry);
  }
  async function persist(node: Node): Promise<string> {
    const rows: string[] = [];
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push(`040000 tree ${await persist(child)}\t${name}\n`);
    }
    for (const [name, entry] of [...node.files].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push(`${entry.mode} blob ${entry.oid}\t${name}\n`);
    }
    return (await git(repo, ["mktree"], rows.join(""))).stdout.trim();
  }
  return persist(root);
}

export function createStateRepoService(options: {
  homeDir?: string;
  instanceId?: string;
  repoPerCompany?: boolean;
  markerDir: string;
  resolveMirror?: (companyId: string) => Promise<{ url: string; token?: string } | null>;
  resolveMemorySources?: (companyId: string) => Promise<StateRepoMemorySource[]>;
  knownSecrets?: () => Promise<string[]>;
}) {
  let queue = Promise.resolve();
  let mirrorQueue = Promise.resolve();
  const repoPathFor = (companyId: string) => resolveStateRepoPath({
    homeDir: options.homeDir,
    instanceId: options.instanceId,
    companyId: options.repoPerCompany ? companyId : undefined,
  });
  async function ensureRepo(repo: string) {
    try { await fs.access(path.join(repo, "HEAD")); } catch {
      await fs.mkdir(path.dirname(repo), { recursive: true });
      await run("git", ["init", "--bare", "--initial-branch=main", repo]);
    }
  }
  async function collect(companyId: string) {
    const files = new Map<string, Buffer>();
    const instance = resolvePaperclipInstancePath({ homeDir: options.homeDir, instanceId: options.instanceId });
    const agentsRoot = path.join(instance, "companies", companyId, "agents");
    let agents: string[] = [];
    try { agents = await fs.readdir(agentsRoot); } catch { /* absent */ }
    for (const agentId of agents) {
      for (const [relative, content] of await walk(path.join(agentsRoot, agentId, "instructions"))) {
        files.set(`companies/${companyId}/agents/${agentId}/${relative}`, content);
      }
    }
    for (const [relative, content] of await walk(path.join(instance, "skills", companyId))) {
      files.set(`companies/${companyId}/skills/${relative}`, content);
    }
    for (const source of await options.resolveMemorySources?.(companyId) ?? []) {
      for (const [relative, content] of await walk(source.root)) {
        if (relative.endsWith(".md")) {
          files.set(`companies/${companyId}/agents/${source.agentId}/memory/${relative}`, content);
        }
      }
    }
    return files;
  }
  async function commitNow(input: { companyId: string; actor: StateRepoActor; message: string }) {
    const repo = repoPathFor(input.companyId);
    await ensureRepo(repo);
    const files = await collect(input.companyId);
    scan(files, await options.knownSecrets?.() ?? []);
    const entries = new Map<string, Entry>();
    try {
      for (const line of (await git(repo, ["ls-tree", "-r", "main"])).stdout.trim().split("\n")) {
        const match = line.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/);
        if (match) entries.set(match[3]!, { mode: match[1]!, oid: match[2]! });
      }
    } catch { /* first commit */ }
    const prefix = `companies/${input.companyId}/`;
    for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
    for (const [filePath, content] of files) {
      entries.set(filePath, { mode: "100644", oid: (await git(repo, ["hash-object", "-w", "--stdin"], content)).stdout.trim() });
    }
    const tree = await writeTree(repo, entries);
    let parent: string | null = null;
    try { parent = (await git(repo, ["rev-parse", "main"])).stdout.trim(); } catch { /* first */ }
    if (parent && (await git(repo, ["show", "-s", "--format=%T", parent])).stdout.trim() === tree) return parent;
    const { stdout } = await run("git", ["--git-dir", repo, "commit-tree", tree, ...(parent ? ["-p", parent] : [])], {
      input: `${input.message}\n`,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: input.actor.name,
        GIT_AUTHOR_EMAIL: input.actor.email,
        GIT_COMMITTER_NAME: "paperclip-state-bot",
        GIT_COMMITTER_EMAIL: "state-bot@paperclip.invalid",
      },
    });
    const commit = stdout.trim();
    await git(repo, ["update-ref", "refs/heads/main", commit, ...(parent ? [parent] : [])]);
    mirrorQueue = mirrorQueue.then(async () => { await pushMirror(input.companyId); }).catch(() => undefined);
    return commit;
  }
  async function pushMirror(companyId: string) {
    const mirror = await options.resolveMirror?.(companyId);
    if (!mirror) return false;
    const repo = repoPathFor(companyId);
    try {
      const args = ["--git-dir", repo];
      if (mirror.token) args.push("-c", `http.extraHeader=Authorization: Bearer ${mirror.token}`);
      args.push("push", mirror.url, "refs/heads/main:refs/heads/main");
      await run("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      await fs.mkdir(options.markerDir, { recursive: true });
      await fs.writeFile(path.join(options.markerDir, `state-repo-${companyId}.success.json`), JSON.stringify({ pushedAt: new Date().toISOString() }));
      await fs.rm(path.join(options.markerDir, `state-repo-${companyId}.failure`), { force: true });
      return true;
    } catch (error) {
      await fs.mkdir(options.markerDir, { recursive: true });
      await fs.writeFile(path.join(options.markerDir, `state-repo-${companyId}.failure`), error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  return {
    repoPathFor,
    commit(input: { companyId: string; actor: StateRepoActor; message: string }) {
      const result = queue.then(() => commitNow(input));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    async testMirror(companyId: string) {
      await mirrorQueue;
      if (!await pushMirror(companyId)) throw new Error("State repo mirror is not configured");
    },
    async health(companyId: string) {
      const successPath = path.join(options.markerDir, `state-repo-${companyId}.success.json`);
      const failurePath = path.join(options.markerDir, `state-repo-${companyId}.failure`);
      const success = await fs.readFile(successPath, "utf8").then(JSON.parse).catch(() => null);
      const failure = await fs.readFile(failurePath, "utf8").catch(() => null);
      return { configured: Boolean(await options.resolveMirror?.(companyId)), healthy: !failure, success, failure };
    },
    async exportBundle(companyId: string, outputPath: string) {
      const repo = repoPathFor(companyId);
      await ensureRepo(repo);
      await git(repo, ["bundle", "create", outputPath, "--all"]);
    },
    async restore(companyId: string, source: string, ref = "main", dryRun = false) {
      const instance = resolvePaperclipInstancePath({ homeDir: options.homeDir, instanceId: options.instanceId });
      const companyRoot = path.join(instance, "companies", companyId);
      let gitDir = source;
      let temporaryRepo: string | null = null;
      try {
        await fs.access(path.join(source, "HEAD"));
      } catch {
        await fs.mkdir(options.markerDir, { recursive: true });
        temporaryRepo = await fs.mkdtemp(path.join(options.markerDir, "state-restore-"));
        await run("git", ["init", "--bare", temporaryRepo]);
        await run("git", ["--git-dir", temporaryRepo, "fetch", source, `${ref}:${ref}`]);
        gitDir = temporaryRepo;
      }
      try {
        const { stdout } = await run("git", ["--git-dir", gitDir, "ls-tree", "-r", ref, `companies/${companyId}`]);
        const restored: string[] = [];
        const memorySources = new Map((await options.resolveMemorySources?.(companyId) ?? []).map((source) => [source.agentId, source.root]));
        for (const line of stdout.trim().split("\n").filter(Boolean)) {
          const match = line.match(/^\d+ blob ([0-9a-f]+)\tcompanies\/[^/]+\/(agents\/([^/]+)\/(.+)|skills\/(.+))$/);
          if (!match) continue;
          const relative = match[2]!;
          restored.push(relative);
          if (dryRun) continue;
          const agentId = match[3];
          const agentRelative = match[4];
          const memoryRelative = agentRelative?.startsWith("memory/") ? agentRelative.slice("memory/".length) : null;
          const memoryRoot = agentId && memoryRelative ? memorySources.get(agentId) : null;
          const destination = agentId && agentRelative
            ? memoryRoot
              ? path.join(memoryRoot, memoryRelative!)
              : path.join(companyRoot, "agents", agentId, "instructions", agentRelative)
            : path.join(instance, "skills", companyId, match[5]!);
          const content = (await run("git", ["--git-dir", gitDir, "cat-file", "blob", match[1]!])).stdout;
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, content);
        }
        return { restored, dryRun };
      } finally {
        if (temporaryRepo) await fs.rm(temporaryRepo, { recursive: true, force: true });
      }
    },
    startWatcher(input: { listCompanyIds: () => Promise<string[]>; debounceMs?: number; sweepMs?: number }) {
      const debounceMs = input.debounceMs ?? 30_000;
      const sweepMs = input.sweepMs ?? 24 * 60 * 60 * 1_000;
      const pending = new Map<string, NodeJS.Timeout>();
      const fingerprints = new Map<string, string>();
      let stopped = false;
      const sweep = async (message: string) => {
        for (const companyId of await input.listCompanyIds()) {
          await this.commit({
            companyId,
            actor: { name: "paperclip-state-bot", email: "state-bot@paperclip.invalid" },
            message,
          }).catch(() => undefined);
        }
      };
      const poll = async () => {
        if (stopped) return;
        for (const companyId of await input.listCompanyIds()) {
          const files = await collect(companyId);
          const memory = [...files].filter(([filePath]) => filePath.includes("/memory/"));
          const fingerprint = createHash("sha256")
            .update(memory.map(([filePath, content]) => `${filePath}\0${createHash("sha256").update(content).digest("hex")}`).join("\n"))
            .digest("hex");
          const previous = fingerprints.get(companyId);
          fingerprints.set(companyId, fingerprint);
          if (previous && previous !== fingerprint) {
            clearTimeout(pending.get(companyId));
            pending.set(companyId, setTimeout(() => {
              pending.delete(companyId);
              void this.commit({
                companyId,
                actor: { name: "paperclip-state-bot", email: "state-bot@paperclip.invalid" },
                message: "claude-memory: capture external changes",
              });
            }, debounceMs));
          }
        }
      };
      const pollTimer = setInterval(() => void poll(), Math.min(5_000, debounceMs));
      const sweepTimer = setInterval(() => void sweep("state: daily drift sweep"), sweepMs);
      void poll();
      return () => {
        stopped = true;
        clearInterval(pollTimer);
        clearInterval(sweepTimer);
        for (const timer of pending.values()) clearTimeout(timer);
      };
    },
  };
}

export type StateRepoService = ReturnType<typeof createStateRepoService>;
