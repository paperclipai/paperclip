// ADR-0008 worker-fleet data-residency preflight gate.
// Pure: no I/O except loadPreflightDenylistConfig(). Wired into
// claude-local + codex-local adapter execute paths BEFORE the first
// LLM call so that a denylisted task spends zero tokens.

import fs from "node:fs/promises";

export interface PreflightDenylistConfig {
  version: number;
  deny_workspace_cwd_prefixes: string[];
  deny_path_globs: string[];
}

export interface PreflightDenylistInput {
  /** Absolute cwd resolved from issue executionWorkspace. May be empty. */
  workspaceCwd: string;
  /** Issue description + linked spec docs concatenated. */
  specBody: string;
  config: PreflightDenylistConfig;
}

export type PreflightDenylistRuleId =
  | "deny_workspace_cwd_prefix"
  | "deny_path_glob_in_spec";

export type PreflightDenylistDecision =
  | { decision: "pass" }
  | {
      decision: "refuse";
      ruleId: PreflightDenylistRuleId;
      evidence: string;
      matchedRule: string;
    };

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

function startsWithPrefix(cwd: string, prefix: string): boolean {
  const normCwd = normalizePath(cwd).toLowerCase().replace(/\/+$/, "");
  const normPrefix = normalizePath(prefix).toLowerCase().replace(/\/+$/, "");
  if (normCwd.length === 0 || normPrefix.length === 0) return false;
  if (normCwd === normPrefix) return true;
  return normCwd.startsWith(normPrefix + "/");
}

// Minimal glob → regex. Supports `**`, `*`, `?`, and literals.
// `**` matches across path separators; `*` matches within one segment;
// `?` matches a single non-separator char. Escapes other regex metachars.
function globToRegExp(glob: string): RegExp {
  const norm = normalizePath(glob);
  let pattern = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        // `**` or `**/` — match any chars including `/`
        pattern += ".*";
        i++;
        if (norm[i + 1] === "/") {
          // Allow `**/foo` to match `foo` at root too.
          pattern += "/?";
          i++;
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (c === "?") {
      pattern += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      pattern += "\\" + c;
    } else {
      pattern += c;
    }
  }
  return new RegExp("(^|[\\s\"'`(\\[])" + pattern + "($|[\\s\"'`)\\]:,;])", "i");
}

function findGlobMatchInSpec(specBody: string, glob: string): string | null {
  if (!specBody) return null;
  const normSpec = normalizePath(specBody);
  const re = globToRegExp(glob);
  const match = normSpec.match(re);
  if (!match) return null;
  return match[0].trim().replace(/^["'`(\[]|["'`)\]:,;]$/g, "");
}

export function evaluatePreflightDenylist(
  input: PreflightDenylistInput,
): PreflightDenylistDecision {
  const { workspaceCwd, specBody, config } = input;

  // Rule 1: workspace cwd prefix match.
  if (workspaceCwd && Array.isArray(config.deny_workspace_cwd_prefixes)) {
    for (const prefix of config.deny_workspace_cwd_prefixes) {
      if (startsWithPrefix(workspaceCwd, prefix)) {
        return {
          decision: "refuse",
          ruleId: "deny_workspace_cwd_prefix",
          matchedRule: prefix,
          evidence: `executionWorkspace.workspaceCwd '${workspaceCwd}' starts with denied prefix '${prefix}'`,
        };
      }
    }
  }

  // Rule 2: spec body references a denied path glob (env files, secrets, key material).
  if (specBody && Array.isArray(config.deny_path_globs)) {
    for (const glob of config.deny_path_globs) {
      const hit = findGlobMatchInSpec(specBody, glob);
      if (hit) {
        return {
          decision: "refuse",
          ruleId: "deny_path_glob_in_spec",
          matchedRule: glob,
          evidence: `spec body references path matching '${glob}': '${hit}'`,
        };
      }
    }
  }

  return { decision: "pass" };
}

export async function loadPreflightDenylistConfig(
  configPath: string,
): Promise<PreflightDenylistConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PreflightDenylistConfig>;
  if (typeof parsed.version !== "number") {
    throw new Error(
      `preflight denylist config at ${configPath} is missing required field 'version'`,
    );
  }
  const prefixes = Array.isArray(parsed.deny_workspace_cwd_prefixes)
    ? parsed.deny_workspace_cwd_prefixes.filter((v): v is string => typeof v === "string")
    : [];
  const globs = Array.isArray(parsed.deny_path_globs)
    ? parsed.deny_path_globs.filter((v): v is string => typeof v === "string")
    : [];
  return {
    version: parsed.version,
    deny_workspace_cwd_prefixes: prefixes,
    deny_path_globs: globs,
  };
}

/**
 * Resolved location of the canonical ADR-0008 denylist config, sourced from the
 * DevOps repo. Adapters read this via env override
 * (`PAPERCLIP_WORKER_RESIDENCY_DENYLIST`) so each environment can point at its
 * own checkout. Default keeps Anton's local layout working.
 */
export const DEFAULT_PREFLIGHT_DENYLIST_PATH =
  "D:/Projects/DevOps/scripts/worker-allowed-prefixes.json";

export function resolvePreflightDenylistPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PAPERCLIP_WORKER_RESIDENCY_DENYLIST?.trim();
  if (override && override.length > 0) return override;
  return DEFAULT_PREFLIGHT_DENYLIST_PATH;
}

/**
 * Format the comment body the adapter posts on a refusal, per ADR-0008 §2.3.
 */
export function formatPreflightRefusalComment(input: {
  workerName: string;
  decision: Extract<PreflightDenylistDecision, { decision: "refuse" }>;
  unblockOwner: string;
}): string {
  const { workerName, decision, unblockOwner } = input;
  return `[${workerName}] BLOCKED by ADR-0008 rule ${decision.ruleId} — ${decision.evidence}. Unblock owner: ${unblockOwner}.`;
}

