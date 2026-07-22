// ck_local — CK's first-class Paperclip adapter.
//
// Why this exists: our agents run the CK DeepSeek runner (.ck-agent/runner.mjs).
// On the generic `process` adapter Paperclip treats that as an opaque command and
// reports NO local capabilities, so the GUI shows empty Instructions/Skills tabs.
// `ck_local` runs the exact same proven runner but DECLARES the capabilities it
// actually has (instructions bundle, skills sync, session) so the GUI reflects
// reality. Runtime behaviour is unchanged: same command, same env, same DeepSeek.
//
// Loaded as an external adapter plugin (POST /api/adapters/install, localPath).
// Runs inside the pc-build container; absolute paths below are container paths.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const TYPE = "ck_local";
// Built workspace copy of Paperclip's adapter helpers (same code the built-in
// adapters use). Imported lazily + defensively so a path change never breaks the
// critical execute() path.
const ADAPTER_UTILS = "/work/packages/adapter-utils/dist/server-utils.js";
const SKILLS_DIR = "/work/.ck-agent/skills";
const DEFAULT_RUNNER = "/work/.ck-agent/runner.mjs";

// --- self-contained config helpers (no external deps on the hot path) ---------
function asString(v, d = "") {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.value === "string") return v.value;
  return d;
}
function asNumber(v, d = 0) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : d;
}
function asStringArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}
function parseObject(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const o = JSON.parse(v);
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  return {};
}
function redactEnv(entries) {
  const out = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k] = /KEY|TOKEN|SECRET|PASS|BEARER/i.test(k) ? "***" : v;
  }
  return out;
}

export function resolveCommandArgs(config) {
  const configured = asStringArray(config?.args);
  return configured.length > 0 ? configured : [DEFAULT_RUNNER];
}

