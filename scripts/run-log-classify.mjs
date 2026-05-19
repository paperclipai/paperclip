#!/usr/bin/env node
/**
 * Classify a heartbeat run log (read-only) — Paperclip persisted ndjson + CodeBuddy stream-json lines.
 * Does not parse full stdout blobs; walks run-log chunks only (aligns with long-term doc §7).
 *
 * Usage:
 *   node scripts/run-log-classify.mjs --run-id 8956f084
 *   node scripts/run-log-classify.mjs --run-id <full-uuid> --json
 *   node scripts/run-log-classify.mjs --log-file "C:\\...\\8956f084-....ndjson"
 *   node scripts/run-log-classify.mjs --run-id 8956f084 --markdown "docs/项目计划/验尸报告/8956f084 脚本解析结论.md"
 *
 * Env: PAPERCLIP_API_BASE (default http://127.0.0.1:4100), PAPERCLIP_AUTH (optional)
 *      PAPERCLIP_INSTANCE_ROOT (default ~/.paperclip/instances/default)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--log-file") out.logFile = argv[++i];
    else if (a === "--instance-root") out.instanceRoot = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--auth") out.auth = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--markdown") out.markdown = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function requestJson(urlStr, { auth } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const port = u.port || (u.protocol === "https:" ? 443 : 80);
    const req = lib.request(
      {
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(auth ? { Authorization: auth } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} ${urlStr}\n${body.slice(0, 600)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${urlStr}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function defaultInstanceRoot() {
  const env = process.env.PAPERCLIP_INSTANCE_ROOT;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), ".paperclip", "instances", "default");
}

function resolveLogFileByRunId(runIdNeedle, instanceRoot) {
  const logsRoot = path.join(instanceRoot, "data", "run-logs");
  if (!fs.existsSync(logsRoot)) return null;
  const needle = runIdNeedle.toLowerCase();
  const matches = [];

  function walk(dir) {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.isFile() && name.name.endsWith(".ndjson") && name.name.toLowerCase().includes(needle)) {
        matches.push(full);
      }
    }
  }

  walk(logsRoot);
  if (matches.length === 0) return null;
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

function inferRunIdFromLogPath(logFile) {
  const base = path.basename(logFile, ".ndjson");
  return /^[0-9a-f-]{36}$/i.test(base) ? base : null;
}

/** @param {string} logFile */
function readPersistedChunks(logFile) {
  const raw = fs.readFileSync(logFile, "utf8");
  const rows = [];
  for (const line of raw.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push({ ts: null, stream: "system", chunk: line, parseError: true });
    }
  }
  return rows;
}

/** @param {unknown} obj */
function asRecord(obj) {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj) ? obj : null;
}

const WRITE_TOOL_NAMES = new Set(["write", "edit", "multiedit", "notebookedit", "apply_patch"]);

/**
 * @param {Record<string, unknown>} obj CodeBuddy stream-json object
 */
function classifyCodeBuddyLine(obj) {
  const type = typeof obj.type === "string" ? obj.type : "";
  const subtype = typeof obj.subtype === "string" ? obj.subtype : "";

  if (type === "result") {
    const isError =
      obj.is_error === true ||
      subtype === "error" ||
      subtype === "failure";
    return { kind: isError ? "result_error" : "result", hint: subtype || null };
  }

  if (type === "system") {
    return { kind: "system", hint: subtype || null };
  }

  if (type === "user") {
    return { kind: "user", hint: null };
  }

  if (type === "file-history-snapshot") {
    return { kind: "write", hint: "file-history-snapshot" };
  }

  if (type === "assistant") {
    const message = asRecord(obj.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const kinds = [];
    const hints = [];
    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      const bt = typeof b.type === "string" ? b.type : "";
      if (bt === "thinking") kinds.push("think");
      else if (bt === "tool_use") {
        const name = typeof b.name === "string" ? b.name : "";
        if (WRITE_TOOL_NAMES.has(name.toLowerCase())) kinds.push("write");
        else kinds.push("tool");
        if (name) hints.push(name);
      } else if (bt === "text" || bt === "output_text") kinds.push("assistant");
    }
    if (kinds.length === 0) return { kind: "assistant", hint: null };
    const priority = ["tool", "write", "think", "assistant"];
    const kind = priority.find((k) => kinds.includes(k)) ?? kinds[0];
    return { kind, hint: hints.length ? hints.join(",") : null };
  }

  if (type) return { kind: "vendor", hint: subtype ? `${type}:${subtype}` : type };
  return { kind: "noise", hint: null };
}

