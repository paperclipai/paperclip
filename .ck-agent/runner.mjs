#!/usr/bin/env node
// CK agent runner — the native runtime behind every CK `process` agent on Paperclip.
// No legacy (no Hermes/Divino). On each heartbeat/run the server spawns this with:
//   PAPERCLIP_API_URL, PAPERCLIP_API_KEY (run-scoped bearer), PAPERCLIP_RUN_ID
// plus per-agent env we set in adapterConfig.env: CK_AGENT_NAME, CK_AGENT_ID (CK unit id),
// CK_AGENT_CHARTER (its one-job charter), CK_AGENT_MODE.
// The agent: reads its assigned Paperclip issue, deliberates via DeepSeek per its charter,
// and posts a work product back as an issue comment. It NEVER sends outward mail and NEVER
// touches money or the invention — outward/irreversible steps stay human-gated (board approves).
import { readFileSync } from "node:fs";
import { saveApprovalDeliverable } from "./approval-deliverable.mjs";
import { addDeepSeekUsage, emptyDeepSeekMeter } from "./deepseek-costing.mjs";
import {
  approvalQueueStopsRun,
  bindToolArguments,
  createToolRepeatGuard,
  dispositionForAgentResult,
  latestHumanRevisionFeedback,
  pendingHumanApproval,
  pluginToolExecutionContent,
} from "./runner-guardrails.mjs";
import {
  checkoutExpectedStatuses,
  pickWorkableIssue,
} from "./runner-selection.mjs";

