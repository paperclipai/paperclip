#!/usr/bin/env node
// leak-check shim entry. Spawned per-invocation by the bash wrappers
// `gh`/`git` materialized in the shim dir by `host.ts`. Receives:
//
//   node shim-entry.mjs <tool> <...realArgs>
//
// Behavior:
//   1. Parse argv to identify any "scan targets" (body/title/message bodies)
//   2. If no targets — exec real <tool> unchanged.
//   3. Resolve each target to its concrete text (read file / read stdin).
//   4. Pipe each to PAPERCLIP_LEAK_CHECK_SCRIPT (resolved from env). If any
//      target returns non-zero AND --allow-leak-OK was not honored, refuse
//      to exec real <tool>, post an audit comment to Paperclip, exit 1.
//   5. Otherwise exec real <tool>.
//
// Env contract (set by host.ts):
//   PAPERCLIP_LEAK_CHECK_SCRIPT       — abs path to company leak-check.sh
//   PAPERCLIP_LEAK_CHECK_SHIM_DIR     — abs path to this shim dir
//                                       (removed from PATH when exec'ing real)
//   PAPERCLIP_LEAK_OVERRIDE           — "1" if --allow-leak-OK is honored
//   PAPERCLIP_TASK_ID, PAPERCLIP_RUN_ID, PAPERCLIP_API_URL,
//   PAPERCLIP_API_KEY                  — for audit-log POST

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseGhArgs, parseGitArgs } from "./parse.mjs";

const [, , tool, ...realArgs] = process.argv;

if (!tool || (tool !== "gh" && tool !== "git")) {
  process.stderr.write(
    `paperclip leak-check shim: unknown tool "${String(tool)}". This shim is invoked via gh/git wrappers — direct invocation is not supported.\n`,
  );
  process.exit(2);
}

run().catch((err) => {
  process.stderr.write(`paperclip leak-check shim crashed: ${err?.stack || err?.message || String(err)}\n`);
  // Fail closed: refuse the publish if our shim crashes mid-way.
  process.exit(70);
});

async function run() {
  const parsed = tool === "gh" ? parseGhArgs(realArgs) : parseGitArgs(realArgs);

  if (parsed.scanTargets.length === 0) {
    return execReal(tool, parsed, { stdinBuffer: null });
  }

  const leakCheckScript = process.env.PAPERCLIP_LEAK_CHECK_SCRIPT ?? "";
  if (!leakCheckScript || !existsSync(leakCheckScript)) {
    process.stderr.write(
      `paperclip leak-check shim: PAPERCLIP_LEAK_CHECK_SCRIPT is unset or missing (${leakCheckScript || "<empty>"}). Refusing to publish.\n`,
    );
    process.exit(71);
  }

  // Resolve each scan target to a text body. If any target is "stdin" we
  // drain stdin once and reuse the captured buffer for all stdin targets;
  // on the clean path we re-feed this buffer to the real tool because the
  // parent's stdin has already been consumed.
  let stdinBuffer = null;
  const resolved = [];
  for (const target of parsed.scanTargets) {
    try {
      if (target.kind === "stdin") {
        if (stdinBuffer === null) {
          stdinBuffer = await readAllStdin();
        }
        resolved.push({ target, text: stdinBuffer });
      } else {
        const text = await resolveTargetToText(target);
        resolved.push({ target, text });
      }
    } catch (err) {
      process.stderr.write(
        `paperclip leak-check shim: could not read scan target "${target.source}": ${err?.message || String(err)}\n`,
      );
      process.exit(72);
    }
  }

  // Empty-body targets (e.g. an empty --body "") pass through.
  const nonEmpty = resolved.filter(({ text }) => text.length > 0);
  if (nonEmpty.length === 0) {
    return execReal(tool, parsed, { stdinBuffer });
  }

  const overrideEnv = (process.env.PAPERCLIP_LEAK_OVERRIDE ?? "").trim() === "1";
  const allowOverride = parsed.hasAllowOverride && overrideEnv;

  const blocked = [];
  for (const { target, text } of nonEmpty) {
    const verdict = await runLeakCheck(leakCheckScript, text, { allowOverride });
    if (verdict.kind === "error") {
      // bash itself failed to spawn (ENOENT/EACCES on the bash binary,
      // policy script with a corrupt shebang, etc). Refuse to publish.
      // existsSync(leakCheckScript) only proves the file exists, not that
      // the interpreter is callable.
      process.stderr.write(
        `paperclip leak-check shim: policy script failed to run — refusing to publish. ${verdict.message}\n`,
      );
      if (verdict.stderr) process.stderr.write(verdict.stderr);
      process.exit(73);
    }
    if (verdict.kind === "blocked") {
      blocked.push({ target, text, verdict });
    }
  }

  if (blocked.length === 0) {
    return execReal(tool, parsed, { stdinBuffer });
  }

  await reportBlocked(tool, parsed, blocked);
  process.exit(1);
}