/**
 * @param {Array<{ ts: string | null, stream: string, obj: Record<string, unknown> | null, raw: string }>} events
 */
function extractTerminalResult(events) {
  let last = null;
  for (const ev of events) {
    if (!ev.obj || ev.obj.type !== "result") continue;
    last = ev.obj;
  }
  return last;
}

function normalizeUsage(usage) {
  const u = asRecord(usage);
  if (!u) return null;
  return {
    input_tokens: u.input_tokens ?? u.inputTokens ?? null,
    output_tokens: u.output_tokens ?? u.outputTokens ?? null,
    cache_read_input_tokens: u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? null,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? null,
  };
}

/**
 * @param {ReturnType<typeof readPersistedChunks>} persisted
 */
function extractVendorEvents(persisted) {
  /** @type {Array<{ ts: string | null, stream: string, obj: Record<string, unknown> | null, raw: string, kind: string, hint: string | null }>} */
  const out = [];
  for (const row of persisted) {
    const ts = typeof row.ts === "string" ? row.ts : null;
    const stream = row.stream === "stderr" ? "stderr" : row.stream === "system" ? "system" : "stdout";
    const chunk = typeof row.chunk === "string" ? row.chunk : "";
    for (const piece of chunk.split(/\r?\n/)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("{")) {
        if (trimmed.startsWith("[paperclip]")) {
          out.push({ ts, stream, obj: null, raw: trimmed, kind: "paperclip", hint: null });
        }
        continue;
      }
      try {
        const obj = /** @type {Record<string, unknown>} */ (JSON.parse(trimmed));
        const { kind, hint } = classifyCodeBuddyLine(obj);
        out.push({ ts, stream, obj, raw: trimmed.slice(0, 240), kind, hint });
      } catch {
        out.push({ ts, stream, obj: null, raw: trimmed.slice(0, 120), kind: "noise", hint: "json_parse_error" });
      }
    }
  }
  return out;
}