const API = (process.env.CK_API_URL || process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const KEY = process.env.CK_PAPERCLIP_KEY || process.env.PAPERCLIP_API_KEY || "";
const RUN = process.env.PAPERCLIP_RUN_ID || "";
const NAME = process.env.CK_AGENT_NAME || "CK agent";
const CKID = process.env.CK_AGENT_ID || "";
const CHARTER = process.env.CK_AGENT_CHARTER || "";
const MODE = process.env.CK_AGENT_MODE || "";
const SKILLS = (process.env.CK_SKILLS || "").split(",").map((s) => s.trim()).filter(Boolean);
const SKILLS_DIR = process.env.CK_SKILLS_DIR || "/work/.ck-agent/skills";
const TOOLS = (process.env.CK_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
const DS_KEY_PATH = process.env.CK_DEEPSEEK_KEY_PATH || "/work/.ck-secrets/deepseek.key";
const MODEL = process.env.CK_MODEL || "deepseek-v4-pro";
const DEEPSEEK_TIMEOUT_MS = Math.max(15_000, Math.min(300_000, Number(process.env.CK_DEEPSEEK_TIMEOUT_MS) || 120_000));
const RUN_METER = emptyDeepSeekMeter();
const RUN_MODEL_METERS = new Map();

const log = (...a) => console.log(`[${CKID || NAME}]`, ...a);
let RUNID = RUN; // agent writes require X-Paperclip-Run-Id; discovered at runtime if the adapter didn't inject it
const readHeaders = { Authorization: `Bearer ${KEY}` };

function meteredRunnerSummary(extra = {}) {
  return {
    ck_runner: true,
    tokens: RUN_METER.inputTokens + RUN_METER.cachedInputTokens + RUN_METER.outputTokens,
    usage: {
      inputTokens: RUN_METER.inputTokens,
      cachedInputTokens: RUN_METER.cachedInputTokens,
      outputTokens: RUN_METER.outputTokens,
    },
    costUsd: RUN_METER.costUsd,
    costBreakdown: [...RUN_MODEL_METERS.entries()].map(([model, meter]) => ({
      provider: "deepseek",
      biller: "deepseek",
      billingType: "metered_api",
      model,
      usage: {
        inputTokens: meter.inputTokens,
        cachedInputTokens: meter.cachedInputTokens,
        outputTokens: meter.outputTokens,
      },
      costUsd: meter.costUsd,
    })),
    ...extra,
  };
}

function addRunDeepSeekUsage(model, usage) {
  addDeepSeekUsage(RUN_METER, model, usage);
  const modelMeter = RUN_MODEL_METERS.get(model) ?? emptyDeepSeekMeter();
  addDeepSeekUsage(modelMeter, model, usage);
  RUN_MODEL_METERS.set(model, modelMeter);
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers:
      method === "GET"
        ? readHeaders
        : { ...readHeaders, "Content-Type": "application/json", ...(RUNID ? { "X-Paperclip-Run-Id": RUNID } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

function deepseekKey() {
  try {
    return readFileSync(DS_KEY_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

async function deepseek(system, user, opts = {}) {
  const key = deepseekKey();
  if (!key) throw new Error(`no DeepSeek key at ${DS_KEY_PATH}`);
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model || MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens || 1100,
    }),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  addRunDeepSeekUsage(opts.model || MODEL, j.usage);
  return { text: j.choices?.[0]?.message?.content?.trim() || "", usage: j.usage || {} };
}

// Call a native CK plugin tool by short name via the plugin-tools execute API.
let _pluginToolCache = null;
async function pluginTool(shortName, params, runContext) {
  try {
    if (!_pluginToolCache) {
      const l = await api("GET", "/api/plugins/tools");
      _pluginToolCache = Array.isArray(l) ? l : l.tools || l.data || [];
    }
    const t = _pluginToolCache.find((x) => String(x.name || "").split(":").pop() === shortName);
    if (!t) return null;
    const ex = await api("POST", "/api/plugins/tools/execute", { tool: t.name, parameters: params, runContext });
    const c = ex?.result?.content ?? ex?.content;
    return typeof c === "string" ? JSON.parse(c) : ex?.result?.data ?? ex?.data ?? ex;
  } catch {
    return null;
  }
}

// Models often return confidence as "high"/"medium"/"low" or 0-100 instead of a 0-1 number. Coerce.
function coerceConfidence(c) {
  if (typeof c === "number") return c > 1 ? Math.min(1, c / 100) : Math.max(0, c);
  const s = String(c || "").toLowerCase().trim();
  if (/high|strong|certain|confirmed/.test(s)) return 0.85;
  if (/med|moderate/.test(s)) return 0.65;
  if (/low|weak|unsure/.test(s)) return 0.4;
  const n = parseFloat(s);
  return Number.isFinite(n) ? (n > 1 ? Math.min(1, n / 100) : n) : 0.65;
}

// After delivering, distil 0-3 DURABLE, VERIFIABLE facts worth remembering for future tasks.
async function extractMemories(workProduct, issueTitle) {
  const sys =
    "You extract DURABLE, VERIFIABLE, REUSABLE facts from an employee's completed work, for future tasks. " +
    "GOOD: a venue's confirmed contact/preference, a decided price/rule, a confirmed constraint, a fact about a specific account. " +
    "BAD: speculation, opinions, restating the task, generic advice. " +
    "Output ONLY a JSON array (max 3) of {key,value,confidence,scope}. key=short stable slug; confidence 0..1; " +
    "scope='company' (useful to all agents) or 'self' (your own note). Empty array [] if nothing durable.";
  try {
    const { text } = await deepseek(sys, `TASK: ${issueTitle}\n\nWORK PRODUCT:\n${workProduct.slice(0, 2000)}\n\nExtract now.`, {
      model: "deepseek-v4-flash",
      maxTokens: 700,
      temperature: 0.1,
    });
    const m = text.match(/\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : [];
  } catch {
    return [];
  }
}

// Discover the agent's allowlisted tools from Paperclip's NATIVE plugin-tool registry and run them via
// POST /api/plugins/tools/execute. No hardcoded tools — new plugin tools appear here automatically.
async function deepseekAgentic(system, user, toolNames, runContext) {
  const key = deepseekKey();
  if (!key) throw new Error(`no DeepSeek key at ${DS_KEY_PATH}`);
  const listed = await api("GET", "/api/plugins/tools").catch(() => []);
  const all = Array.isArray(listed) ? listed : listed.tools || listed.data || [];
  const allow = new Set(toolNames);
  const nameMap = new Map(); // model function name (unnamespaced) -> namespaced tool id
  const tools = [];
  for (const t of all) {
    const ns = String(t.name || "");
    const short = ns.split(":").pop();
    if (!allow.has(short) || nameMap.has(short)) continue;
    nameMap.set(short, ns);
    tools.push({ type: "function", function: { name: short, description: t.description || t.displayName || short, parameters: t.parametersSchema || { type: "object", properties: {} } } });
  }
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  let total = 0, calls = 0;
  const repeatGuard = createToolRepeatGuard(2);
  for (let iter = 0; iter < 30; iter++) {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 4000 }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    total += j.usage?.total_tokens || 0;
    addRunDeepSeekUsage(MODEL, j.usage);
    const m = j.choices[0].message; messages.push(m);
    if (m.tool_calls && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        let a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch { /* */ }
        a = bindToolArguments(tc.function.name, a, runContext);
        const ns = nameMap.get(tc.function.name) || tc.function.name;
        const signature = `${ns}:${JSON.stringify(a)}`;
        const repetition = repeatGuard.record(signature);
        let content;
        if (!repetition.execute) {
          content = JSON.stringify({
            error: "NO_PROGRESS_REPEAT",
            instruction: "This identical tool call already returned twice. Do not call it again. Complete the task using the issue dossier and evidence already available.",
          });
        } else {
          try {
            const ex = await api("POST", "/api/plugins/tools/execute", { tool: ns, parameters: a, runContext });
            content = pluginToolExecutionContent(ex);
          } catch (e) { content = JSON.stringify({ error: String(e).slice(0, 150) }); }
        }
        calls += 1;
        log(`tool ${ns}(${JSON.stringify(a).slice(0, 60)}) -> ${String(content).slice(0, 110)}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: String(content).slice(0, 4000) });
        if (tc.function.name === "queue_email_for_approval") {
          try {
            const queueResult = JSON.parse(String(content));
            if (approvalQueueStopsRun(tc.function.name, queueResult)) {
              return {
                text: "",
                usage: { total_tokens: total },
                toolCalls: calls,
                approvalQueued: true,
                approvalResult: queueResult,
                approvalDraft: {
                  to: a.to_email || a.to || "",
                  subject: a.subject || "",
                  body: a.body || a.draft_body || "",
                },
              };
            }
          } catch {
            // Non-JSON tool errors continue through the normal model recovery path.
          }
        }
      }
      continue;
    }
    const text = (m.content || "").trim();
    if (text) return { text, usage: { total_tokens: total }, toolCalls: calls };
    // Empty final content — the known DeepSeek v4 reasoning-model trap (all budget spent thinking,
    // none on output; killed CS-02 on CK-73 three times). Nudge once and continue the loop instead
    // of failing the whole run.
    log("model returned empty content — nudging once for plain-text output");
    messages.push({ role: "user", content: "Your previous message was empty. Write your complete work product NOW as plain text (no tool calls)." });
  }
  const partialDigest = messages
    .filter((m) => m.role === "tool" || (m.role === "assistant" && m.content))
    .slice(-8)
    .map((m) => {
      const role = m.role === "tool" ? "tool" : "assistant";
      const body = String(m.content || "").replace(/\s+/g, " ").trim();
      return body ? `[${role}] ${body.slice(0, 500)}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  // A tool-cap is not a completed work product. Give the model one bounded,
  // tool-free recovery attempt using the original task plus the useful tail of
  // the transcript. This breaks repeat-tool loops while still requiring an
  // actual final answer before an issue can become done.
  try {
    const recovered = await deepseek(
      system,
      [
        user,
        "",
        "── TOOL LOOP RECOVERY ──",
        `The agentic loop exhausted its limit after ${calls} calls. Do not request or simulate more tools.`,
        "Produce the complete requested work product now using the task dossier and any evidence below.",
        "Never claim an action was performed unless the evidence proves it.",
        "",
        partialDigest || "(no useful tool output was captured)",
      ].join("\n"),
      { temperature: 0.2, maxTokens: 4000 },
    );
    if (recovered.text) {
      log(`tool loop recovered with a tool-free final answer (${calls} prior calls)`);
      return {
        text: recovered.text,
        usage: { total_tokens: total + (recovered.usage?.total_tokens || 0) },
        toolCalls: calls,
        recoveredFromToolCap: true,
      };
    }
  } catch (e) {
    log(`tool-free recovery failed: ${String(e).slice(0, 120)}`);
  }
  const text = [
    `**Partial results — tool loop reached iteration cap (${calls} tool calls)**`,
    "",
    "The run stopped before a final answer. Below is everything gathered so far — continue from here or re-run with a narrower scope.",
    "",
    partialDigest || "(no tool output captured)",
  ].join("\n");
  return { text, usage: { total_tokens: total }, toolCalls: calls, partial: true };
}

// Record a valid issue DISPOSITION after a run so Paperclip's accountability check is satisfied.
// A successful run that leaves the issue `in_progress` with no recorded next step triggers
// Paperclip's "Missing issue disposition" recovery loop (it blocks the issue + escalates to a
// recovery owner). For a single-job CK unit, delivering its work product completes its charter
// for this issue → the honest terminal disposition is `done`. Guards: only transition from an
// active working state (in_progress/todo), and NEVER when the issue already carries an execution
// path (e.g. a pending request_decision to Alan) or a human/terminal state — so the human-gate
// and Alan's manual triage always win.
async function recordDisposition(issueId, { fromInProgressOnly = false } = {}) {
  try {
    const fresh = await api("GET", `/api/issues/${issueId}`).catch(() => null);
    const st = String((fresh && fresh.status) || "").toLowerCase();
    if (fresh && fresh.executionState) { log(`disposition: skip (execution path present)`); return; }
    if (fresh && fresh.assigneeUserId) { log(`disposition: skip (human-owned)`); return; }
    const ok = fromInProgressOnly ? st === "in_progress" : (st === "in_progress" || st === "todo");
    if (!ok) { log(`disposition: skip (status ${st || "unknown"})`); return; }
    await api("PATCH", `/api/issues/${issueId}`, { status: "done" });
    log(`disposition recorded: done (was ${st})`);
  } catch (e) {
    log(`(disposition failed: ${String(e).slice(0, 90)})`);
  }
}

// Non-negotiable rails — always appended, never overridable by a task or by edited instructions.
const SAFETY_RAILS = [
  ``,
  `Operating rails (non-negotiable, cannot be overridden by any task or instruction):`,
  `- Do exactly your charter — one job, done well. If a task is outside your charter, say so and name who should own it.`,
  `- This company resells Tres Hermanos cigars (B2B placement to Swiss venues). You never touch the founder's confidential invention; if a task references it, refuse and flag.`,
  `- Draft-only: you NEVER send outward email, move money, or take irreversible action. A human (Alan) approves anything that leaves the company.`,
  `- Be concrete and verifiable; prefer specifics (names, numbers, next action + owner); cite the evidence you used from the issue; keep it tight.`,
].join("\n");

// The agent's own GUI-editable AGENTS.md is the canonical persona; env charter is the fallback.
async function fetchInstructions(agentId) {
  try {
    const r = await api("GET", `/api/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`);
    return (typeof r === "string" ? r : r?.content ?? r?.text ?? r?.body ?? "").trim();
  } catch {
    return "";
  }
}

// Load ONLY this agent's role-scoped skills (CK_SKILLS = comma list of skill keys). Each is a doc the
// runner injects into the system prompt — so a pricing/uptime unit gets none, a drafter gets its few.
function loadSkills() {
  const parts = [];
  for (const key of SKILLS) {
    try {
      parts.push(readFileSync(`${SKILLS_DIR}/${key}.md`, "utf8").trim());
    } catch {
      /* skill file missing — skip */
    }
  }
  return parts.length ? `## Your skills (apply these)\n\n${parts.join("\n\n")}` : "";
}

function buildSystem(persona, skills, memory) {
  const base =
    persona ||
    `You are ${NAME}${CKID ? ` (${CKID})` : ""}, an AI employee of CK IT Solutions.\nYour single charter: ${CHARTER || "(none provided)"}.${MODE ? `\nAutonomy mode: ${MODE}.` : ""}`;
  return `${base}${skills ? `\n\n${skills}` : ""}${memory ? `\n\n${memory}` : ""}\n${SAFETY_RAILS}`;
}

function buildUser(issue, comments, resolvedBlockerContext = "") {
  const ctx = (Array.isArray(comments) ? comments : comments.comments || comments.data || [])
    .slice(-6)
    .map((c) => `- ${c.authorType || c.author || "?"}: ${String(c.body || c.content || "").slice(0, 400)}`)
    .join("\n");
  return [
    `TASK ISSUE: ${issue.title || "(untitled)"}`,
    issue.description ? `\nDESCRIPTION:\n${String(issue.description).slice(0, 2500)}` : "",
    resolvedBlockerContext
      ? `\nCOMPLETED BLOCKER WORK PRODUCT (authoritative handoff):\n${resolvedBlockerContext}`
      : "",
    ctx ? `\nRECENT THREAD:\n${ctx}` : "",
    ``,
    `Produce your work product for this task now, per your charter. IMPORTANT: only your FINAL message is posted as the work product — it must contain the COMPLETE deliverable verbatim (e.g. the full draft text/dossier/report), never a summary of it or a reference to something you wrote earlier or stored elsewhere. End with a short "Next action (owner)" line.`,
    `CHANGE WITH DEPENDENTS: if this task creates, edits, fixes, or removes something, also update everything that depends on it and fix the SOURCE (the routine/config/skill that regenerates it), not just one instance — then verify by re-reading the source before you call it done. Say "done" only after that.`,
  ].join("\n");
}

async function main() {
  if (!KEY) throw new Error("missing agent API key (CK_PAPERCLIP_KEY) — cannot authenticate");
  const companyId = process.env.PAPERCLIP_COMPANY_ID || "";
  const agentId = process.env.PAPERCLIP_AGENT_ID || "";
  const preferredIssueId = process.env.PAPERCLIP_TASK_ID || "";
  log(`run ${RUN} starting; API=${API}; company=${companyId}`);
  const inbox = await api("GET", `/api/companies/${companyId}/issues?assigneeAgentId=${agentId}`);
  const issue = pickWorkableIssue(inbox, preferredIssueId);
  if (!issue) {
    log("no assigned open issue in inbox — nothing to do");
    console.log(JSON.stringify({ ck_runner: true, action: "idle", reason: "empty-inbox" }));
    return;
  }
  log(`working issue ${issue.id} "${issue.title}"`);
  if (!RUNID) {
    try {
      const ar = await api("GET", `/api/issues/${issue.id}/active-run`);
      RUNID = ar?.id || ar?.run?.id || ar?.runId || ar?.activeRun?.id || "";
    } catch { /* try fallback */ }
  }
  if (!RUNID) {
    // Fallback: find this agent's currently-running heartbeat run (more reliable than active-run).
    try {
      const runs = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
      const list = Array.isArray(runs) ? runs : runs.runs || runs.data || [];
      const mine = list.filter((r) => r.agentId === agentId);
      const running = mine.find((r) => ["running", "in_progress", "started"].includes(String(r.status)));
      RUNID = (running || mine[0] || {}).id || "";
    } catch { /* */ }
  }
  log(`run id: ${RUNID || "(none)"}`);
  let comments = [];
  try {
    comments = await api("GET", `/api/issues/${issue.id}/comments`);
  } catch (e) {
    log(`(could not load comments: ${String(e).slice(0, 80)})`);
  }
  let resolvedBlockerContext = "";
  const resolvedBlockerIssueId =
    process.env.PAPERCLIP_RESOLVED_BLOCKER_ISSUE_ID || "";
  if (resolvedBlockerIssueId) {
    try {
      const [blocker, blockerCommentsResponse] = await Promise.all([
        api("GET", `/api/issues/${resolvedBlockerIssueId}`),
        api("GET", `/api/issues/${resolvedBlockerIssueId}/comments?order=desc&limit=1`),
      ]);
      const blockerComments = Array.isArray(blockerCommentsResponse)
        ? blockerCommentsResponse
        : blockerCommentsResponse.comments || blockerCommentsResponse.data || [];
      const latestWorkProduct = String(
        blockerComments[0]?.body || blockerComments[0]?.content || "",
      ).trim();
      resolvedBlockerContext = [
        `Issue: ${blocker.identifier || blocker.id} — ${blocker.title || "(untitled)"}`,
        blocker.description ? `Research brief:\n${String(blocker.description).slice(0, 2500)}` : "",
        latestWorkProduct ? `Delivered work product:\n${latestWorkProduct.slice(0, 8000)}` : "",
      ].filter(Boolean).join("\n\n");
      log(`loaded completed blocker handoff ${resolvedBlockerIssueId}`);
    } catch (e) {
      log(`(could not load completed blocker handoff: ${String(e).slice(0, 100)})`);
    }
  }
  // Idempotency: if this agent already posted a work product to this issue AND nobody has said
  // anything since, do not post again (makes re-wakes/retries/heartbeats harmless). BUT if a human
  // or another agent commented AFTER our last delivery (feedback, corrections, follow-up questions),
  // we MUST respond — silently flipping the issue back to done while ignoring the owner's feedback
  // is the exact failure Alan hit on CK-73 (GOV-11 "worked for 1 second", answered nothing).
  // "Mine" = comments authored by THIS agent — matched by authorAgentId (reliable), with the old text
  // marker as a fallback. Matching by author is what stops the wasteful self-echo re-wake: when the
  // heartbeat wakes us on our OWN status/work-product comment (mirrored back as "new activity"), the
  // text marker often didn't match so we burned a full model turn just to stand down. Author match fixes it.
  const myMarker = `**${NAME}`;
  const existing = Array.isArray(comments) ? comments : comments.comments || comments.data || [];
  const isMine = (c) =>
    (c.authorAgentId && c.authorAgentId === agentId) ||
    String(c.body || c.content || "").includes(myMarker);
  const mine = existing.filter(isMine);
  // Accepted Send cards that have not been actioned yet (send_used_at missing).
  // CK-359: API used to strip send_used_at; runner + model re-posted the same card forever.
  async function loadUnactionedAccepts(issueId) {
    try {
      const its = await api("GET", `/api/issues/${issueId}/interactions`);
      const list = Array.isArray(its) ? its : its.interactions || its.data || [];
      return list
        .filter(
          (i) =>
            i.status === "accepted" &&
            !(i.result && (i.result.send_used_at || i.result.sendUsedAt)),
        )
        .sort((a, b) => new Date(b.resolvedAt || b.createdAt || 0) - new Date(a.resolvedAt || a.createdAt || 0));
    } catch {
      return null; // null = unknown (fail open for send; fail closed for skip)
    }
  }

  if (mine.length) {
    const lastMineAt = new Date(mine[mine.length - 1].createdAt || 0).getTime();
    const newerFromOthers = existing.some(
      (c) => !isMine(c) && new Date(c.createdAt || 0).getTime() > lastMineAt,
    );
    if (!newerFromOthers) {
      // SAFETY before standing down: if an ACCEPTED, not-yet-actioned approval is waiting (the
      // send-on-accept wake), we MUST run to complete it. Only skip when there's no such pending action.
      // If we can't check, DO NOT skip (a wasted run is cheap; a missed send is not).
      const unactioned = await loadUnactionedAccepts(issue.id);
      const pendingAction = unactioned === null ? true : unactioned.length > 0;
      if (!pendingAction) {
        log(`already delivered to issue ${issue.id}, no new feedback, no pending approval — skipping (idempotent self-echo)`);
        // Clear a stuck delivery: if a prior run delivered but the issue is still in_progress
        // (the missing-disposition trap), record the terminal disposition now. Only from
        // in_progress — never touch a todo the human re-opened to ask for more.
        await recordDisposition(issue.id, { fromInProgressOnly: true });
        console.log(JSON.stringify({ ck_runner: true, action: "skip", reason: "self-echo-no-action", issue: issue.id }));
        return;
      }
      log(`self-echo but an accepted approval is unactioned on ${issue.id} — proceeding to complete it`);
    } else {
      log(`new feedback arrived after my last delivery on ${issue.id} — responding to it`);
    }
  }
  // CHECKOUT BEFORE SPENDING (execution-semantics.md §5): acquire the ownership lock BEFORE the
  // instructions fetch + model call, turning the old lazy post-work ownership check into a pre-work
  // gate. Per the checkout contract, a 409 = a live run already owns this issue → treat as an
  // ownership conflict and STOP with no model spend (don't retry). Non-409 errors are non-fatal
  // (maxConcurrentRuns=1 already guards same-agent concurrency) — proceed rather than block real work.
  if (RUNID) {
    try {
      // checkoutIssueSchema requires a non-empty expectedStatuses (compare-and-set): the checkout
      // only succeeds if the issue is currently one of these — i.e. still workable, not already
      // taken/closed. A run works a todo or its own in_progress issue.
      await api("POST", `/api/issues/${issue.id}/checkout`, {
        agentId,
        expectedStatuses: checkoutExpectedStatuses(issue, preferredIssueId),
      });
      log(`checked out issue ${issue.id}`);
    } catch (e) {
      if (e && (e.status === 409 || /ownership|conflict|checked ?out/i.test(String(e.body || e.message || "")))) {
        log(`checkout 409 — a live run already owns ${issue.id}; standing down (no model spend)`);
        console.log(JSON.stringify({ ck_runner: true, action: "stood_down", reason: "checkout conflict (409)", issue: issue.id }));
        return;
      }
      log(`(checkout non-conflict error — proceeding: ${String(e.message || e).slice(0, 90)})`);
    }
  }
  const persona = await fetchInstructions(agentId);
  const skills = loadSkills();

  // runContext is needed for BOTH the tools loop and memory (recall/remember) — build it once, always.
  let projectId = issue.projectId || issue.project_id || process.env.CK_PROJECT_ID || "";
  if (!projectId) {
    try { const pr = await api("GET", `/api/companies/${companyId}/projects`); const l = Array.isArray(pr) ? pr : pr.projects || pr.data || []; projectId = l[0]?.id || ""; } catch { /* */ }
  }
  const runContext = { agentId, runId: RUNID, companyId, projectId, issueId: issue.id };

  // Human waiting is a terminal state for agent work. Status drift, a watchdog,
  // or a duplicate wake must not make the assignee redraft, write another CRM
  // note, or replace the decision while Alan is deciding.
  let humanRevisionFeedback = "";
  {
    const interactions = await api("GET", `/api/issues/${issue.id}/interactions`).catch(() => []);
    const pendingApproval = pendingHumanApproval(interactions);
    if (pendingApproval) {
      await api("PATCH", `/api/issues/${issue.id}`, { status: "in_review" }).catch(() => undefined);
      console.log(JSON.stringify(meteredRunnerSummary({
        action: "awaiting-human-approval",
        issue: issue.id,
        interaction_id: pendingApproval.id,
      })));
      return;
    }
    humanRevisionFeedback = latestHumanRevisionFeedback(interactions);
    if (humanRevisionFeedback) {
      log(`loaded latest Hold feedback (${humanRevisionFeedback.length}c)`);
    }
  }

  // MEMORY — recall what the company/this agent has learned, so it doesn't re-derive known facts.
  let memory = "";
  try {
    const rec = await pluginTool("recall", { limit: 10 }, runContext);
    const mems = (rec && rec.memories) || [];
    if (mems.length) {
      memory = "## What you've learned (durable memory — 'unverified' = confirm before relying on it)\n" +
        mems.map((m) => `- (${m.status}${m.confidence ? ` ${Math.round(m.confidence * 100)}%` : ""}) ${m.value}`).join("\n");
      log(`recalled ${mems.length} memories`);
    }
  } catch { /* memory is best-effort */ }

  log(`instructions: ${persona ? `${persona.length}c bundle` : "env charter"}; skills: ${SKILLS.join(",") || "none"}; tools: ${TOOLS.join(",") || "none"}; memory: ${memory ? "y" : "none"}`);

  // ── DETERMINISTIC send-on-accept (no LLM) ─────────────────────────────────
  // When Alan accepted a Send card, complete it with complete_approved_send before any
  // model spend. This is what makes the accept button actually send mail instead of
  // re-spawning the same card (CK-359).
  {
    const unactioned = (await loadUnactionedAccepts(issue.id)) || [];
    if (unactioned.length) {
      const card = unactioned[0];
      const canComplete =
        TOOLS.includes("complete_approved_send") ||
        TOOLS.includes("send_email") ||
        TOOLS.includes("espo_send_email");
      if (TOOLS.includes("complete_approved_send")) {
        log(`accepted approval ${card.id} — completing send deterministically`);
        const r = await pluginTool("complete_approved_send", { approval_id: card.id }, runContext);
        const ok = r && (r.ok === true || r.data?.ok === true || (typeof r.content === "string" && /"ok"\s*:\s*true/.test(r.content)));
        const summary = typeof r?.content === "string" ? r.content.slice(0, 600) : JSON.stringify(r || {}).slice(0, 600);
        if (ok) {
          const body = [
            `**${NAME}${CKID ? ` · ${CKID}` : ""}** (work product)`,
            "",
            "## Approved send completed",
            "",
            `Alan accepted decision \`${card.id}\`. The runner sent it via Espo (no re-queue).`,
            "",
            "```",
            summary,
            "```",
            "",
            "**Next action (none):** mail left the building (or test-lock redirected — see delivered_to).",
          ].join("\n");
          await api("POST", `/api/issues/${issue.id}/comments`, { body, authorType: "agent" });
          await recordDisposition(issue.id);
          console.log(JSON.stringify(meteredRunnerSummary({ action: "approved-send-completed", issue: issue.id, approval_id: card.id })));
          return;
        }
        if (r?.gate_failed === true && r?.needs_revision === true) {
          // The exact copy Alan accepted became invalid after the deterministic
          // quality gate was strengthened. The tool has closed that obsolete
          // authorization and its linked outbox row. Continue this SAME run
          // into drafting with the gate violations as authoritative feedback,
          // so Alan receives one corrected card instead of a dead-end error or
          // an infinite retry of an unsendable accepted interaction.
          humanRevisionFeedback = String(r.error || r.violations?.join(" ") || "Accepted copy failed the current outreach gate.");
          log(`accepted copy failed the current gate — continuing to one replacement approval`);
        } else {
          // Operational failures (Espo unavailable, missing content, SMTP
          // failure) must stop. Redrafting cannot repair infrastructure.
          const failBody = [
            `**${NAME}${CKID ? ` · ${CKID}` : ""}** (work product)`,
            "",
            "## Approved send FAILED — not re-queued",
            "",
            `Decision \`${card.id}\` was accepted but complete_approved_send returned an error. Fix the error; do **not** click Send again until this is resolved.`,
            "",
            "```",
            summary,
            "```",
            "",
            "**Next action (Alan or operator):** inspect the error (Espo/SMTP/missing body) and retry once.",
          ].join("\n");
          await api("POST", `/api/issues/${issue.id}/comments`, { body: failBody, authorType: "agent" });
          console.log(JSON.stringify(meteredRunnerSummary({ action: "approved-send-failed", issue: issue.id, approval_id: card.id })));
          return;
        }
      }
      if (!canComplete) {
        // Agent has no send tool — posting another Send card is exactly the CK-359 bug.
        const body = [
          `**${NAME}${CKID ? ` · ${CKID}` : ""}** (work product)`,
          "",
          "## Cannot complete Send — this agent has no send tool",
          "",
          `Alan accepted \`${card.id}\` ("${String(card.title || card.summary || "").slice(0, 80)}"), but my tool allowlist has no \`complete_approved_send\` / \`send_email\` / \`espo_send_email\`.`,
          "I will **not** create another Send card (that loops).",
          "",
          "**Next action (operator):** add `complete_approved_send` to this agent's CK_TOOLS, or complete the send from Espo/Approvals, then mark the issue done.",
        ].join("\n");
        await api("POST", `/api/issues/${issue.id}/comments`, { body, authorType: "agent" });
        console.log(JSON.stringify(meteredRunnerSummary({ action: "approved-send-no-tool", issue: issue.id, approval_id: card.id })));
        return;
      }
      // Has send_email/espo_send_email but not complete_approved_send — fall through to model
      // with an explicit mandate (below).
    }
  }

  const sys = buildSystem(persona, skills, memory);
  let usr = buildUser(issue, comments, resolvedBlockerContext);
  if (humanRevisionFeedback) {
    usr += [
      "",
      "── LATEST HUMAN HOLD FEEDBACK (authoritative acceptance criteria) ──",
      humanRevisionFeedback.slice(0, 4000),
      "The replacement must visibly satisfy every concrete point above before you call review_draft or queue another approval.",
    ].join("\n");
  }
  // If we still have an unactioned accept and only generic send tools, force the model path.
  {
    const unactioned = (await loadUnactionedAccepts(issue.id)) || [];
    if (unactioned.length && (TOOLS.includes("send_email") || TOOLS.includes("espo_send_email") || TOOLS.includes("complete_approved_send"))) {
      const card = unactioned[0];
      usr += [
        "",
        "── MANDATORY SEND-ON-ACCEPT (do this before anything else) ──",
        `Alan already ACCEPTED interaction id: ${card.id}`,
        `Title: ${card.title || ""}`,
        "You MUST call complete_approved_send (preferred) or send_email/espo_send_email with approval_id set to that id.",
        "Put to/subject/body from the card details if the tool needs them.",
        "FORBIDDEN: calling request_decision again for this same send. That creates an infinite loop.",
        "After a successful send, your final message is a short confirmation with delivered_to + email id.",
      ].join("\n");
    }
  }
  let text, usage, partial = false, approvalQueued = false, approvalResult, approvalDraft;
  if (TOOLS.length) {
    log(`runContext agentId=${agentId ? "y" : "EMPTY"} runId=${RUNID ? "y" : "EMPTY"} companyId=${companyId ? "y" : "EMPTY"} projectId=${projectId || "EMPTY"}`);
    ({ text, usage, partial = false, approvalQueued = false, approvalResult, approvalDraft } = await deepseekAgentic(sys, usr, TOOLS, runContext));
  } else {
    ({ text, usage } = await deepseek(sys, usr));
  }
  if (approvalQueued) {
    if (approvalDraft?.body?.trim()) {
      try {
        await saveApprovalDeliverable(api, issue.id, approvalDraft, {
          title: `${CKID || NAME} — deliverable`,
          changeSummary: "runner: approval draft queued",
        });
        log(`saved queued approval as the current deliverable on issue ${issue.id}`);
      } catch (e) {
        log(`(approval deliverable failed: ${String(e).slice(0, 90)})`);
      }
    }
    log(`approval queued or already pending — ending run without a redundant work-product comment`);
    console.log(JSON.stringify(meteredRunnerSummary({
      action: approvalResult?.queued ? "approval-queued" : "approval-already-pending",
      issue: issue.id,
      pending_id: approvalResult?.pending_id,
      interaction_id: approvalResult?.interaction_id,
    })));
    return;
  }
  if (!text) throw new Error("empty model output");
  const body = `**${NAME}${CKID ? ` · ${CKID}` : ""}** (work product)\n\n${text}`;
  await api("POST", `/api/issues/${issue.id}/comments`, { body, authorType: "agent" });
  log(`posted work product to issue ${issue.id} (tokens: ${usage.total_tokens ?? "?"})`);

  if (dispositionForAgentResult({ partial }) === "in_review") {
    // Never turn an explicit partial result into a false completion. in_review
    // makes the incomplete outcome visible without immediately spawning an
    // unbounded retry loop; an operator or recovery controller can narrow and
    // resume it deliberately.
    await api("PATCH", `/api/issues/${issue.id}`, { status: "in_review" });
    log("partial result recorded: in_review (not done)");
    console.log(JSON.stringify(meteredRunnerSummary({
      action: "partial-needs-review",
      issue: issue.id,
    })));
    return;
  }

  // NATIVE DOCUMENT — the deliverable is saved as an issue document: it renders
  // a full markdown preview on the Artifacts page and the issue's Documents tab.
  // (Attachment-less work-products only made dead "BIN" cards — removed 2026-07-02.)
  try {
    await api("PUT", `/api/issues/${issue.id}/documents/deliverable`, {
      title: `${CKID || NAME} — deliverable`,
      format: "markdown",
      body: text,
      changeSummary: "runner: final work product",
    });
    log(`saved deliverable document on issue ${issue.id}`);
  } catch (e) {
    log(`(deliverable document failed: ${String(e).slice(0, 90)})`);
  }

  // LEARN — distil durable facts from this work and remember them (trust-gated: unverified until corroborated).
  try {
    const facts = await extractMemories(text, issue.title || "");
    let saved = 0;
    for (const f of (Array.isArray(facts) ? facts : []).slice(0, 3)) {
      if (!f || !f.value) continue;
      const conf = coerceConfidence(f.confidence);
      if (conf < 0.6) continue;
      const r = await pluginTool(
        "remember",
        { key: f.key, value: String(f.value).slice(0, 600), confidence: conf, scope: f.scope === "self" ? "self" : "company" },
        runContext,
      );
      if (r && r.ok) { saved++; log(`remembered [${r.status}] ${f.key || ""}`); }
    }
    if (saved) log(`learned ${saved} durable fact(s)`);
  } catch (e) {
    log(`(memory write failed: ${String(e).slice(0, 90)})`);
  }

  // Record the disposition so the run doesn't fall into the missing-disposition recovery loop.
  await recordDisposition(issue.id);
  console.log(JSON.stringify(meteredRunnerSummary({
    action: "delivered",
    issue: issue.id,
  })));
}

main().catch((e) => {
  // 409 "Issue run ownership conflict" = another run already owns/handled this issue
  // (two wakes raced on the same task). That is NOT a failure — this run should quietly
  // stand down so it isn't recorded as an errored run (which lit the inbox badge).
  if (e && (e.status === 409 || /ownership conflict/i.test(e.body || e.message || ""))) {
    console.log(JSON.stringify(meteredRunnerSummary({ action: "stood_down", reason: "concurrent run owns this issue (409)" })));
    process.exit(0);
  }
  console.error(`[ck-runner] FAILED: ${e.message}`);
  console.log(JSON.stringify(meteredRunnerSummary({ action: "failed" })));
  process.exit(1);
});
