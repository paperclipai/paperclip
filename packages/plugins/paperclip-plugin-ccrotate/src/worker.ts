import { spawn } from "node:child_process";
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./manifest.js";
import type {
  AccountRow,
  CcrotateTarget,
  PersistedSnapshot,
  SnapshotResponse,
} from "./types.js";

let ctxRef: PluginContext | null = null;
function logger() {
  return ctxRef?.logger;
}

const SNAPSHOT_KEY = "snapshot";
const SNAPSHOT_NAMESPACE = "ccrotate";

const TARGETS: CcrotateTarget[] = ["claude", "codex"];

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code,
      });
    });
  });
}

// ─── ccrotate when parser ────────────────────────────────────────────────────
//
// `ccrotate when` text format (one row per saved account):
//
//   Cache: 1min old
//
//   ★ ✓ ramadan@blockcast.net          base       5h:64% 7d:22%   usable now
//     ✓ omar.ramadan@berkeley.edu      extra      5h:100% 7d:63%  in 52m
//     ✗ omar@blockcast.net             exhausted  5h:0% 7d:100%   stale (needs /login + snap)
//
// Columns: active-marker (★ or space) · status (✓ or ✗) · email · tier ·
// 5h:N% 7d:N% · availability text.

const ROW_RE =
  /^([★ ])\s*([✓✗])\s+(\S+@\S+)\s+(\S+)\s+5h:(\d+)% 7d:(\d+)%\s+(.+?)\s*$/u;
const CACHE_AGE_RE = /^Cache:\s*(.+)$/;

function parseWhenOutput(target: CcrotateTarget, stdout: string): {
  cacheAge: string | null;
  accounts: AccountRow[];
} {
  let cacheAge: string | null = null;
  const accounts: AccountRow[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const cm = CACHE_AGE_RE.exec(line);
    if (cm) {
      cacheAge = cm[1] ?? null;
      continue;
    }
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const [, marker, health, email, tier, u5, u7, availability] = m;
    accounts.push({
      email: email!,
      target,
      tier: tier!,
      utilization5h: Number(u5),
      utilization7d: Number(u7),
      availability: availability!.trim(),
      isActive: marker === "★",
      isHealthy: health === "✓",
    });
  }
  return { cacheAge, accounts };
}

async function runCcrotateWhen(target: CcrotateTarget): Promise<{
  cacheAge: string | null;
  accounts: AccountRow[];
}> {
  // ccrotate accepts `--target` as a global flag before the subcommand.
  const result = await runProcess("ccrotate", ["--target", target, "when"], 30_000);
  if (result.code !== 0 && result.stdout.trim() === "") {
    throw new Error(
      `ccrotate when --target ${target} exited ${result.code}: ${result.stderr.trim() || "(no stderr)"}`,
    );
  }
  return parseWhenOutput(target, result.stdout);
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleSnapshot(): Promise<PluginApiResponse> {
  const fetchedAt = new Date().toISOString();
  const targets: SnapshotResponse["targets"] = {
    claude: {},
    codex: {},
  };
  let cacheAge: string | null = null;

  await Promise.all(
    TARGETS.map(async (target) => {
      try {
        const result = await runCcrotateWhen(target);
        targets[target] = { accounts: result.accounts };
        if (result.cacheAge && !cacheAge) cacheAge = result.cacheAge;
      } catch (error) {
        targets[target] = { error: describeError(error) };
      }
    }),
  );

  const body: SnapshotResponse = { fetchedAt, cacheAge, targets };
  return { status: 200, body };
}

async function handleStateGet(_input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!ctxRef) return { status: 503, body: { error: "plugin not initialized" } };
  const value = await ctxRef.state.get({
    scopeKind: "instance",
    namespace: SNAPSHOT_NAMESPACE,
    stateKey: SNAPSHOT_KEY,
  });
  return { status: 200, body: { snapshot: (value as PersistedSnapshot | null) ?? null } };
}

async function handleStatePut(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!ctxRef) return { status: 503, body: { error: "plugin not initialized" } };
  const body = (input.body ?? {}) as { blob?: unknown };
  const blob = typeof body.blob === "string" ? body.blob : null;
  if (!blob) {
    return { status: 400, body: { error: "expected JSON body { blob: string }" } };
  }
  const value: PersistedSnapshot = { blob, capturedAt: new Date().toISOString() };
  await ctxRef.state.set(
    {
      scopeKind: "instance",
      namespace: SNAPSHOT_NAMESPACE,
      stateKey: SNAPSHOT_KEY,
    },
    value,
  );
  return { status: 200, body: { snapshot: value } };
}

// ─── Plugin definition ───────────────────────────────────────────────────────

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    ctxRef = ctx;
    logger()?.info("ccrotate plugin (visualization) ready", { pluginId: PLUGIN_ID });
  },

  async onHealth() {
    return { status: "ok", message: "ccrotate plugin ready" };
  },

  async onShutdown() {
    ctxRef = null;
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    try {
      switch (input.routeKey) {
        case "snapshot":
          return await handleSnapshot();
        case "state-get":
          return await handleStateGet(input);
        case "state-put":
          return await handleStatePut(input);
        default:
          return { status: 404, body: { error: `unknown routeKey: ${input.routeKey}` } };
      }
    } catch (error) {
      logger()?.warn("ccrotate api route handler failed", {
        routeKey: input.routeKey,
        error: describeError(error),
      });
      return { status: 500, body: { error: describeError(error) } };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
