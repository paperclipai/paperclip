import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { environments, environmentLeases, executionWorkspaces, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease, WorkspaceFileListMode, WorkspaceFileSource } from "@paperclipai/shared";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

const execFileAsync = promisify(execFile);
const READ_TIMEOUT_MS = 30_000;
const MAX_HELPER_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface RemoteWorkspaceFileEntry {
  kind: "file" | "directory";
  relativePath: string;
  byteSize: number | null;
  modifiedAt: string | null;
  text?: boolean;
  sha256?: string;
}

export interface RemoteWorkspaceFileListInput {
  relativePath?: string;
  mode: WorkspaceFileListMode;
  query?: string | null;
  limit: number;
  offset: number;
  maxScannedEntries: number;
  maxDepth: number;
}

export interface RemoteWorkspaceDownload {
  stream: Readable;
  byteSize: number;
  cleanup(): Promise<void>;
}

export interface RemoteWorkspaceFileAccess {
  source: WorkspaceFileSource;
  stat(relativePath: string): Promise<RemoteWorkspaceFileEntry>;
  read(relativePath: string, options: { maxBytes: number }): Promise<Buffer>;
  list(input: RemoteWorkspaceFileListInput): Promise<{
    entries: RemoteWorkspaceFileEntry[];
    scannedCount: number;
    truncated: boolean;
  }>;
  download(relativePath: string): Promise<RemoteWorkspaceDownload>;
  close(): Promise<void>;
}

export interface SavedWorkspaceFiles {
  root: string;
  savedAt: string;
  cleanup(): Promise<void>;
}

export interface RemoteWorkspaceFileOptions {
  environmentRuntime?: Pick<EnvironmentRuntimeService, "execute" | "syncOut">;
  loadSavedWorkspace?(input: {
    companyId: string;
    workspaceId: string;
    snapshotId: string;
  }): Promise<SavedWorkspaceFiles>;
}

export interface RemoteWorkspaceFiles {
  open(input: { companyId: string; workspaceId: string; signal?: AbortSignal }): Promise<RemoteWorkspaceFileAccess | null>;
}

