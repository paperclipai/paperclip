#!/usr/bin/env node
/**
 * Multi-track token usage reconcile for one heartbeat run (read-only).
 * Uses Node stdlib HTTP only — same deps story as scripts/issue-run-forensics.mjs.
 *
 * Tracks:
 *   1. Paperclip orchestration slice — first adapter.invoke payload:
 *      prompt chars, promptMetrics, promptCacheCorrelation (not token counts).
 *   2. CLI / adapter usage — persisted on the run (`usageJson`):
 *      rawInputTokens (+ rawCached*) and/or session deltas + metadata.
 *   3. Vendor — Paperclip API does not return provider consoles; merge optional
 *      JSON (--vendor-json) or stderr from last chat.completions `usage`.
 *   4. Vendor dashboard billing export — CSV / JSON rows (--deepseek-detail-csv
 *      or --deepseek-detail-json-array), summed inside run time window ± buffer.
 *
 * Usage:
 *   node scripts/usage-token-reconcile.mjs --run-id <uuid>
 *   node scripts/usage-token-reconcile.mjs --run-id <uuid> --vendor-json ./vendor-usage.json
 *   node scripts/usage-token-reconcile.mjs --run-id <uuid> --vendor-json ./last-response.json \\
 *       --estimate-deepseek-v4-pro-cny
 *
 * DeepSeek docs: KV cache (+ hit/miss) https://api-docs.deepseek.com/zh-cn/guides/kv_cache
 *                 Pricing (per 1M tokens) https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * Env: PAPERCLIP_API_BASE, PAPERCLIP_AUTH
 * Optional DeepSeek V4 Pro CNY estimates (¥ per million tokens — override anytime):
 *   DEEPSEEKV4_PRO_INPUT_HIT_PER_MTY,
 *   DEEPSEEKV4_PRO_INPUT_MISS_PER_MTY,
 *   DEEPSEEKV4_PRO_OUTPUT_PER_MTY
 *
 * Console billing detail (exported CSV or JSON rows):
 *   --deepseek-detail-csv PATH
 *   --deepseek-detail-json-array PATH
 *   --deepseek-dashboard-buffer-min N   (default 8 clock skew ± minutes)
 *   --dashboard-cols time=0,prompt=7,completion=9,cny=11,hit=5,miss=6
 *         Keys: time | prompt | completion | cny | hit | miss
 *         Value: 0-based column index OR substring to match header.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--auth") out.auth = argv[++i];
    else if (a === "--events-limit") out.eventsLimit = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--vendor-json") out.vendorJson = argv[++i];
    else if (a === "--estimate-deepseek-v4-pro-cny") out.estimateDeepseekV4ProCny = true;
    else if (a === "--deepseek-detail-csv") out.deepseekDetailCsv = argv[++i];
    else if (a === "--deepseek-detail-json-array") out.deepseekDetailJsonArray = argv[++i];
    else if (a === "--deepseek-dashboard-buffer-min") out.deepseekDashboardBufferMin = argv[++i];
    else if (a === "--dashboard-cols") out.dashboardCols = argv[++i];
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
            reject(new Error(`HTTP ${res.statusCode} ${urlStr}\n${body.slice(0, 800)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${urlStr}: ${body.slice(0, 240)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {unknown} value */
function asNum(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Flatten { usage:{...}} or top-level-only vendor snippets for token reads. */
function mergedUsageFields(raw) {
  const r = asRecord(raw) ?? {};
  const nested = asRecord(r.usage);
  return nested ? { ...r, ...nested } : r;
}

/**
 * Normalize vendor export keys (OpenAI-shape, Anthropic dashboards, DeepSeek KV cache fields).
 */
function normalizeVendorTotals(obj) {
  const o = mergedUsageFields(obj);
  const promptCacheHit =
    asNum(o.prompt_cache_hit_tokens) ??
    asNum(o.promptCacheHitTokens) ??
    null;
  const promptCacheMiss =
    asNum(o.prompt_cache_miss_tokens) ??
    asNum(o.promptCacheMissTokens) ??
    null;
  const inputTokens =
    asNum(o.input_tokens) ??
    asNum(o.inputTokens) ??
    asNum(o.prompt_tokens) ??
    asNum(o.promptTokens) ??
    null;
  const outputTokens =
    asNum(o.output_tokens) ??
    asNum(o.outputTokens) ??
    asNum(o.completion_tokens) ??
    asNum(o.completionTokens) ??
    null;
  const cachedInputTokens =
    asNum(o.cache_read_input_tokens) ??
    asNum(o.cacheReadInputTokens) ??
    asNum(o.cached_input_tokens) ??
    asNum(o.cachedInputTokens) ??
    null;
  const hitMissSum =
    typeof promptCacheHit === "number" && typeof promptCacheMiss === "number"
      ? promptCacheHit + promptCacheMiss
      : null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    promptCacheHitTokens: promptCacheHit,
    promptCacheMissTokens: promptCacheMiss,
    promptTokensFromHitMissSum: hitMissSum,
  };
}