export interface PostPreflightRefusalInput {
  apiUrl: string;
  apiKey: string;
  issueId: string;
  commentBody: string;
}

export interface PostPreflightRefusalResult {
  commentPosted: boolean;
  statusPatched: boolean;
  errors: string[];
}

/**
 * Post the refusal comment and PATCH the issue to `blocked`. Best-effort:
 * we never throw; failures are reported on the result so the caller can log
 * them but still exit cleanly. We never let an API failure cause an LLM call
 * to happen — that decision has already been made before this is invoked.
 */
export async function postPreflightRefusal(
  input: PostPreflightRefusalInput,
  fetchImpl: typeof fetch = fetch,
): Promise<PostPreflightRefusalResult> {
  const errors: string[] = [];
  const base = input.apiUrl.replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${input.apiKey}`,
  };

  let commentPosted = false;
  try {
    const res = await fetchImpl(`${base}/api/issues/${encodeURIComponent(input.issueId)}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: input.commentBody }),
    });
    if (res.ok) {
      commentPosted = true;
    } else {
      errors.push(`comment POST failed: HTTP ${res.status}`);
    }
  } catch (err) {
    errors.push(`comment POST threw: ${(err as Error).message ?? String(err)}`);
  }

  let statusPatched = false;
  try {
    const res = await fetchImpl(`${base}/api/issues/${encodeURIComponent(input.issueId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "blocked" }),
    });
    if (res.ok) {
      statusPatched = true;
    } else {
      errors.push(`status PATCH failed: HTTP ${res.status}`);
    }
  } catch (err) {
    errors.push(`status PATCH threw: ${(err as Error).message ?? String(err)}`);
  }

  return { commentPosted, statusPatched, errors };
}

export interface RunAdapterPreflightDenylistInput {
  agentName: string;
  workspaceCwd: string;
  specBody: string;
  issueId: string | null;
  apiUrl: string | null;
  authToken: string | null;
  unblockOwner?: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /** Pre-loaded config — when omitted, the canonical file is read from disk. */
  config?: PreflightDenylistConfig;
  configPath?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface RunAdapterPreflightDenylistResult {
  refused: boolean;
  decision: PreflightDenylistDecision;
  /** Present iff refused and a comment/PATCH attempt was made. */
  postResult?: PostPreflightRefusalResult;
  /** Present iff config load failed; preflight is fail-open in that case. */
  configError?: string;
}

/**
 * Adapter entry point for ADR-0008 worker-fleet data-residency preflight.
 *
 * Behaviour:
 *  - Loads the canonical denylist (or uses the caller-supplied `config`).
 *  - Evaluates workspaceCwd + specBody against the rules.
 *  - On refuse: posts `[<worker>] BLOCKED by ADR-0008 …` comment to the issue,
 *    PATCHes the issue to `blocked`, logs to stderr, and returns
 *    `{ refused: true }`. The adapter caller MUST return its own
 *    `AdapterExecutionResult` without invoking the LLM SDK.
 *  - Fail-open when the config file is missing/malformed — layers 1 (AGENTS.md)
 *    and 3 (worktree jail) still apply, and we never want a broken config to
 *    take the whole fleet offline. The config error is logged loudly and
 *    surfaced on the result so observability can pick it up.
 */
export async function runAdapterPreflightDenylist(
  input: RunAdapterPreflightDenylistInput,
): Promise<RunAdapterPreflightDenylistResult> {
  const onLog = input.onLog;
  let config = input.config;
  let configError: string | undefined;
  if (!config) {
    const env = input.env ?? process.env;
    const configPath = input.configPath ?? resolvePreflightDenylistPath(env);
    try {
      config = await loadPreflightDenylistConfig(configPath);
    } catch (err) {
      configError = (err as Error).message ?? String(err);
      await onLog(
        "stderr",
        `[paperclip] preflight denylist: could not load config at ${configPath}: ${configError}. Continuing without preflight (layers 1 + 3 still apply).\n`,
      );
      return {
        refused: false,
        decision: { decision: "pass" },
        configError,
      };
    }
  }

  const decision = evaluatePreflightDenylist({
    workspaceCwd: input.workspaceCwd,
    specBody: input.specBody,
    config,
  });

  if (decision.decision === "pass") {
    return { refused: false, decision };
  }

  const unblockOwner = input.unblockOwner ?? "the assigning Lead";
  const commentBody = formatPreflightRefusalComment({
    workerName: input.agentName,
    decision,
    unblockOwner,
  });
  await onLog(
    "stderr",
    `[paperclip] ADR-0008 preflight REFUSED — rule=${decision.ruleId} evidence=${decision.evidence}. No LLM token will be spent.\n`,
  );

  let postResult: PostPreflightRefusalResult | undefined;
  if (input.apiUrl && input.authToken && input.issueId) {
    postResult = await postPreflightRefusal(
      {
        apiUrl: input.apiUrl,
        apiKey: input.authToken,
        issueId: input.issueId,
        commentBody,
      },
      input.fetchImpl ?? fetch,
    );
    if (postResult.errors.length > 0) {
      for (const err of postResult.errors) {
        await onLog("stderr", `[paperclip] preflight refusal post error: ${err}\n`);
      }
    }
  } else {
    await onLog(
      "stderr",
      `[paperclip] preflight refusal: cannot post comment (apiUrl=${input.apiUrl ? "set" : "missing"} authToken=${input.authToken ? "set" : "missing"} issueId=${input.issueId ?? "missing"}). Refusal comment body:\n${commentBody}\n`,
    );
  }

  return { refused: true, decision, postResult };
}