// Run the same confined helper in the execution environment and in a verified,
// disposable saved-version directory. No absolute path comes from a file caller.
export const REMOTE_WORKSPACE_FILES_SCRIPT = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const input = JSON.parse(process.argv[1]);
const denied = new Set(['.git','.paperclip','.paperclip-runtime','node_modules','.pnpm-store','.yarn','.cache','.turbo','.next','.vite','.vercel','dist','build','coverage','runtime-services','.runtime']);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const deniedPath = relative => {
  const parts = relative.toLowerCase().split('/');
  const file = parts.at(-1) || '';
  return parts.some(part => denied.has(part) || part === '.aws' || part === '.ssh') ||
    file === '.env' || file.startsWith('.env.') || /\.(pem|key|p12|pfx)$/.test(file) ||
    ['id_rsa','id_ed25519','.npmrc','.pypirc','.netrc','kubeconfig'].includes(file) ||
    (parts.at(-2) === '.docker' && file === 'config.json') || (parts.at(-2) === '.kube' && file === 'config');
};
const normalize = (relative, allowRoot = false) => {
  if (allowRoot && !relative) return '';
  if (typeof relative !== 'string' || !relative || relative.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(relative) ||
      path.isAbsolute(relative) || /^[a-z][a-z0-9+.-]*:/iu.test(relative) || relative.startsWith('~') ||
      relative.split('/').some(part => part === '..' || part === '.' || part === '')) fail('invalid_path');
  if (deniedPath(relative)) fail('denied_path');
  return relative;
};
const same = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs'].every(key => a[key] === b[key]);
const within = (root,target) => { const relative = path.relative(root,target); return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)); };
(async () => {
  const rootEntry = await fs.lstat(input.root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) fail('workspace_unavailable');
  const root = await fs.realpath(input.root);
  const confined = async (relative, allowRoot = false) => {
    relative = normalize(relative, allowRoot);
    let current = root;
    for (const part of relative ? relative.split('/') : []) {
      current = path.join(current,part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) fail('symlink_denied');
    }
    const canonical = await fs.realpath(current);
    if (!within(root,canonical) || canonical !== current) fail('outside_workspace');
    return canonical;
  };
  const entry = async (relative, withHash = false) => {
    const target = await confined(relative);
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() && !stat.isFile()) fail('not_regular_file');
    const result = {kind:stat.isDirectory()?'directory':'file',relativePath:relative,byteSize:stat.isFile()?stat.size:null,modifiedAt:stat.mtime.toISOString()};
    if (stat.isFile() && input.action === 'stat') {
      const handle = await fs.open(target,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({bigint:true});
        if (!before.isFile() || before.nlink !== 1n) fail('not_regular_file');
        const sample = Buffer.alloc(4096);
        const {bytesRead} = await handle.read(sample,0,sample.length,0);
        let controls = 0;
        let nul = false;
        for (const byte of sample.subarray(0,bytesRead)) { if (!byte) nul = true; if (byte < 32 && ![9,10,13].includes(byte)) controls++; }
        result.text = !nul && (!bytesRead || controls / bytesRead < .02);
        if (withHash) { const hash = createHash('sha256'); for await (const bytes of handle.createReadStream({start:0,autoClose:false})) hash.update(bytes); result.sha256=hash.digest('hex'); }
        const after = await handle.stat({bigint:true});
        const current = await fs.lstat(target,{bigint:true});
        if (!same(before,after) || !same(after,current) || await confined(relative) !== target) fail('file_changed');
      } finally { await handle.close(); }
    }
    return result;
  };
  let result;
  if (input.action === 'stat') result=await entry(input.relativePath,input.withHash === true);
  else if (input.action === 'list') {
    const requested = input.options;
    const start = normalize(requested.relativePath || '',true);
    const startPath = await confined(start,true);
    if (!(await fs.stat(startPath)).isDirectory()) fail('not_directory');
    const maxScanned = Math.min(5000,Math.max(1,requested.maxScannedEntries));
    const maxDepth = Math.min(20,Math.max(0,requested.maxDepth));
    const limit = Math.min(100,Math.max(1,requested.limit));
    const offset = Math.min(10000,Math.max(0,requested.offset));
    const query = (requested.query || '').toLowerCase();
    let scannedCount=0,truncated=false;
    const entries=[];
    const matches = relative => !query || relative.toLowerCase().includes(query);
    const add = async relative => {
      try { const value=await entry(relative); if(matches(relative)) entries.push(value); }
      catch(error) { if(!['ENOENT','ENOTDIR','denied_path','symlink_denied','not_regular_file'].includes(error.code)) throw error; }
    };
    if (requested.mode === 'changed') {
      let stdout;
      try { ({stdout}=await promisify(execFile)('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,'status','--porcelain=v1','-z','--untracked-files=all'],{encoding:'utf8',timeout:10000,maxBuffer:1048576,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})); }
      catch { fail('changed_unavailable'); }
      const tokens=stdout.split('\0').filter(Boolean);
      for(let i=0;i<tokens.length;i++) {
        if(++scannedCount>maxScanned) {truncated=true;break;}
        const token=tokens[i];
        const status=token.slice(0,2),relative=token.slice(3);
        if(status.includes('R')||status.includes('C')) i++;
        if(relative && !deniedPath(relative)) await add(relative);
      }
    } else {
      const immediate=requested.mode==='all'&&!query;
      const queue=[{relative:start,depth:0}];
      scan: while(queue.length) {
        const current=queue.shift();
        const directory=await confined(current.relative,true);
        const children=await fs.readdir(directory,{withFileTypes:true});
        children.sort((a,b)=>immediate&&a.isDirectory()!==b.isDirectory()?(a.isDirectory()?-1:1):a.name.localeCompare(b.name));
        for(const child of children) {
          if(++scannedCount>maxScanned) {truncated=true;break scan;}
          const relative=current.relative?current.relative+'/'+child.name:child.name;
          if(deniedPath(relative)||child.isSymbolicLink()||/[\\\u0000-\u001f\u007f]/u.test(relative)) continue;
          if(child.isDirectory()) {
            if(immediate) await add(relative);
            else if(current.depth<maxDepth) queue.push({relative,depth:current.depth+1});
            else truncated=true;
          } else if(child.isFile()) await add(relative);
          if(immediate&&entries.length>offset+limit) {truncated=true;break scan;}
        }
      }
    }
    if(requested.mode==='recent') entries.sort((a,b)=>(b.modifiedAt||'').localeCompare(a.modifiedAt||'')||a.relativePath.localeCompare(b.relativePath));
    else if(requested.mode==='changed') entries.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
    result={entries:entries.slice(offset,offset+limit),scannedCount:Math.min(scannedCount,maxScanned),truncated:truncated||entries.length>offset+limit};
  } else fail('invalid_operation');
  if(await fs.realpath(input.root)!==root) fail('workspace_unavailable');
  process.stdout.write(JSON.stringify(result));
})().catch(error => {
  const allowed=new Set(['invalid_path','denied_path','symlink_denied','outside_workspace','workspace_unavailable','not_regular_file','not_directory','file_changed','changed_unavailable','ENOENT','ENOTDIR']);
  process.stderr.write(allowed.has(error.code)?error.code:'remote_read_failed');
  process.exitCode=1;
});
`;

function fileFailure(code: string): HttpError {
  if (["ENOENT", "ENOTDIR"].includes(code)) return notFound("Workspace file not found", { code: "not_found" });
  if (["denied_path", "symlink_denied", "outside_workspace", "invalid_path"].includes(code)) {
    return new HttpError(403, "Workspace file path is denied", { code });
  }
  const safe = new Set(["workspace_unavailable", "workspace_changed", "not_regular_file", "not_directory", "file_changed", "changed_unavailable", "too_large"]);
  return unprocessable("Workspace files are unavailable", { code: safe.has(code) ? code : "workspace_unavailable" });
}

function parseFileEntry(value: unknown): RemoteWorkspaceFileEntry {
  const entry = value as Partial<RemoteWorkspaceFileEntry> | null;
  if (!entry || !["file", "directory"].includes(entry.kind ?? "") || typeof entry.relativePath !== "string" ||
    !entry.relativePath || entry.relativePath.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(entry.relativePath) ||
    path.posix.isAbsolute(entry.relativePath) || entry.relativePath.split("/").some(part => !part || part === "." || part === "..") ||
    (entry.kind === "file" ? !Number.isSafeInteger(entry.byteSize) || entry.byteSize! < 0 : entry.byteSize !== null) ||
    (entry.modifiedAt !== null && (typeof entry.modifiedAt !== "string" || !Number.isFinite(Date.parse(entry.modifiedAt)))) ||
    (entry.text !== undefined && typeof entry.text !== "boolean") ||
    (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(entry.sha256))) throw fileFailure("workspace_unavailable");
  return entry as RemoteWorkspaceFileEntry;
}

function parseHelperResult(action: "stat" | "list", value: unknown, withHash: boolean): unknown {
  if (action === "stat") {
    const entry = parseFileEntry(value);
    if (withHash && entry.kind === "file" && !entry.sha256) throw fileFailure("workspace_unavailable");
    return entry;
  }
  const list = value as { entries?: unknown; scannedCount?: unknown; truncated?: unknown } | null;
  if (!list || !Array.isArray(list.entries) || list.entries.length > 100 ||
    !Number.isSafeInteger(list.scannedCount) || Number(list.scannedCount) < 0 || Number(list.scannedCount) > 5000 ||
    typeof list.truncated !== "boolean") throw fileFailure("workspace_unavailable");
  return { entries: list.entries.map(parseFileEntry), scannedCount: list.scannedCount, truncated: list.truncated };
}

async function verifyDownload(file: string, expected: RemoteWorkspaceFileEntry): Promise<number> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected.byteSize) throw fileFailure("file_changed");
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    if (expected.sha256 && hash.digest("hex") !== expected.sha256) throw fileFailure("file_changed");
    return stat.size;
  } finally { await handle.close(); }
}

export function createRemoteWorkspaceFiles(db: Db, options: RemoteWorkspaceFileOptions = {}): RemoteWorkspaceFiles {
  return {
    async open(input) {
      input.signal?.throwIfAborted();
      const [workspace] = await db.select().from(executionWorkspaces).where(and(
        eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId),
      )).limit(1);
      if (!workspace) throw notFound("Workspace not found");
      const authority = readRemoteWorkspaceAuthority(workspace.metadata);
      if (!authority) return null;
      const initialAuthority = JSON.stringify(authority);
      const checkCurrent = async () => {
        input.signal?.throwIfAborted();
        const [current] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
          eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId),
        )).limit(1);
        if (!current || JSON.stringify(readRemoteWorkspaceAuthority(current.metadata)) !== initialAuthority) {
          throw fileFailure("workspace_changed");
        }
      };
      let saved: SavedWorkspaceFiles | undefined;
      let environment: Environment | undefined;
      let lease: EnvironmentLease | undefined;
      let source: WorkspaceFileSource;
      let root: string;
      if (authority.location) {
        if (!options.environmentRuntime) throw fileFailure("workspace_unavailable");
        const [leaseRow] = await db.select().from(environmentLeases).where(and(
          eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, authority.location.leaseId),
        )).limit(1);
        const [environmentRow] = await db.select().from(environments).where(eq(environments.id, authority.location.environmentId)).limit(1);
        if (!leaseRow || !environmentRow || leaseRow.environmentId !== environmentRow.id ||
          leaseRow.providerLeaseId !== authority.location.providerLeaseId ||
          !["active", "retained", "pending_cleanup"].includes(leaseRow.status) ||
          leaseRow.metadata?.remoteCwd !== authority.location.remoteCwd) throw fileFailure("workspace_unavailable");
        lease = leaseRow as EnvironmentLease;
        environment = environmentRow as Environment;
        root = authority.location.remoteCwd;
        source = { kind: "live", savedAt: null, snapshotId: null };
      } else {
        if (!authority.snapshotId || !options.loadSavedWorkspace) throw fileFailure("workspace_unavailable");
        saved = await options.loadSavedWorkspace({ companyId: input.companyId, workspaceId: input.workspaceId, snapshotId: authority.snapshotId });
        root = saved.root;
        source = { kind: "saved", savedAt: saved.savedAt, snapshotId: authority.snapshotId };
      }
      let closed = false;
      const close = async () => { if (closed) return; closed = true; await saved?.cleanup(); };
      const execute = async <T>(action: "stat" | "list", args: Record<string, unknown>): Promise<T> => {
        if (closed) throw fileFailure("workspace_unavailable");
        await checkCurrent();
        const payload = JSON.stringify({ root, action, ...args });
        let stdout: string;
        if (saved) {
          try {
            ({ stdout } = await execFileAsync(process.execPath, ["--input-type=commonjs", "-e", REMOTE_WORKSPACE_FILES_SCRIPT, payload], {
              cwd: root, timeout: READ_TIMEOUT_MS, maxBuffer: MAX_HELPER_OUTPUT_BYTES,
              signal: input.signal, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
            }));
          } catch (error) { throw fileFailure(String((error as { stderr?: string }).stderr ?? "workspace_unavailable").trim()); }
        } else {
          const result = await options.environmentRuntime!.execute({
            environment: environment!, lease: lease!, command: "node",
            args: ["--input-type=commonjs", "-e", REMOTE_WORKSPACE_FILES_SCRIPT, payload],
            cwd: root, timeoutMs: READ_TIMEOUT_MS, bypassSession: true, env: { NODE_OPTIONS: "", NODE_PATH: "" },
          }).catch(() => { throw fileFailure("workspace_unavailable"); });
          if (result.timedOut || result.exitCode !== 0) throw fileFailure(result.timedOut ? "workspace_unavailable" : result.stderr.trim());
          stdout = result.stdout;
        }
        await checkCurrent();
        try { return parseHelperResult(action, JSON.parse(stdout), args.withHash === true) as T; }
        catch { throw fileFailure("workspace_unavailable"); }
      };
      const stat = (relativePath: string) => execute<RemoteWorkspaceFileEntry>("stat", { relativePath });
      const download = async (relativePath: string): Promise<RemoteWorkspaceDownload> => {
        const expected = await execute<RemoteWorkspaceFileEntry>("stat", { relativePath, withHash: true });
        if (expected.kind !== "file") throw fileFailure("not_regular_file");
        if (saved) {
          await checkCurrent();
          const file = path.join(root, ...relativePath.split("/"));
          return { stream: createReadStream(file), byteSize: expected.byteSize!, cleanup: async () => {} };
        }
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-file-"));
        const cleanup = async () => { await fs.rm(directory, { recursive: true, force: true }); };
        try {
          await options.environmentRuntime!.syncOut({ environment: environment!, lease: lease!, operations: [{
            operationId: `workspace-file:${randomUUID()}`,
            files: [{ sourcePath: path.posix.join(root, relativePath), targetPath: path.join(directory, "file"), kind: "file", mode: 0o600 }],
          }] }).catch(() => { throw fileFailure("workspace_unavailable"); });
          await verifyDownload(path.join(directory, "file"), expected);
          await checkCurrent();
          return { stream: createReadStream(path.join(directory, "file")), byteSize: expected.byteSize!, cleanup };
        } catch (error) { await cleanup(); throw error; }
      };
      return {
        source, stat, close,
        list: listInput => execute("list", { options: listInput }),
        async read(relativePath, readOptions) {
          const expected = await stat(relativePath);
          if (expected.kind !== "file") throw fileFailure("not_regular_file");
          if (expected.byteSize! > readOptions.maxBytes) throw fileFailure("too_large");
          const transfer = await download(relativePath);
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of transfer.stream) {
              input.signal?.throwIfAborted();
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.length;
              if (size > readOptions.maxBytes) throw fileFailure("too_large");
              chunks.push(bytes);
            }
            await checkCurrent();
            return Buffer.concat(chunks);
          } finally { transfer.stream.destroy(); await transfer.cleanup(); }
        },
        download,
      };
    },
  };
}