/** @param {unknown} eventsList */
function pickFirstAdapterInvoke(eventsList) {
  if (!Array.isArray(eventsList)) return null;
  const invokes = eventsList.filter((e) => e?.eventType === "adapter.invoke");
  invokes.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  return invokes[0] ?? null;
}

/** @param {Record<string, unknown> | null} payload */
function buildPaperclipTrack(payload) {
  if (!payload) {
    return {
      available: false,
      reason: "no adapter.invoke event on this run",
    };
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const pm = asRecord(payload.promptMetrics);
  const corr = asRecord(payload.promptCacheCorrelation);
  const roughEstimateTokensDiv4 = prompt.length > 0 ? Math.ceil(prompt.length / 4) : 0;
  return {
    available: true,
    kind: "orchestration_injection_visible_slice",
    note:
      "This is stdin / control-plane-visible prompt text for this invoke + metrics; not full worker session.",
    adapterType: typeof payload.adapterType === "string" ? payload.adapterType : null,
    command: typeof payload.command === "string" ? payload.command : null,
    promptChars_plain: prompt.length,
    promptMetrics: pm ? { ...pm } : null,
    promptCacheCorrelation: corr ? { ...corr } : null,
    roughEstimateTokens_promptChars_over_4_utf8_approx: roughEstimateTokensDiv4,
  };
}

/** @param {Record<string, unknown> | null} u */
function buildCliTrack(u) {
  if (!u) {
    return { available: false, reason: "run.usageJson is null" };
  }
  const hasAny =
    asNum(u.rawInputTokens) != null ||
    asNum(u.inputTokens) != null ||
    asNum(u.rawOutputTokens) != null ||
    asNum(u.outputTokens) != null ||
    asNum(u.rawCachedInputTokens) != null ||
    asNum(u.cachedInputTokens) != null;

  return {
    available: hasAny,
    kind: "cli_adapter_report_via_heartbeat_finalize",
    note:
      "From adapterResult.usage persisted on run.usageJson; may be session cumulative raw + optional delta.",
    usageSource: typeof u.usageSource === "string" ? u.usageSource : null,
    sessionReused: typeof u.sessionReused === "boolean" ? u.sessionReused : null,
    freshSession: typeof u.freshSession === "boolean" ? u.freshSession : null,
    sessionRotated: typeof u.sessionRotated === "boolean" ? u.sessionRotated : null,
    persistedSessionId: typeof u.persistedSessionId === "string" ? u.persistedSessionId : null,
    rawInputTokens: asNum(u.rawInputTokens),
    rawCachedInputTokens: asNum(u.rawCachedInputTokens),
    rawOutputTokens: asNum(u.rawOutputTokens),
    normalizedDelta_inputTokens: asNum(u.inputTokens),
    normalizedDelta_cachedInputTokens: asNum(u.cachedInputTokens),
    normalizedDelta_outputTokens: asNum(u.outputTokens),
    provider: typeof u.provider === "string" ? u.provider : null,
    model: typeof u.model === "string" ? u.model : null,
    costUsd: typeof u.costUsd === "number" ? u.costUsd : asNum(u.costUsd),
    billingType: typeof u.billingType === "string" ? u.billingType : null,
  };
}

function readEnvRates() {
  const hit = Number(process.env.DEEPSEEKV4_PRO_INPUT_HIT_PER_MTY ?? "0.025");
  const miss = Number(process.env.DEEPSEEKV4_PRO_INPUT_MISS_PER_MTY ?? "3");
  const out = Number(process.env.DEEPSEEKV4_PRO_OUTPUT_PER_MTY ?? "6");
  return {
    hitPerMt: Number.isFinite(hit) ? hit : 0.025,
    missPerMt: Number.isFinite(miss) ? miss : 3,
    outputPerMt: Number.isFinite(out) ? out : 6,
    docNote:
      "Defaults match DeepSeek public pricing page’s deepseek-v4-pro ‘2.5 折’ input hit/miss + output — update via env before relying on totals.",
  };
}

function estimateDeepSeekV4ProCny(hit, miss, completion) {
  const rates = readEnvRates();
  const h = asNum(hit) ?? 0;
  const m = asNum(miss) ?? 0;
  const c = asNum(completion) ?? 0;
  if (!(h > 0 || m > 0 || c > 0)) return null;

  const inpHitCNY = (h / 1e6) * rates.hitPerMt;
  const inpMissCNY = (m / 1e6) * rates.missPerMt;
  const outCNY = (c / 1e6) * rates.outputPerMt;
  const totalApprox = inpHitCNY + inpMissCNY + outCNY;
  return {
    assumptions: rates.docNote,
    ratesCNY_perMillionTokens: {
      input_cache_hit: rates.hitPerMt,
      input_cache_miss: rates.missPerMt,
      output: rates.outputPerMt,
    },
    portionsCNY: {
      input_cache_hit: round4(inpHitCNY),
      input_cache_miss: round4(inpMissCNY),
      output: round4(outCNY),
      total_approx: round4(totalApprox),
    },
    tokens_basis: {
      prompt_cache_hit_tokens: h || null,
      prompt_cache_miss_tokens: m || null,
      completion_tokens: c || null,
    },
  };
}

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

function buildVendorAlignmentInterpretation(cli, vendorTotals) {
  const lines = [];
  if (!vendorTotals || vendorTotals.promptCacheHitTokens == null || vendorTotals.promptCacheMissTokens == null) {
    lines.push(
      "DeepSeek alignment: paste last chat.completions `usage` (prompt_cache_hit_tokens + prompt_cache_miss_tokens) into --vendor-json.",
    );
    return lines;
  }
  const sum = vendorTotals.promptTokensFromHitMissSum;
  if (typeof sum === "number" && cli?.available && typeof cli.rawInputTokens === "number") {
    const drift = cli.rawInputTokens - sum;
    const absDrift = Math.abs(drift);
    if (absDrift <= Math.max(64, Math.floor(sum * 0.02))) {
      lines.push(
        `DeepSeek hit+miss sum (${sum.toLocaleString("en-US")}) ≈ usageJson.rawInputTokens (${cli.rawInputTokens.toLocaleString("en-US")}) — good single-call sanity.`,
      );
    } else if (cli.rawInputTokens >= sum && cli.rawInputTokens / sum > 1.05) {
      lines.push(
        `rawInput (${cli.rawInputTokens.toLocaleString("en-US")}) > DeepSeek prompt hit+miss (${sum.toLocaleString("en-US")}) — CLI metering may be session-cumulative vs one HTTP vendor response.`,
      );
    }
  }

  const inputTotal = vendorTotals.inputTokens;
  if (typeof inputTotal === "number" && typeof sum === "number" && Math.abs(inputTotal - sum) > 24) {
    lines.push(
      `Vendor prompt_tokens=${inputTotal} vs hit+miss sum=${sum} — check aggregation if CodeBuddy batches multiple upstream calls.`,
    );
  }

  return lines;
}

function buildInterpretation(pc, cli, vendorTotals) {
  const lines = [];

  lines.push(
    "These three slices are deliberately different units: chars (prompt) ≠ session tokens ≠ vendor billing breakdown.",
  );

  const dsLines = buildVendorAlignmentInterpretation(cli, vendorTotals ?? null);
  lines.push(...dsLines);

  if (!pc?.available) {
    lines.push("Track 1 missing: cannot compare prompt footprint to CLI.");
  } else if (cli?.available && typeof cli.rawInputTokens === "number" && cli.rawInputTokens > 0) {
    const approx = pc.roughEstimateTokens_promptChars_over_4_utf8_approx || 1;
    const ratio = cli.rawInputTokens / approx;
    if (ratio > 50) {
      lines.push(
        `Track 2 rawInputTokens (${cli.rawInputTokens.toLocaleString("en-US")}) ≫ rough prompt÷4 (${approx}). ` +
          "Expected when CodeBuddy/session holds massive history beyond stdin slice.",
      );
    } else if (ratio > 10) {
      lines.push(
        `rawInputTokens is ${ratio.toFixed(0)}× larger than rough stdin-token guess — likely extra channel / session.`,
      );
    }
  }

  if (cli?.usageSource === "session_delta") {
    lines.push("usageSource=session_delta: top-level inputTokens/outputTokens may be deltas vs prior run on same session.");
  }

  if (!cli?.available) {
    lines.push("Track 2 missing (no usageJson): adapter returned no countable usage for this terminal state.");
  }

  lines.push(
    "Track 3 vendor: reconcile only when --vendor-json merges a provider export row for the matching time-window / request.",
  );

  return lines;
}

function readVendorOptional(pathLike) {
  if (!pathLike) return null;
  const raw =
    pathLike === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(pathLike, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    console.error("--vendor-json must be valid JSON (object or totals only).");
    process.exit(2);
  }
}

function normalizeHeader(cell) {
  return String(cell ?? "").replace(/\uFEFF/g, "").trim();
}

/** RFC-style CSV splitter (handles quoted commas minimally). */
function splitCsvLine(line) {
  const result = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && c === ",") {
      result.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  result.push(cur.trim());
  return result;
}

function sniffSeparatedLineParts(line, preferTab) {
  const tabCt = (line.match(/\t/g) || []).length;
  const commaCt = (line.match(/,/g) || []).length;
  if (!preferTab && tabCt >= 2 && tabCt >= commaCt) return { sep: "\t", parts: line.split(/\t/).map((s) => s.trim()) };
  if (!preferTab && commaCt >= 2) return { sep: ",", parts: splitCsvLine(line) };
  if (tabCt >= 1) return { sep: "\t", parts: line.split(/\t/).map((s) => s.trim()) };
  return { sep: ",", parts: splitCsvLine(line) };
}

/** @returns {unknown} JSON array parsed from file path */
function readJsonArrayMandatory(pathLike) {
  const raw = fs.readFileSync(pathLike, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("--deepseek-detail-json-array file must contain a JSON array");
  return arr;
}

/** @returns {{ headers: string[], rows: string[][] }} */
function parseDashboardCsv(rawText, preferTab) {
  let text = String(rawText).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  let lines = text.split("\n").map((ln) => ln.trimEnd()).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  while (lines[0]?.startsWith("#")) lines.shift();
  while (lines.length && lines[lines.length - 1]?.startsWith("#")) lines.pop();

  let headerParsed = sniffSeparatedLineParts(lines.shift() ?? "", preferTab);
  const headers = headerParsed.parts.map(normalizeHeader);
  const sep = headerParsed.sep;
  const rows = [];
  for (const ln of lines) {
    let parts =
      sep === "\t"
        ? ln.split(/\t/).map((s) => s.trim())
        : splitCsvLine(ln).map((x) => x.trim());
    if (parts.length === 1 && parts[0] === "") continue;
    if (parts.every((x) => !x)) continue;
    if (parts.length < headers.length) {
      parts = [...parts, ...Array(headers.length - parts.length).fill("")];
    }
    rows.push(parts);
  }
  return { headers, rows };
}

/** @returns {{ headers: string[], rows: string[][] }} */
function jsonArrayRowsToGrid(rows) {
  if (!rows.length) return { headers: [], rows: [] };
  const hdrSet = new Set();
  for (const r of rows) {
    if (typeof r === "object" && r !== null && !Array.isArray(r))
      Object.keys(/** @type {Record<string, unknown>} */ (r)).forEach((k) => hdrSet.add(String(k)));
  }
  const headers = [...hdrSet];
  /** @type {string[][]} */
  const grid = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
    const o = /** @type {Record<string, unknown>} */ (r);
    grid.push(headers.map((k) => (o[k] != null ? String(o[k]).trim() : "")));
  }
  return { headers, rows: grid };
}

function parseLooseCountToken(cell) {
  const s = String(cell ?? "").replace(/[,，\s]/g, "").replace(/[^\d.\-]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(Math.abs(n)) : null;
}

function parseLooseMoneyCny(cell) {
  const sraw = String(cell ?? "").trim();
  if (!sraw) return null;
  const s = sraw.replace(/[,，]/g, "").replace(/[¥￥\s]/g, "").replace(/元$/i, "");
  const n = Number(s.replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseFlexibleTimeMs(cell) {
  const raw = normalizeHeader(cell).replace(/^["']|["']$/g, "");
  if (!raw) return NaN;

  let t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;

  const normalized = raw.replace(/\//g, "-").replace(" ", "T");
  t = Date.parse(normalized);
  if (!Number.isNaN(t)) return t;

  const n = Number(raw);
  if (Number.isFinite(n) && n > 5e11) return n;

  return NaN;
}

function normalizeDashboardOverrideKey(part) {
  const s = String(part).trim().toLowerCase();
  if (s === "time" || s === "timestamp" || s === "datetime" || s === "t") return "time";
  if (s === "prompt" || s === "input" || s === "in" || s === "prompt_tokens") return "prompt";
  if (s === "completion" || s === "output" || s === "out" || s === "completion_tokens") return "completion";
  if (s === "hit" || s === "cache_hit" || s === "cachehit") return "hit";
  if (s === "miss" || s === "cache_miss" || s === "cachemiss") return "miss";
  if (s === "cny" || s === "amount" || s === "cost" || s === "fee" || s === "money") return "cny";
  return null;
}

function parseDashboardColsSpec(specStr) {
  if (!specStr || typeof specStr !== "string") return null;
  /** @type {Record<string, string | number>} */
  const raw = {};
  for (const part of specStr.split(",")) {
    const idxEq = part.indexOf("=");
    if (idxEq <= 0) continue;
    const k = normalizeDashboardOverrideKey(part.slice(0, idxEq).trim());
    const vs = part.slice(idxEq + 1).trim();
    if (!k) continue;
    if (/^-?\d+$/.test(vs)) raw[k] = parseInt(vs, 10);
    else raw[k] = vs;
  }
  return Object.keys(raw).length > 0 ? raw : null;
}

function resolveColumnIndex(headers, spec) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec === "number") {
    if (spec >= 0 && spec < headers.length) return spec;
    return null;
  }
  const needle = String(spec).toLowerCase().trim();
  return headers.findIndex((h) => normalizeHeader(h).toLowerCase().includes(needle));
}

function guessDashboardIndices(headers) {
  /** @type {Record<string, number>} */
  const out = {};

  headers.forEach((cell, idx) => {
    const h = normalizeHeader(cell);
    if (!h) return;
    const low = h.toLowerCase();

    const take = (key) => {
      if (!(key in out)) out[key] = idx;
    };

    const isTimeHint =
      /时间|創建時間|創建时间|创建于|發生時間|時間戳|時間戳記|時間戳记|日期|時間|时刻/.test(h) ||
      (/\bdatetime\b|\btimestamp\b|\bcreation\b\s*time\b/i.test(low) &&
        !/tok/i.test(low));
    const isTokenTime = /token.*時間|時間.*tok/i.test(h);
    if (isTimeHint && !isTokenTime) take("time");

    const isPromptCells =
      /prompt.*tok|计费.*prompt|计费输入|计费.?输入|\binput\s*tokens?\b|提示.*令牌|上下文.*令牌|输入.?tokens|\bprompt.?tok/i.test(low) ||
      /\binput.?tok/i.test(low) ||
      (/^prompt$/i.test(h.trim()) && !/completion/i.test(h));
    const isOutputCells =
      /completion.*tokens?|输出.?tokens|\boutput\s*tokens?/i.test(h) ||
      (/^completion$/i.test(h.trim()) || /^output.?tok/i.test(low));
    const hitCell =
      /cache.?hit|\b(kv|硬盘)?缓存.?命中\b|prompt_cache_hit|缓存命中|^hit$/i.test(h) || /\bhits?\s*tokens?\b/i.test(low);
    const missCell =
      /cache.?miss|\b未命中\b|prompt_cache_miss|缓存未命中|^miss\b/i.test(h) ||
      /\bmiss(es)?\s*tokens?\b/i.test(low);
    const amtCell =
      /([¥￥]|元(\s|$))|人民币|cny|rmb|扣费.?金额|\b总价\b|^金额$|应付|费用|consumption|^price$/i.test(h) ||
      (/cost|amount|fee|charge/i.test(low) && !/token/i.test(low));

    if (isPromptCells) take("prompt");
    if (isOutputCells) take("completion");
    if (hitCell) take("hit");
    if (missCell) take("miss");
    if (amtCell) take("cny");
  });

  return out;
}

/** @returns {Record<string, number | null>} */
function planDashboardIndices(headers, colOverrides) {
  const guess = guessDashboardIndices(headers);
  const ov = colOverrides ?? {};
  const pick = (
    /** @type {"time"|"prompt"|"completion"|"hit"|"miss"|"cny"} */ key,
    /** @type {string|number|null|undefined} */ specOverride,
  ) => {
    if (specOverride !== undefined && specOverride !== null) return resolveColumnIndex(headers, specOverride);
    const g = guess[key];
    return g !== undefined ? g : null;
  };

  return {
    time: pick("time", ov.time),
    promptTokens: pick("prompt", ov.prompt),
    completionTokens: pick("completion", ov.completion),
    promptHit: pick("hit", ov.hit),
    promptMiss: pick("miss", ov.miss),
    amountCny: pick("cny", ov.cny ?? ov.amount),
  };
}

/** @typedef {{ kind: string, source?: string|null, note?: string, available:false }} DashUnavailable */

/**
 * @param {object} opts
 * @param {unknown} opts.run Paperclip heartbeat run JSON
 */
function mergeDeepseekBillingDashboard(opts) {
  const {
    csvPath,
    jsonArrayPath,
    run,
    bufferMinutes = 8,
    dashboardColsRaw,
    sumAllRowsWithoutTimeColumn = false,
  } = opts;

  if (csvPath && jsonArrayPath) {
    return {
      kind: "deepseek_dashboard_billing_detail",
      available: false,
      reason: "pass only one of --deepseek-detail-csv or --deepseek-detail-json-array",
    };
  }
  /** @type {string | undefined} */
  let billingDetailPath = csvPath ?? jsonArrayPath;
  /** @type {"csv"|"json-array"} */
  let format = csvPath ? "csv" : "json-array";
  if (!billingDetailPath) {
    return { kind: "deepseek_dashboard_billing_detail", available: false, reason: "no export path" };
  }

  const overrides = parseDashboardColsSpec(dashboardColsRaw ?? "");

  let headers;
  let rows;

  try {
    if (format === "csv") {
      const text = fs.readFileSync(billingDetailPath, "utf8");
      const prefTab = /\.tsv\b/i.test(billingDetailPath);
      const parsed = parseDashboardCsv(text, prefTab);
      headers = parsed.headers;
      rows = parsed.rows;
    } else {
      const arr = readJsonArrayMandatory(billingDetailPath);
      const g = jsonArrayRowsToGrid(arr);
      headers = g.headers;
      rows = g.rows;
    }
  } catch (err) {
    return {
      kind: "deepseek_dashboard_billing_detail",
      available: false,
      format,
      source: billingDetailPath,
      reason: String(err instanceof Error ? err.message : err),
    };
  }

  if (!headers.length || !rows.length) {
    return {
      kind: "deepseek_dashboard_billing_detail",
      available: false,
      format,
      source: billingDetailPath,
      reason: "empty CSV/JSON rows after parse",
      columnHeadersSample: headers,
    };
  }

  const plan = planDashboardIndices(headers, overrides);

  const startedAt = run.startedAt ?? run.createdAt ?? null;
  const finishedAt = run.finishedAt ?? run.startedAt ?? run.createdAt ?? null;
  const startMsRaw = parseFlexibleTimeMs(String(startedAt ?? ""));
  const endMsRaw = parseFlexibleTimeMs(String(finishedAt ?? ""));
  const buf = Math.min(720, Math.max(0, Number(bufferMinutes) || 0)) * 60 * 1000;
  const windowStart = Number.isNaN(startMsRaw) ? null : startMsRaw - buf;
  const windowEnd = Number.isNaN(endMsRaw) ? null : endMsRaw + buf;

  if (plan.time == null && !sumAllRowsWithoutTimeColumn) {
    return {
      kind: "deepseek_dashboard_billing_detail",
      available: false,
      format,
      source: billingDetailPath,
      reason:
        'Could not infer "time" column — add --dashboard-cols time=N or substring, or paste header row snippet and retry.',
      columnHeadersSample: headers.slice(0, 24),
    };
  }

  let matched = 0;
  /** @type {Record<string, number>} */
  const sums = {
    promptTokens: 0,
    completionTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    amountCny: 0,
  };
  let amountRows = 0;

  for (const row of rows) {
    let inWindow = false;
    if (plan.time === null || sumAllRowsWithoutTimeColumn) inWindow = true;
    else {
      const tc = normalizeHeader(row[plan.time] ?? "");
      const tms = parseFlexibleTimeMs(tc);
      if (Number.isNaN(tms) || windowStart === null || windowEnd === null) continue;
      if (tms < windowStart || tms > windowEnd) continue;
      inWindow = true;
    }
    if (!inWindow) continue;
    matched += 1;

    if (plan.promptTokens != null) sums.promptTokens += parseLooseCountToken(row[plan.promptTokens] ?? "") ?? 0;
    if (plan.completionTokens != null)
      sums.completionTokens += parseLooseCountToken(row[plan.completionTokens] ?? "") ?? 0;
    if (plan.promptHit != null) sums.promptCacheHitTokens += parseLooseCountToken(row[plan.promptHit] ?? "") ?? 0;
    if (plan.promptMiss != null)
      sums.promptCacheMissTokens += parseLooseCountToken(row[plan.promptMiss] ?? "") ?? 0;
    if (plan.amountCny != null) {
      const v = parseLooseMoneyCny(row[plan.amountCny] ?? "");
      if (typeof v === "number" && Number.isFinite(v)) {
        sums.amountCny += v;
        amountRows += 1;
      }
    }
  }

  /** @type { Record<string,string|null>} */
  const headerNamesResolved = {};

  headerNamesResolved.time = plan.time != null ? headers[plan.time] ?? null : null;
  headerNamesResolved.prompt_tokens = plan.promptTokens != null ? headers[plan.promptTokens] ?? null : null;
  headerNamesResolved.completion_tokens =
    plan.completionTokens != null ? headers[plan.completionTokens] ?? null : null;
  headerNamesResolved.cache_hit = plan.promptHit != null ? headers[plan.promptHit] ?? null : null;
  headerNamesResolved.cache_miss = plan.promptMiss != null ? headers[plan.promptMiss] ?? null : null;
  headerNamesResolved.amount_cny = plan.amountCny != null ? headers[plan.amountCny] ?? null : null;

  return {
    kind: "deepseek_dashboard_billing_detail",
    available: true,
    note:
      "Sums CSV/JSON rows whose time falls in run.startedAt..finishedAt ± bufferMinutes (timezone must match CSV). Columns are heuristic — use --dashboard-cols when autodetect is wrong.",
    format,
    source: billingDetailPath,
    bufferMinutesApplied: Number(bufferMinutes) || 0,
    timeWindowUtc: {
      rawRunStartedAt: startedAt ?? null,
      rawRunFinishedAt: finishedAt ?? null,
      matchedFromInclusive: windowStart !== null ? new Date(windowStart).toISOString() : null,
      matchedThroughInclusive: windowEnd !== null ? new Date(windowEnd).toISOString() : null,
    },
    matchedRowCount: matched,
    totalParsedRowCount: rows.length,
    columnIndices: plan,
    columnHeadersResolved: headerNamesResolved,
    summed: {
      promptTokensSummedRows: sums.promptTokens,
      completionTokensSummedRows: sums.completionTokens,
      promptCacheHitTokensSummedRows: sums.promptCacheHitTokens,
      promptCacheMissTokensSummedRows: sums.promptCacheMissTokens,
      billedAmountCnySummedRows_ifColumnDetected: sums.amountCny,
      billedAmountContributingRows: amountRows,
    },
  };
}

function interpretDashboardExport(dashboard, cliTrack) {
  const lines = [];
  if (!dashboard || dashboard.available !== true) {
    lines.push(`Dashboard CSV/JSON overlay: unavailable — ${dashboard?.reason ?? "not passed"}.`);
    return lines;
  }
  lines.push(
    `Dashboard export: summed ${dashboard.matchedRowCount} rows (of ${dashboard.totalParsedRowCount} parsed) inside ±${dashboard.bufferMinutesApplied} minutes of run.`,
  );
  if (dashboard.matchedRowCount === 0 && dashboard.totalParsedRowCount > 0) {
    lines.push(
      "Zero billing rows landed in window — widen --deepseek-dashboard-buffer-min or confirm CSV timestamps use the same clock as heartbeat run timestamps.",
    );
  }
  if (dashboard.columnHeadersResolved.time) lines.push(`Time column heuristic: "${dashboard.columnHeadersResolved.time}".`);
  const outSum = dashboard.summed.completionTokensSummedRows;
  if (
    cliTrack?.available &&
    typeof cliTrack.rawOutputTokens === "number" &&
    typeof outSum === "number" &&
    dashboard.matchedRowCount > 0 &&
    outSum >= 1 &&
    cliTrack.rawOutputTokens >= 1
  ) {
    const absDrift = Math.abs(cliTrack.rawOutputTokens - outSum);
    if (absDrift <= Math.max(32, Math.floor(outSum * 0.06))) {
      lines.push(
        `usageJson.rawOutputTokens (${cliTrack.rawOutputTokens}) ≈ summed dashboard completion column (${outSum}) for window — looks aligned.`,
      );
    } else if (outSum > cliTrack.rawOutputTokens * 1.15 || outSum < cliTrack.rawOutputTokens / 15) {
      lines.push(
        `Summed dashboard output tokens (${outSum}) vs usageJson.rawOutputTokens (${cliTrack.rawOutputTokens}) — window may aggregate multiple hops or column mapping may be off.`,
      );
    }
  }

  const inSumDashboard = dashboard.summed.promptTokensSummedRows;
  if (
    cliTrack?.available &&
    typeof cliTrack.rawInputTokens === "number" &&
    typeof inSumDashboard === "number" &&
    inSumDashboard > 0 &&
    dashboard.matchedRowCount > 0
  ) {
    const drift = cliTrack.rawInputTokens - inSumDashboard;
    if (Math.abs(drift) > Math.max(256, Math.floor(inSumDashboard * 0.12))) {
      lines.push(
        `rawInputTokens (${cliTrack.rawInputTokens.toLocaleString("en-US")}) vs summed dashboard prompt-ish column (${inSumDashboard.toLocaleString("en-US")}) — differs if CSV counts per-hop or wrong column.`,
      );
    }
  }

  lines.push(
    "If timestamps do not overlap, widen `--deepseek-dashboard-buffer-min` or fix timezone in the export.",
  );

  lines.push(`Resolved CSV/JSON titles: ${JSON.stringify(dashboard.columnHeadersResolved ?? {})}`);
  return lines;
}

function printHelp() {
  console.log(`
Paperclip heartbeat run usage reconcile (+ optional billing export overlay).

  node scripts/usage-token-reconcile.mjs --run-id <heartbeatRunUuid>

Optional:
  --base URL               (default: PAPERCLIP_API_BASE or http://127.0.0.1:3100)
  --auth "Bearer …"
  --events-limit N         (default 500)
  --json                   (machine-readable only)
  --vendor-json PATH|-     DeepSeek/OpenAI-shape JSON ({ usage:{...}} or flattened)
  --estimate-deepseek-v4-pro-cny   approximate CNY (needs hit/miss/output in vendor-json)
  --deepseek-detail-csv PATH      DeepSeek billing detail export (comma/tsv heuristic)
  --deepseek-detail-json-array PATH    JSON array of row objects from console/API export
  --deepseek-dashboard-buffer-min N (default 8)
  --dashboard-cols time=0,prompt=7,completion=9,cny=11...

Env: PAPERCLIP_API_BASE, PAPERCLIP_AUTH
DeepSeek V4 Pro default ¥/M-token rates: DEEPSEEKV4_PRO_INPUT_HIT_PER_MTY (0.025),
  DEEPSEEKV4_PRO_INPUT_MISS_PER_MTY (3), DEEPSEEKV4_PRO_OUTPUT_PER_MTY (6)
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const runId = args.runId;
  if (!runId) {
    printHelp();
    process.exit(1);
  }

  const base = (args.base || process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3100").replace(/\/$/, "");
  const auth = args.auth || process.env.PAPERCLIP_AUTH || "";
  const eventsLimit = Math.min(500, Math.max(1, parseInt(args.eventsLimit ?? "500", 10) || 500));

  const [run, events] = await Promise.all([
    requestJson(`${base}/api/heartbeat-runs/${runId}`, { auth: auth || undefined }),
    requestJson(`${base}/api/heartbeat-runs/${runId}/events?limit=${eventsLimit}`, { auth: auth || undefined }),
  ]);

  const invoke = pickFirstAdapterInvoke(events);
  const invokePayload =
    invoke && typeof invoke.payload === "object" && invoke.payload !== null && !Array.isArray(invoke.payload)
      ? /** @type {Record<string, unknown>} */ (invoke.payload)
      : null;

  const paperclip = buildPaperclipTrack(invokePayload);
  const usageJson =
    run.usageJson && typeof run.usageJson === "object" && !Array.isArray(run.usageJson)
      ? /** @type {Record<string, unknown>} */ (run.usageJson)
      : null;
  const cli = buildCliTrack(usageJson);

  const dashBufParsed = Number.parseInt(String(args.deepseekDashboardBufferMin ?? "8"), 10);
  const dashBufferMin = Number.isFinite(dashBufParsed) ? Math.min(720, Math.max(0, dashBufParsed)) : 8;
  const dashboardBilling = mergeDeepseekBillingDashboard({
    csvPath: args.deepseekDetailCsv,
    jsonArrayPath: args.deepseekDetailJsonArray,
    run,
    bufferMinutes: dashBufferMin,
    dashboardColsRaw: typeof args.dashboardCols === "string" ? args.dashboardCols : "",
  });

  let vendor = null;
  if (args.vendorJson) {
    const raw = readVendorOptional(args.vendorJson);
    vendor = {
      available: true,
      kind: "operator_supplied_vendor_export",
      totals: normalizeVendorTotals(raw),
      rawTopLevelKeys: raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw).slice(0, 48) : [],
    };
  } else {
    vendor = {
      available: false,
      reason:
        "not merged (pass --vendor-json with dashboard export totals for manual third-track alignment)",
    };
  }

  const vendorTotals = vendor.available && vendor.totals ? vendor.totals : null;
  const deepseekEstimate =
    args.estimateDeepseekV4ProCny && vendorTotals
      ? estimateDeepSeekV4ProCny(
          vendorTotals.promptCacheHitTokens,
          vendorTotals.promptCacheMissTokens,
          vendorTotals.outputTokens,
        )
      : null;

  const interpretation = buildInterpretation(paperclip, cli, vendorTotals);

  interpretation.push(...interpretDashboardExport(dashboardBilling, cli));

  if (args.estimateDeepseekV4ProCny && !deepseekEstimate) {
    interpretation.push(
      "No approximate CNY: need vendor-json with DeepSeek-style usage fields (prompt_cache_hit_tokens + prompt_cache_miss_tokens, plus completion_tokens for output tier).",
    );
  }

  /** @type {Record<string, unknown>} */
  const out = {
    runId,
    runStatus: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    adapterTypeVisibleOnRun:
      invokePayload && typeof invokePayload.adapterType === "string" ? invokePayload.adapterType : run.adapterType ?? null,
    adapterInvokeSeq: invoke?.seq ?? null,
    track1_paperclip_orchestration: paperclip,
    track2_cliAdapter_usageJson: cli,
    track3_vendor: vendor,
    ...(deepseekEstimate ? { deepseek_v4_pro_estimate_cny_approx: deepseekEstimate } : {}),
    track4_deepseek_dashboard_billing_export: dashboardBilling,
    interpretation,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n# Usage reconcile · run ${runId}\n`);
  console.log(`status=${run.status} finishedAt=${run.finishedAt ?? ""}\n`);
  console.log("## Track 1 — Paperclip (first adapter.invoke)\n");
  console.log(JSON.stringify(paperclip, null, 2));
  console.log("\n## Track 2 — CLI / usageJson\n");
  console.log(JSON.stringify(cli, null, 2));
  console.log("\n## Track 3 — Vendor (`--vendor-json`)\n");
  console.log(JSON.stringify(vendor, null, 2));
  console.log("\n## Track 4 — DeepSeek 控制台导出 (`--deepseek-detail-csv|json-array`)\n");
  console.log(JSON.stringify(dashboardBilling, null, 2));
  if (deepseekEstimate) {
    console.log("\n## DeepSeek V4 Pro · approximate CNY (non-authoritative)\n");
    console.log(JSON.stringify(deepseekEstimate, null, 2));
  }
  console.log("\n## Interpretation\n");
  for (const line of interpretation) console.log(`- ${line}`);
  console.log("");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
