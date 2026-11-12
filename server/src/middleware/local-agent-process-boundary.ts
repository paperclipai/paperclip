import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

export const AGENT_RUN_ENVIRONMENT_MARKERS = [
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_AGENT_KEY_ID",
  "PAPERCLIP_RUNNER_INSTANCE_ID",
] as const;

const RUNNER_DAEMON_EXECUTABLE = "paperclip-runnerd";
const MAX_ANCESTRY_DEPTH = 64;
const COMMAND_TIMEOUT_MS = 5_000;

export type LocalPeerClassification = "operator" | "agent_run" | "unsupported";

export interface LocalPeerSocket {
  remoteAddress?: string | null;
  remotePort?: number | null;
  localAddress?: string | null;
  localPort?: number | null;
}

export interface LocalPeerEndpoints {
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
}

export interface LocalProcessInfo {
  pid: number;
  ppid: number;
  executable: string | null;
  environment: Map<string, string>;
}

export interface LocalProcessInspector {
  findPeerPid(socket: LocalPeerEndpoints): Promise<number | null | "unsupported">;
  ancestry(pid: number, stopAt: ReadonlySet<number>): Promise<LocalProcessInfo[] | null>;
  ancestorPids(pid: number): Promise<number[] | null>;
}

export function normalizeLoopbackAddress(address: string): string {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:") && lower.includes(".")) return lower.slice("::ffff:".length);
  if (lower === "0:0:0:0:0:0:0:1") return "::1";
  return lower;
}

function decodeProcNetAddress(hex: string): string | null {
  if (hex.length === 8) {
    const bytes = Buffer.from(hex, "hex");
    return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
  }
  if (hex.length !== 32) return null;
  const bytes = Buffer.alloc(16);
  for (let word = 0; word < 4; word += 1) {
    const value = Buffer.from(hex.slice(word * 8, word * 8 + 8), "hex");
    bytes[word * 4] = value[3]!;
    bytes[word * 4 + 1] = value[2]!;
    bytes[word * 4 + 2] = value[1]!;
    bytes[word * 4 + 3] = value[0]!;
  }
  if (bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  if (bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "::1";
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  return groups.join(":");
}

export function findSocketInodeInProcNet(
  table: string,
  peer: { address: string; port: number },
  server: { address: string; port: number },
): string | null {
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [localHex, localPortHex] = fields[1]!.split(":");
    const [remoteHex, remotePortHex] = fields[2]!.split(":");
    if (!localHex || !localPortHex || !remoteHex || !remotePortHex) continue;
    if (Number.parseInt(localPortHex, 16) !== peer.port || Number.parseInt(remotePortHex, 16) !== server.port) continue;
    if (decodeProcNetAddress(localHex) !== peer.address || decodeProcNetAddress(remoteHex) !== server.address) continue;
    const inode = fields[9];
    if (inode && inode !== "0") return inode;
  }
  return null;
}

export function findPeerPidInDarwinNetstat(
  output: string,
  peer: { address: string; port: number },
  server: { address: string; port: number },
): number | null | "unsupported" {
  const lines = output.split("\n");
  const header = lines.find((line) => line.includes("Local Address"));
  if (!header || !header.includes("process:pid")) return "unsupported";
  const local = `${peer.address}.${peer.port}`;
  const remote = `${server.address}.${server.port}`;
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7 || !fields[0]!.startsWith("tcp")) continue;
    if (normalizeLoopbackAddress(fields[3]!) !== local || normalizeLoopbackAddress(fields[4]!) !== remote) continue;
    for (const field of fields.slice(6)) {
      const match = /:(\d+)$/.exec(field);
      if (match) return Number(match[1]);
    }
  }
  return null;
}

function parseEnvironmentBlock(entries: string[]): Map<string, string> {
  const environment = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return environment;
}

function runCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout));
  });
}