// --- core execution: spawn the CK runner, stream logs, honour timeout ---------
async function execute(ctx) {
  const { runId, agent, config, context = {}, onLog, onMeta, onSpawn } = ctx;
  const command = asString(config.command, "node");
  const args = resolveCommandArgs(config);
  const cwd = asString(config.cwd, "/work");
  const envConfig = parseObject(config.env);

  // Pass through the (already secret-resolved) config env: CK_API_URL,
  // CK_PAPERCLIP_KEY, CK_AGENT_*, CK_SKILLS, CK_TOOLS, CK_MODEL, etc.
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envConfig)) {
    const s = asString(v, null);
    if (s !== null) env[k] = s;
  }
  // Native Paperclip context the runner reads (the essentials buildPaperclipEnv
  // would provide; kept explicit so this adapter carries no hidden dependency).
  env.PAPERCLIP_API_URL =
    env.PAPERCLIP_API_URL || asString(envConfig.CK_API_URL, "http://127.0.0.1:3100");
  env.PAPERCLIP_RUN_ID = runId || "";
  env.PAPERCLIP_AGENT_ID = agent.id || "";
  env.PAPERCLIP_COMPANY_ID = agent.companyId || "";
  // Preserve the native wake scope. Without PAPERCLIP_TASK_ID, a comment or
  // Hold wake on an in-review issue starts the runner but it cannot identify
  // the target, reports an empty inbox, and silently ignores the feedback.
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim())
    || (typeof context.issueId === "string" && context.issueId.trim())
    || "";
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (typeof context.wakeReason === "string" && context.wakeReason.trim()) {
    env.PAPERCLIP_WAKE_REASON = context.wakeReason.trim();
  }
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim())
    || (typeof context.commentId === "string" && context.commentId.trim())
    || "";
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  const resolvedBlockerIssueId =
    (typeof context.resolvedBlockerIssueId === "string" && context.resolvedBlockerIssueId.trim())
    || "";
  if (resolvedBlockerIssueId) {
    env.PAPERCLIP_RESOLVED_BLOCKER_ISSUE_ID = resolvedBlockerIssueId;
  }
  // If local-agent JWT is ever enabled, the server hands us a token to inject.
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  // Managed instructions bundle path (Paperclip resolves it from adapterConfig);
  // the runner also fetches the bundle over the API, this is a belt-and-braces hint.
  const instrPath = asString(config.instructionsFilePath, "");
  if (instrPath) env.CK_INSTRUCTIONS_PATH = instrPath;

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  // The native adapter model picker writes adapterConfig.model. Older CK
  // agents also carry CK_MODEL in env; keep that as a compatibility fallback.
  // Without bridging the native field into the runner env, every UI-selected
  // Flash agent silently executed and billed as Pro.
  const model = asString(config.model, asString(envConfig.CK_MODEL, "deepseek-v4-pro"));
  env.CK_MODEL = model;

  if (onMeta) {
    await onMeta({
      adapterType: TYPE,
      command,
      cwd,
      commandArgs: args,
      env: redactEnv({
        ...Object.fromEntries(Object.keys(envConfig).map((k) => [k, asString(envConfig[k], "")])),
        PAPERCLIP_API_URL: env.PAPERCLIP_API_URL,
        PAPERCLIP_RUN_ID: env.PAPERCLIP_RUN_ID,
        PAPERCLIP_AGENT_ID: env.PAPERCLIP_AGENT_ID,
        PAPERCLIP_COMPANY_ID: env.PAPERCLIP_COMPANY_ID,
        PAPERCLIP_TASK_ID: env.PAPERCLIP_TASK_ID || "",
        PAPERCLIP_WAKE_REASON: env.PAPERCLIP_WAKE_REASON || "",
        PAPERCLIP_WAKE_COMMENT_ID: env.PAPERCLIP_WAKE_COMMENT_ID || "",
        PAPERCLIP_RESOLVED_BLOCKER_ISSUE_ID:
          env.PAPERCLIP_RESOLVED_BLOCKER_ISSUE_ID || "",
      }),
    });
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn(command, args, { cwd, env });
  if (onSpawn && child.pid) {
    await onSpawn({ pid: child.pid, startedAt: new Date().toISOString() });
  }
  child.stdout.on("data", (d) => {
    const s = d.toString();
    stdout += s;
    if (onLog) void onLog("stdout", s);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    if (onLog) void onLog("stderr", s);
  });

  let killTimer = null;
  let graceTimer = null;
  if (timeoutSec > 0) {
    killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, graceSec) * 1000);
    }, timeoutSec * 1000);
  }

  const { code, signal } = await new Promise((resolve) => {
    child.on("error", (err) => {
      stderr += `\n[ck_local spawn error] ${err.message}`;
      resolve({ code: 127, signal: null });
    });
    child.on("close", (c, s) => resolve({ code: c, signal: s }));
  });
  if (killTimer) clearTimeout(killTimer);
  if (graceTimer) clearTimeout(graceTimer);

  // The runner prints a final JSON line { ck_runner:true, action, tokens }.
  let tokens = null;
  let usage = null;
  let costUsd = null;
  let costBreakdown = null;
  let action = null;
  for (const line of stdout.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes("ck_runner")) continue;
    try {
      const j = JSON.parse(t);
      if (j && j.ck_runner) {
        tokens = typeof j.tokens === "number" ? j.tokens : null;
        if (j.usage && typeof j.usage === "object") {
          usage = {
            inputTokens: Math.max(0, asNumber(j.usage.inputTokens, 0)),
            cachedInputTokens: Math.max(0, asNumber(j.usage.cachedInputTokens, 0)),
            outputTokens: Math.max(0, asNumber(j.usage.outputTokens, 0)),
          };
        }
        if (Array.isArray(j.costBreakdown)) {
          costBreakdown = j.costBreakdown
            .map((entry) => {
              const entryUsage = parseObject(entry?.usage);
              const entryModel = asString(entry?.model, "");
              if (!entryModel) return null;
              return {
                provider: asString(entry?.provider, "deepseek"),
                biller: asString(entry?.biller, "deepseek"),
                billingType: asString(entry?.billingType, "metered_api"),
                model: entryModel,
                usage: {
                  inputTokens: Math.max(0, asNumber(entryUsage.inputTokens, 0)),
                  cachedInputTokens: Math.max(0, asNumber(entryUsage.cachedInputTokens, 0)),
                  outputTokens: Math.max(0, asNumber(entryUsage.outputTokens, 0)),
                },
                costUsd: Number.isFinite(Number(entry?.costUsd))
                  ? Math.max(0, Number(entry.costUsd))
                  : null,
              };
            })
            .filter(Boolean);
        }
        costUsd = Number.isFinite(Number(j.costUsd)) ? Math.max(0, Number(j.costUsd)) : null;
        action = j.action ?? null;
        break;
      }
    } catch {
      /* not the summary line */
    }
  }

  if (timedOut) {
    return {
      exitCode: code,
      signal,
      timedOut: true,
      errorMessage: `CK runner timed out after ${timeoutSec}s`,
      provider: "deepseek",
      model,
    };
  }
  if ((code ?? 0) !== 0) {
    return {
      exitCode: code,
      signal,
      timedOut: false,
      errorMessage: `CK runner exited with code ${code ?? -1}`,
      provider: "deepseek",
      model,
      biller: "deepseek",
      billingType: "metered_api",
      ...(usage ? { usage } : {}),
      ...(costUsd != null ? { costUsd } : {}),
      ...(costBreakdown?.length ? { costBreakdown } : {}),
      resultJson: { stdout, stderr, action },
    };
  }
  return {
    exitCode: code,
    signal,
    timedOut: false,
    provider: "deepseek",
    biller: "deepseek",
    billingType: "metered_api",
    model,
    ...(usage ? { usage } : tokens != null ? { usage: { inputTokens: 0, outputTokens: tokens } } : {}),
    ...(costUsd != null ? { costUsd } : {}),
    ...(costBreakdown?.length ? { costBreakdown } : {}),
    resultJson: { stdout, stderr, action },
  };
}

