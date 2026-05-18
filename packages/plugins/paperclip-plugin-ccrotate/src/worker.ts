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

const CACHE_AGE_RE = /^Cache:\s*(.+)$/;
const UTIL_RE = /5h:(\d+)% 7d:(\d+)%/;
const SONNET_7D_RE = /\bs7d:(\d+)%/;
const OPUS_7D_RE = /\bo7d:(\d+)%/;
// ccrotate ≥ the glyph-column patch emits one of these between health (✓/✗)
// and the email column. Older ccrotate omits it; both forms parse here.
const AVAIL_GLYPH_RE = /^[🟢🟡🔴🔵⏳❔]/u;

function parseWhenRow(line: string): {
  marker: string;
  health: string;
  availMark: string | null;
  email: string;
  tier: string;
  util: { u5: number; u7: number; s7d: number | null; o7d: number | null } | null;
  availability: string;
} | null {
  const trimmed = line.trimStart();
  const marker = line.startsWith("★") ? "★" : " ";
  let rest = trimmed.startsWith("★") ? trimmed.slice(1).trimStart() : trimmed;
  if (!rest.startsWith("✓") && !rest.startsWith("✗")) return null;
  const health = rest[0]!;
  rest = rest.slice(1).trimStart();
  let availMark: string | null = null;
  const ag = AVAIL_GLYPH_RE.exec(rest);
  if (ag) {
    availMark = ag[0]!;
    rest = rest.slice(ag[0]!.length).trimStart();
  }
  const tokens = rest.split(/\s+/);
  if (tokens.length < 2) return null;
  const email = tokens[0]!;
  if (!email.includes("@")) return null;
  const tailStart = rest.indexOf(email) + email.length;
  const tail = rest.slice(tailStart).trim();
  const tailTokens = tail.split(/\s+/);
  if (tailTokens.length < 1) return null;
  const tier = tailTokens[0]!;
  const tierEnd = tail.indexOf(tier) + tier.length;
  let postTier = tail.slice(tierEnd).trim();
  let util: { u5: number; u7: number; s7d: number | null; o7d: number | null } | null = null;
  const um = UTIL_RE.exec(postTier);
  if (um) {
    const sm = SONNET_7D_RE.exec(postTier);
    const om = OPUS_7D_RE.exec(postTier);
    util = {
      u5: Number(um[1]),
      u7: Number(um[2]),
      s7d: sm ? Number(sm[1]) : null,
      o7d: om ? Number(om[1]) : null,
    };
    postTier = postTier
      .replace(UTIL_RE, "")
      .replace(SONNET_7D_RE, "")
      .replace(OPUS_7D_RE, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return {
    marker,
    health,
    availMark,
    email,
    tier,
    util,
    availability: postTier,
  };
}

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
    const parsed = parseWhenRow(line);
    if (!parsed) continue;
    accounts.push({
      email: parsed.email,
      target,
      tier: parsed.tier,
      utilization5h: parsed.util?.u5 ?? null,
      utilization7d: parsed.util?.u7 ?? null,
      utilization7dSonnet: parsed.util?.s7d ?? null,
      utilization7dOpus: parsed.util?.o7d ?? null,
      availability: parsed.availability,
      isActive: parsed.marker === "★",
      isHealthy: parsed.health === "✓",
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

async function handleRefresh(): Promise<PluginApiResponse> {
  // Full per-account refresh — calls Anthropic + Claude/Codex APIs for every
  // saved account and rewrites the on-disk tier-cache.
  //
  // Manually triggered from the UI, so the longer wall-clock vs `refresh-one`
  // is acceptable. ccrotate's refresh handles its own per-account cooldowns
  // and skips accounts already throttled, so consecutive button presses
  // are safe; back-to-back refreshes within the cooldown window will return
  // the same data without an API hit.
  //
  // Run both targets sequentially. ccrotate refresh defaults to the active
  // CCROTATE_TARGET, so we drive each one explicitly.
  const errors: { target: CcrotateTarget; error: string }[] = [];
  for (const target of TARGETS) {
    const result = await runProcess("ccrotate", ["--target", target, "refresh"], 180_000);
    if (result.code !== 0) {
      errors.push({
        target,
        error: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`,
      });
    }
  }
  // Even if one target failed, return what we got — the snapshot route on
  // the next refetch reads the on-disk cache and will surface partial data.
  // 502 if BOTH targets failed, 200 with errors[] if partial.
  if (errors.length === TARGETS.length) {
    return {
      status: 502,
      body: { ok: false, errors },
    };
  }
  return { status: 200, body: { ok: true, errors: errors.length > 0 ? errors : undefined } };
}

async function handleImport(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!ctxRef) return { status: 503, body: { error: "plugin not initialized" } };
  const body = (input.body ?? {}) as { blob?: unknown };
  const blob = typeof body.blob === "string" ? body.blob.trim() : "";
  if (!blob.startsWith("mp-gz-b64:")) {
    return {
      status: 400,
      body: { error: "expected JSON body { blob: string starting with 'mp-gz-b64:' }" },
    };
  }
  // 1. Run ccrotate import locally on the paperclip pod so the live tier-cache
  //    immediately reflects the imported state (the snapshot route reads
  //    ccrotate's on-disk cache via `ccrotate when`, not the DB blob).
  const importResult = await runProcess("ccrotate", ["import", blob, "--force"], 30_000);
  if (importResult.code !== 0) {
    return {
      status: 502,
      body: {
        ok: false,
        error: importResult.stderr.trim() || importResult.stdout.trim() || `exit ${importResult.code}`,
      },
    };
  }
  // ccrotate import prints e.g. "Import complete: N updated, M kept (local fresher)."
  const summary = (importResult.stdout + importResult.stderr).match(
    /(\d+)\s+updated,\s*(\d+)\s+kept/i,
  );
  const imported = summary
    ? { updated: Number(summary[1]), kept: Number(summary[2]) }
    : undefined;

  // 2. Persist the imported blob to plugin_state so the next Job pod's
  //    preRun hook re-imports the same canonical state.
  const value: PersistedSnapshot = { blob, capturedAt: new Date().toISOString() };
  await ctxRef.state.set(
    {
      scopeKind: "instance",
      namespace: SNAPSHOT_NAMESPACE,
      stateKey: SNAPSHOT_KEY,
    },
    value,
  );
  return { status: 200, body: { ok: true, imported, capturedAt: value.capturedAt } };
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
        case "refresh":
          return await handleRefresh();
        case "state-get":
          return await handleStateGet(input);
        case "state-put":
          return await handleStatePut(input);
        case "import":
          return await handleImport(input);
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