function linuxParentPid(stat: string): number {
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

async function ownedByServerUser(pid: string): Promise<boolean> {
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  const realUid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  return realUid !== undefined && Number(realUid) === process.getuid?.();
}

const linuxInspector: LocalProcessInspector = {
  async findPeerPid(socket) {
    const peer = { address: normalizeLoopbackAddress(socket.remoteAddress), port: socket.remotePort };
    const server = { address: normalizeLoopbackAddress(socket.localAddress), port: socket.localPort };
    const tables = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map((file) =>
      readFile(file, "utf8").catch(() => null)));
    if (tables.every((table) => table === null)) return "unsupported";
    const inode = tables.map((table) => table ? findSocketInodeInProcNet(table, peer, server) : null)
      .find((value) => value !== null);
    if (!inode) return null;
    const target = `socket:[${inode}]`;
    const others = (await readdir("/proc").catch(() => [] as string[]))
      .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid);
    let unreadable = false;
    for (const pid of [String(process.pid), ...others]) {
      const fds = await readdir(`/proc/${pid}/fd`).catch(async (error: NodeJS.ErrnoException) => {
        if ((error.code === "EACCES" || error.code === "EPERM") && await ownedByServerUser(pid)) unreadable = true;
        return [] as string[];
      });
      for (const fd of fds) {
        if (await readlink(`/proc/${pid}/fd/${fd}`).catch(() => null) === target) return Number(pid);
      }
    }
    return unreadable ? "unsupported" : null;
  },
  async ancestorPids(pid) {
    const pids: number[] = [];
    let current = pid;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current > 1; depth += 1) {
      pids.push(current);
      const stat = await readFile(`/proc/${current}/stat`, "utf8").catch(() => null);
      if (!stat) return null;
      current = linuxParentPid(stat);
      if (!Number.isInteger(current)) return null;
    }
    return pids;
  },
  async ancestry(pid, stopAt) {
    const chain: LocalProcessInfo[] = [];
    let current = pid;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current > 1 && !stopAt.has(current); depth += 1) {
      const stat = await readFile(`/proc/${current}/stat`, "utf8").catch(() => null);
      if (!stat) return chain.length ? chain : null;
      const ppid = linuxParentPid(stat);
      const [cmdline, environ] = await Promise.all([
        readFile(`/proc/${current}/cmdline`, "utf8").catch(() => ""),
        readFile(`/proc/${current}/environ`, "utf8").catch(() => ""),
      ]);
      chain.push({
        pid: current,
        ppid,
        executable: cmdline.split("\0")[0] || null,
        environment: parseEnvironmentBlock(environ.split("\0")),
      });
      current = ppid;
    }
    return chain;
  },
};

async function darwinParentTable(): Promise<Map<number, number> | null> {
  const output = await runCommand("ps", ["-axo", "pid=,ppid="]);
  if (output === null) return null;
  const parents = new Map<number, number>();
  for (const line of output.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
  }
  return parents;
}

function darwinChain(parents: Map<number, number>, pid: number, stopAt: ReadonlySet<number>): number[] {
  const chain: number[] = [];
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current > 1 && !stopAt.has(current); depth += 1) {
    chain.push(current);
    const parent = parents.get(current);
    if (parent === undefined) break;
    current = parent;
  }
  return chain;
}

export function parseDarwinProcessEnvironmentLine(command: string): {
  executable: string | null;
  environment: Map<string, string>;
} {
  const tokens = command.trim().split(/\s+/);
  const environment = new Map<string, string>();
  for (const token of tokens.slice(1)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (match) environment.set(match[1]!, match[2]!);
  }
  return { executable: tokens[0] || null, environment };
}

const darwinInspector: LocalProcessInspector = {
  async findPeerPid(socket) {
    const output = await runCommand("netstat", ["-anv", "-p", "tcp"]);
    if (output === null) return "unsupported";
    return findPeerPidInDarwinNetstat(
      output,
      { address: normalizeLoopbackAddress(socket.remoteAddress), port: socket.remotePort },
      { address: normalizeLoopbackAddress(socket.localAddress), port: socket.localPort },
    );
  },
  async ancestorPids(pid) {
    const parents = await darwinParentTable();
    return parents ? darwinChain(parents, pid, new Set()) : null;
  },
  async ancestry(pid, stopAt) {
    const parents = await darwinParentTable();
    if (!parents) return null;
    const pids = darwinChain(parents, pid, stopAt);
    if (!pids.length) return [];
    const output = await runCommand("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")]);
    if (output === null) return null;
    const details = new Map<number, ReturnType<typeof parseDarwinProcessEnvironmentLine>>();
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match) details.set(Number(match[1]), parseDarwinProcessEnvironmentLine(match[2]!));
    }
    return pids.map((entry) => ({
      pid: entry,
      ppid: parents.get(entry) ?? 0,
      executable: details.get(entry)?.executable ?? null,
      environment: details.get(entry)?.environment ?? new Map(),
    }));
  },
};