// --- environment diagnostics --------------------------------------------------
async function testEnvironment(ctx) {
  const checks = [];
  checks.push({ level: "info", message: `Node ${process.version}`, code: "node_ok" });

  const cfg = parseObject(ctx && ctx.config);
  const env = parseObject(cfg.env);
  const keyPath = asString(env.CK_DEEPSEEK_KEY_PATH, "/work/.ck-secrets/deepseek.key");
  if (existsSync(keyPath)) {
    try {
      const key = readFileSync(keyPath, "utf8").trim();
      const response = await fetch("https://api.deepseek.com/user/balance", {
        headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5_000),
      });
      const balance = await response.json().catch(() => ({}));
      if (!response.ok) {
        checks.push({
          level: "error",
          message: `DeepSeek credential check failed (HTTP ${response.status})`,
          hint: "Verify the configured API key.",
          code: "key_unusable",
        });
      } else if (balance.is_available !== true) {
        checks.push({
          level: "error",
          message: "DeepSeek API balance is unavailable",
          hint: "Top up the DeepSeek API account before waking metered agents.",
          code: "insufficient_balance",
        });
      } else {
        const balances = Array.isArray(balance.balance_infos)
          ? balance.balance_infos
              .map((entry) => `${entry.currency || "?"} ${entry.total_balance || "0"}`)
              .join(" · ")
          : "available";
        checks.push({
          level: "info",
          message: `DeepSeek API ready (${balances})`,
          code: "balance_ok",
        });
      }
    } catch (err) {
      checks.push({
        level: "error",
        message: `DeepSeek readiness check failed: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Check network access and the configured API key.",
        code: "balance_check_failed",
      });
    }
  } else {
    checks.push({
      level: "error",
      message: `DeepSeek key not found at ${keyPath}`,
      hint: "Place the DeepSeek API key so the runner can authenticate.",
      code: "no_key",
    });
  }
  const runner = resolveCommandArgs(cfg)[0] || "";
  if (runner) {
    checks.push({
      level: existsSync(runner) ? "info" : "warn",
      message: existsSync(runner) ? `Runner present: ${runner}` : `Runner not found: ${runner}`,
      code: "runner",
    });
  }
  const status = checks.some((c) => c.level === "error") ? "fail" : "pass";
  return {
    adapterType: (ctx && ctx.adapterType) || TYPE,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

// --- skills: report the natively-assigned skills so the GUI drops the banner --
async function skillSnapshot(ctx) {
  try {
    const su = await import(ADAPTER_UTILS);
    const available = await su.readPaperclipRuntimeSkillEntries(ctx.config, SKILLS_DIR);
    const desired = su.resolvePaperclipDesiredSkillNames(ctx.config, available);
    return su.buildRuntimeMountedSkillSnapshot({
      adapterType: TYPE,
      availableEntries: available,
      desiredSkills: desired,
      configuredDetail: "Materialized into the CK runner's skills dir on the next run.",
    });
  } catch (e) {
    // Graceful fallback: still report supported so the GUI renders the assigned
    // skills as native (no "adapter does not implement skill sync" banner).
    return {
      adapterType: TYPE,
      supported: true,
      mode: "persistent",
      desiredSkills: [],
      entries: [],
      warnings: [`ck_local skill snapshot fallback: ${String(e && e.message ? e.message : e).slice(0, 140)}`],
    };
  }
}
async function listSkills(ctx) {
  return skillSnapshot(ctx);
}
async function syncSkills(ctx, _desiredSkills) {
  return skillSnapshot(ctx);
}

// --- session codec: passthrough (runner is currently stateless per run) -------
const sessionCodec = {
  deserialize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = asString(raw.sessionId, "");
    return id ? { sessionId: id } : null;
  },
  serialize(params) {
    if (!params) return null;
    const id = asString(params.sessionId, "");
    return id ? { sessionId: id } : null;
  },
  getDisplayId(params) {
    return params ? asString(params.sessionId, "") || null : null;
  },
};

export function createServerAdapter() {
  return {
    type: TYPE,
    execute,
    testEnvironment,
    listSkills,
    syncSkills,
    sessionCodec,
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    ],
    // Capability flags — the whole point: make the GUI reflect what these agents have.
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    supportsLocalAgentJwt: false, // keep the proven baked-key auth for now
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc: `# ck_local configuration

Adapter: ck_local (CK first-class DeepSeek runner)

Runs the CK agent runner as a native Paperclip agent. Same runtime as before,
now with native instructions bundle, skills sync and session surfaced in the GUI.

Core fields (adapterConfig):
- command (string): interpreter, usually "node"
- args (string[]): [ "/work/.ck-agent/runner.mjs" ]
- cwd (string): "/work"
- env (object): CK_API_URL, CK_PAPERCLIP_KEY, CK_AGENT_ID, CK_AGENT_NAME,
  CK_AGENT_CHARTER, CK_SKILLS, CK_TOOLS, CK_MODEL (deepseek-v4-pro)
- instructionsFilePath / instructionsBundleMode: managed by Paperclip

Operational:
- timeoutSec (number, optional), graceSec (number, optional)
`,
  };
}

export default { createServerAdapter };