/** @param {{ kind: "string"|"file"|"stdin", source: string, value?: string, path?: string }} target */
async function resolveTargetToText(target) {
  if (target.kind === "string") return target.value ?? "";
  if (target.kind === "file") {
    return readFileSync(target.path, "utf8");
  }
  if (target.kind === "stdin") {
    return await readAllStdin();
  }
  return "";
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
    // If stdin is a TTY (no piped input), end immediately.
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

/**
 * @param {string} script
 * @param {string} body
 * @param {{ allowOverride: boolean }} opts
 */
async function runLeakCheck(script, body, opts) {
  const args = [];
  if (opts.allowOverride) args.push("--allow-leak-OK");
  args.push("-");
  const proc = spawnSync("bash", [script, ...args], {
    input: body,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (proc.error) {
    return {
      kind: "error",
      message: `leak-check.sh failed to run: ${proc.error.message}`,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
    };
  }
  if ((proc.status ?? 0) === 0) {
    return { kind: "clean", stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
  }
  return {
    kind: "blocked",
    exitCode: proc.status,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

/**
 * Find the real `gh` or `git` binary by walking PATH and skipping our shim
 * dir. Returns null if not found.
 */
function resolveRealTool(toolName) {
  const shimDir = process.env.PAPERCLIP_LEAK_CHECK_SHIM_DIR
    ? path.resolve(process.env.PAPERCLIP_LEAK_CHECK_SHIM_DIR)
    : null;
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = PATH.split(sep).filter(Boolean);
  for (const entry of parts) {
    const resolvedEntry = (() => {
      try {
        return path.resolve(entry);
      } catch {
        return entry;
      }
    })();
    if (shimDir && resolvedEntry === shimDir) continue;
    const candidate = path.join(entry, toolName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * exec the real underlying tool, replacing our process. We use spawn with
 * inherited stdio + exitCode propagation rather than execve since Node has
 * no execve binding.
 *
 * If the original invocation pulled its body from stdin (e.g.
 * `gh pr create --body-file -`, `git commit -F -`), our parent has already
 * drained stdin into the leak-checker. We re-feed the captured buffer to
 * the spawned real tool via a piped stdin so the real tool sees the
 * original body bytes intact; otherwise the published body would be empty.
 *
 * @param {"gh"|"git"} toolName
 * @param {import("./parse.mjs").ParsedShimRequest} parsed
 * @param {{ stdinBuffer: string | null }} opts
 */
async function execReal(toolName, parsed, opts) {
  const realBin = resolveRealTool(toolName);
  if (!realBin) {
    process.stderr.write(
      `paperclip leak-check shim: cannot locate real "${toolName}" on PATH (shim dir was excluded). Refusing to fall through.\n`,
    );
    process.exit(127);
  }
  // We deliberately pass realArgs without the --allow-leak-OK flag (parse.mjs
  // stripped it) since real gh/git would reject it.
  const args = process.argv.slice(3).filter((a) => a !== "--allow-leak-OK");
  const stdinBuffer = opts?.stdinBuffer ?? null;
  const stdio = stdinBuffer !== null
    ? ["pipe", "inherit", "inherit"]
    : "inherit";
  const child = spawn(realBin, args, {
    stdio,
    env: process.env,
  });
  if (stdinBuffer !== null && child.stdin) {
    child.stdin.on("error", () => {
      // EPIPE: real tool may close stdin early (e.g. usage error). Ignore;
      // the exit code propagation below reports the actual failure.
    });
    child.stdin.end(stdinBuffer);
  }
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
  child.on("error", (err) => {
    process.stderr.write(`paperclip leak-check shim: failed to spawn real ${toolName}: ${err.message}\n`);
    process.exit(127);
  });
  void parsed;
}

/**
 * @param {"gh"|"git"} toolName
 * @param {import("./parse.mjs").ParsedShimRequest} parsed
 * @param {Array<{ target: any, text: string, verdict: any }>} blocked
 */
async function reportBlocked(toolName, parsed, blocked) {
  // Always surface the block to the agent first — that's the load-bearing
  // signal so they can rewrite and retry.
  process.stderr.write("\n");
  process.stderr.write(
    `paperclip leak-check: BLOCKED ${toolName} ${parsed.subCommand ?? ""}${parsed.verb ? " " + parsed.verb : ""} — refusing to publish because the body matches a Paperclip leak pattern.\n\n`,
  );
  for (const entry of blocked) {
    process.stderr.write(`Target: ${entry.target.source}\n`);
    process.stderr.write(entry.verdict.stdout || "");
    if (entry.verdict.stderr) {
      process.stderr.write(entry.verdict.stderr);
    }
    process.stderr.write("\n");
  }
  process.stderr.write(
    "Rewrite the body to remove internal references (paperclip.ing, SIE-<n>, /SIE/issues/...,\n" +
      "agent:// URIs, document/comment deep links, claude-prompt-cache paths) and retry.\n" +
      "An accepted board approval + PAPERCLIP_LEAK_OVERRIDE=1 with --allow-leak-OK is the only bypass.\n\n",
  );

  // Best-effort audit-log POST to the Paperclip issue. Failure here MUST
  // NOT bypass the block — we've already decided to exit 1.
  await postAuditComment(toolName, parsed, blocked).catch((err) => {
    process.stderr.write(
      `paperclip leak-check: audit-log POST failed (${err?.message || err}). Block stands.\n`,
    );
  });
}

async function postAuditComment(toolName, parsed, blocked) {
  const taskId = process.env.PAPERCLIP_TASK_ID;
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const runId = process.env.PAPERCLIP_RUN_ID;
  if (!taskId || !apiUrl || !apiKey) return;

  const targets = blocked.map((entry) => {
    const matchedLines = (entry.verdict.stdout || "")
      .split(/\r?\n/)
      .filter((line) => /:\w[\w-]*:/.test(line))
      .slice(0, 20);
    return {
      source: entry.target.source,
      matches: matchedLines,
    };
  });

  const lines = [];
  lines.push("## Leak-check blocked a customer-facing publish");
  lines.push("");
  lines.push(
    `Paperclip's adapter-level leak-check refused to forward \`${toolName} ${parsed.subCommand ?? ""}${parsed.verb ? " " + parsed.verb : ""}\` to the OS because the body matches a Paperclip leak pattern.`,
  );
  lines.push("");
  lines.push(`- Run: \`${runId ?? "<unknown>"}\``);
  lines.push(`- Tool: \`${toolName}\``);
  lines.push(`- Subcommand: \`${parsed.subCommand ?? ""}${parsed.verb ? " " + parsed.verb : ""}\``);
  lines.push("");
  for (const target of targets) {
    lines.push(`### ${target.source}`);
    if (target.matches.length === 0) {
      lines.push("(no per-line matches captured)");
    } else {
      lines.push("```");
      for (const match of target.matches) lines.push(match);
      lines.push("```");
    }
    lines.push("");
  }
  lines.push("The agent must rewrite the body and retry, or request a board-approved override.");

  const body = JSON.stringify({ body: lines.join("\n") });

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (runId) headers["X-Paperclip-Run-Id"] = runId;

  // Bound the audit-log POST so a slow/unreachable Paperclip API can't
  // hold up the agent's gh/git invocation indefinitely. The outer .catch
  // in reportBlocked swallows the timeout error and the block still stands.
  await fetch(`${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(taskId)}/comments`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5_000),
  });
}