export function defaultLocalProcessInspector(platform: NodeJS.Platform = process.platform): LocalProcessInspector | null {
  if (platform === "linux") return linuxInspector;
  if (platform === "darwin") return darwinInspector;
  return null;
}

export function chainBelongsToAgentRun(
  chain: readonly LocalProcessInfo[],
  serverEnvironment: NodeJS.ProcessEnv,
): boolean {
  return chain.some((entry, index) => {
    if (entry.executable !== null && path.basename(entry.executable) === RUNNER_DAEMON_EXECUTABLE) return index > 0;
    return AGENT_RUN_ENVIRONMENT_MARKERS.some((key) => {
      const value = entry.environment.get(key);
      return value !== undefined && value !== "" && value !== serverEnvironment[key];
    });
  });
}

export interface LocalAgentProcessBoundaryOptions {
  inspector?: LocalProcessInspector | null;
  serverPid?: number;
  serverEnvironment?: NodeJS.ProcessEnv;
}

export function createLocalAgentProcessBoundary(options: LocalAgentProcessBoundaryOptions = {}) {
  const inspector = options.inspector === undefined ? defaultLocalProcessInspector() : options.inspector;
  const serverPid = options.serverPid ?? process.pid;
  const serverEnvironment = options.serverEnvironment ?? process.env;
  const classifications = new WeakMap<object, Promise<LocalPeerClassification>>();
  let serverAncestors: Promise<ReadonlySet<number>> | null = null;
  let warnedUnsupported = false;

  function stopSet(): Promise<ReadonlySet<number>> {
    serverAncestors ??= (inspector?.ancestorPids(serverPid) ?? Promise.resolve(null))
      .then((pids) => new Set([serverPid, ...(pids ?? [])]));
    return serverAncestors;
  }

  async function classifyUncached(socket: LocalPeerSocket): Promise<LocalPeerClassification> {
    if (!inspector) return "unsupported";
    const { remoteAddress, remotePort, localAddress, localPort } = socket;
    if (!remoteAddress || !remotePort || !localAddress || !localPort) return "agent_run";
    const peerPid = await inspector.findPeerPid({ remoteAddress, remotePort, localAddress, localPort });
    if (peerPid === "unsupported") return "unsupported";
    if (peerPid === null) return "agent_run";
    const stopAt = await stopSet();
    if (stopAt.has(peerPid)) return "operator";
    const chain = await inspector.ancestry(peerPid, stopAt);
    if (chain === null) return "agent_run";
    return chainBelongsToAgentRun(chain, serverEnvironment) ? "agent_run" : "operator";
  }

  async function classify(socket: LocalPeerSocket & object): Promise<LocalPeerClassification> {
    let pending = classifications.get(socket);
    if (!pending) {
      pending = classifyUncached(socket).catch((err) => {
        logger.warn({ err }, "Could not identify the local process behind a request; refusing implicit board access");
        return "agent_run" as const;
      });
      classifications.set(socket, pending);
    }
    const result = await pending;
    if (result === "unsupported" && !warnedUnsupported) {
      warnedUnsupported = true;
      logger.warn("This platform cannot identify the local process behind a request, so implicit local board access is not limited to operator processes");
    }
    return result;
  }

  async function grantsImplicitBoard(socket: (LocalPeerSocket & object) | null | undefined): Promise<boolean> {
    if (!socket) return false;
    return await classify(socket) !== "agent_run";
  }

  return { classify, grantsImplicitBoard };
}

export type LocalAgentProcessBoundary = ReturnType<typeof createLocalAgentProcessBoundary>;

let sharedBoundary: LocalAgentProcessBoundary | null = null;

export function localAgentProcessBoundary(): LocalAgentProcessBoundary {
  sharedBoundary ??= createLocalAgentProcessBoundary();
  return sharedBoundary;
}