function summarizeKinds(events) {
  const counts = {};
  for (const ev of events) {
    counts[ev.kind] = (counts[ev.kind] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function formatReport({ runId, logFile, runMeta, events, terminal }) {
  const lines = [];
  lines.push(`# Run log classify · ${runId}`);
  lines.push("");
  lines.push(`- **Log file:** \`${logFile}\``);
  lines.push(`- **Persisted rows:** ${readPersistedChunks(logFile).length}`);
  lines.push(`- **Vendor JSON lines:** ${events.length}`);
  if (runMeta) {
    lines.push(`- **Status:** ${runMeta.status ?? "—"}`);
    lines.push(`- **Adapter:** ${runMeta.adapterType ?? "—"}`);
    lines.push(`- **Exit code:** ${runMeta.exitCode ?? "—"}`);
    if (runMeta.startedAt) lines.push(`- **Started:** ${runMeta.startedAt}`);
    if (runMeta.finishedAt) lines.push(`- **Finished:** ${runMeta.finishedAt}`);
  }
  lines.push("");
  lines.push("## Line kinds (classify only, not translation)");
  lines.push("");
  lines.push("| kind | count |");
  lines.push("| --- | ---: |");
  for (const [kind, count] of summarizeKinds(events)) {
    lines.push(`| ${kind} | ${count} |`);
  }
  lines.push("");
  if (terminal) {
    const usage = normalizeUsage(terminal.usage);
    lines.push("## Terminal `type:result` (tail scan)");
    lines.push("");
    lines.push(`- **subtype:** ${terminal.subtype ?? "—"}`);
    lines.push(`- **is_error:** ${terminal.is_error === true}`);
    lines.push(`- **num_turns:** ${terminal.num_turns ?? "—"}`);
    lines.push(`- **session_id:** ${terminal.session_id ?? "—"}`);
    if (usage) {
      lines.push(`- **input_tokens:** ${usage.input_tokens ?? "—"}`);
      lines.push(`- **output_tokens:** ${usage.output_tokens ?? "—"}`);
      lines.push(`- **cache_read_input_tokens:** ${usage.cache_read_input_tokens ?? "—"}`);
    }
    const resultText = typeof terminal.result === "string" ? terminal.result.trim() : "";
    if (resultText) {
      lines.push("");
      lines.push("### result text (excerpt)");
      lines.push("");
      lines.push("```text");
      lines.push(resultText.slice(0, 1200));
      if (resultText.length > 1200) lines.push("…");
      lines.push("```");
    }
  } else {
    lines.push("## Terminal `type:result`");
    lines.push("");
    lines.push("_No complete `type:result` line found in run-log (check exit code on run row)._");
  }
  lines.push("");
  lines.push("## Tool names (from `tool_use` blocks)");
  lines.push("");
  const toolNames = {};
  for (const ev of events) {
    if (ev.kind !== "tool" && ev.kind !== "write") continue;
    if (!ev.hint) continue;
    for (const name of ev.hint.split(",")) {
      toolNames[name] = (toolNames[name] || 0) + 1;
    }
  }
  if (Object.keys(toolNames).length === 0) {
    lines.push("_None detected._");
  } else {
    lines.push("| tool | count |");
    lines.push("| --- | ---: |");
    for (const [name, count] of Object.entries(toolNames).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${name} | ${count} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function maybeFetchRunMeta(runId, base, auth) {
  try {
    return await requestJson(`${base}/api/heartbeat-runs/${runId}`, { auth: auth || undefined });
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node scripts/run-log-classify.mjs --run-id <uuid-or-prefix> [--log-file path] [--markdown out.md] [--json]`);
    process.exit(0);
  }

  const instanceRoot = path.resolve(args.instanceRoot ?? defaultInstanceRoot());
  const base = (args.base ?? process.env.PAPERCLIP_API_BASE ?? "http://127.0.0.1:4100").replace(/\/$/, "");
  const auth = args.auth ?? process.env.PAPERCLIP_AUTH ?? "";

  let logFile = args.logFile ? path.resolve(args.logFile) : null;
  let runId = args.runId ?? null;

  if (!logFile && !runId) {
    console.error("Provide --run-id or --log-file");
    process.exit(1);
  }

  if (!logFile) {
    logFile = resolveLogFileByRunId(runId, instanceRoot);
    if (!logFile) {
      console.error(`No run-log under ${path.join(instanceRoot, "data", "run-logs")} matching: ${runId}`);
      process.exit(1);
    }
  }

  if (!runId) runId = inferRunIdFromLogPath(logFile) ?? path.basename(logFile, ".ndjson");

  const persisted = readPersistedChunks(logFile);
  const events = extractVendorEvents(persisted);
  const terminal = extractTerminalResult(events);
  const runMeta = await maybeFetchRunMeta(runId, base, auth);

  const payload = {
    runId,
    logFile,
    persistedRows: persisted.length,
    vendorLines: events.length,
    kindCounts: Object.fromEntries(summarizeKinds(events)),
    terminal: terminal
      ? {
          subtype: terminal.subtype ?? null,
          is_error: terminal.is_error === true,
          num_turns: terminal.num_turns ?? null,
          session_id: terminal.session_id ?? null,
          usage: normalizeUsage(terminal.usage),
          resultExcerpt:
            typeof terminal.result === "string" ? terminal.result.trim().slice(0, 400) : null,
        }
      : null,
    run: runMeta
      ? {
          status: runMeta.status,
          adapterType: runMeta.adapterType,
          exitCode: runMeta.exitCode,
          errorCode: runMeta.errorCode,
          usageJson: runMeta.usageJson ?? null,
        }
      : null,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatReport({ runId, logFile, runMeta, events, terminal }));
  }

  if (args.markdown) {
    const md = formatReport({ runId, logFile, runMeta, events, terminal });
    fs.mkdirSync(path.dirname(path.resolve(args.markdown)), { recursive: true });
    fs.writeFileSync(path.resolve(args.markdown), md, "utf8");
    if (!args.json) console.error(`\nWrote ${path.resolve(args.markdown)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
