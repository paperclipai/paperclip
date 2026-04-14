import type { Db } from "@ironworksai/db";
import { lookupPlaybook } from "./playbook-rag.js";
import { logger } from "../middleware/logger.js";

/**
 * Post-execution audit: after an agent completes a run, a small Ollama
 * model reads the agent's output AND the relevant playbook chunks, and
 * judges whether the agent followed the playbook discipline.
 *
 * Why: long-running agents drift from their playbooks over time. A
 * lightweight audit catches the drift quickly so the operator can
 * intervene (or so a self-improvement loop can flag the agent).
 *
 * Model choice: ministral-3:3b on Ollama Cloud. Fast (sub-second), free
 * within the flat-rate tier, cheap to run after every heartbeat.
 *
 * Design:
 *   1. Fetch the agent's output text (caller passes it in).
 *   2. Look up 3 most relevant playbook chunks for the agent's task.
 *   3. Build an audit prompt: "given these chunks and this output,
 *      did the agent follow the discipline?"
 *   4. Send to ministral-3:3b, parse JSON verdict.
 *   5. Return verdict; caller decides what to do (log, alert, etc.).
 *
 * The audit is advisory, never blocking. If the audit model fails
 * (timeout, parse error, etc.) we return null — never break the run.
 */

const AUDIT_MODEL = process.env.IRONWORKS_AUDIT_MODEL || "ministral-3:3b";
const AUDIT_URL = process.env.OLLAMA_BASE_URL
  ? `${process.env.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`
  : "https://ollama.com/api/chat";
const AUDIT_TIMEOUT_MS = 30_000;

export interface AuditInput {
  companyId: string;
  agentId: string;
  agentName: string;
  agentRole: string;        // e.g., "cmo", "cfo", "engineer"
  agentDepartment: string | null;
  taskSummary: string;      // e.g., "draft Q2 launch announcement"
  agentOutput: string;      // what the agent produced
}

export interface AuditVerdict {
  followed: boolean;        // true = agent followed playbook discipline
  confidence: number;       // 0-100; how confident the auditor is
  violations: string[];     // specific rule violations (empty if followed=true)
  suggestions: string[];    // what the agent should do differently next time
  chunksConsulted: number;  // how many playbook chunks the auditor referenced
  auditModel: string;
  auditDurationMs: number;
}

export async function auditAgentRun(
  db: Db,
  input: AuditInput,
): Promise<AuditVerdict | null> {
  const start = Date.now();

  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    logger.debug({ agentId: input.agentId }, "playbook-audit: no OLLAMA_API_KEY, skipping audit");
    return null;
  }

  // Truncate inputs so we don't blow the model context. Ministral-3:3b
  // handles ~32k tokens but we want to stay fast.
  const truncatedTask = input.taskSummary.slice(0, 500);
  const truncatedOutput = input.agentOutput.slice(0, 4000);

  // Look up relevant playbook chunks via RAG. Filter by department so
  // we don't audit a CMO output against a security playbook.
  let chunks;
  try {
    chunks = await lookupPlaybook(db, {
      companyId: input.companyId,
      query: truncatedTask,
      department: input.agentDepartment ?? undefined,
      ownerRole: input.agentRole,
      documentType: "playbook",
      topK: 3,
      agentId: input.agentId,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, agentId: input.agentId },
      "playbook-audit: lookup failed, skipping audit",
    );
    return null;
  }

  if (chunks.length === 0) {
    logger.debug({ agentId: input.agentId }, "playbook-audit: no playbook chunks found, skipping");
    return null;
  }

  const playbookSummary = chunks
    .map((c) => `### ${c.headingPath}\n\n${c.body.slice(0, 1500)}`)
    .join("\n\n---\n\n");

  const auditPrompt = `You are a quality auditor evaluating whether an AI agent followed its operating playbook.

# Agent
- Name: ${input.agentName}
- Role: ${input.agentRole}
- Department: ${input.agentDepartment ?? "n/a"}

# Task
${truncatedTask}

# Agent's Output
${truncatedOutput}

# Relevant Playbook Sections
${playbookSummary}

# Your job
Evaluate whether the agent's output followed the playbook discipline. Consider:
- Did it skip any "Hard Gates" or required checkpoints?
- Did it use any rationalizations from the Anti-Patterns table without rejecting them?
- Did it produce the required deliverable structure?
- Did it fall back on any "I'll just" or "good enough" excuses the playbook explicitly forbids?

Respond with ONLY a JSON object in this exact shape (no prose, no markdown):
{
  "followed": <true|false>,
  "confidence": <0-100>,
  "violations": ["<short violation 1>", "<short violation 2>"],
  "suggestions": ["<short suggestion 1>", "<short suggestion 2>"]
}

Be specific. Quote phrases from the agent's output when citing violations.
If the agent followed the playbook, set violations to [] and confidence high.
`;

  // Call Ollama Cloud
  let verdictRaw: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
    try {
      const res = await fetch(AUDIT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: AUDIT_MODEL,
          messages: [{ role: "user", content: auditPrompt }],
          stream: false,
          options: { num_predict: 500, temperature: 0.2 },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`audit model returned ${res.status}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      verdictRaw = data.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, agentId: input.agentId, model: AUDIT_MODEL },
      "playbook-audit: audit model call failed",
    );
    return null;
  }

  // Parse JSON verdict (model may wrap in markdown despite instructions)
  const jsonMatch = verdictRaw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn(
      { agentId: input.agentId, sample: verdictRaw.slice(0, 200) },
      "playbook-audit: could not extract JSON from audit response",
    );
    return null;
  }

  let parsed: {
    followed?: unknown;
    confidence?: unknown;
    violations?: unknown;
    suggestions?: unknown;
  };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, agentId: input.agentId, sample: jsonMatch[0].slice(0, 200) },
      "playbook-audit: JSON parse failed",
    );
    return null;
  }

  const verdict: AuditVerdict = {
    followed: typeof parsed.followed === "boolean" ? parsed.followed : true,
    confidence: clampNumber(parsed.confidence, 0, 100, 50),
    violations: toStringArray(parsed.violations).slice(0, 10),
    suggestions: toStringArray(parsed.suggestions).slice(0, 10),
    chunksConsulted: chunks.length,
    auditModel: AUDIT_MODEL,
    auditDurationMs: Date.now() - start,
  };

  // Log verdict for observability
  if (!verdict.followed && verdict.confidence >= 70) {
    logger.warn(
      {
        agentId: input.agentId,
        agentName: input.agentName,
        violations: verdict.violations,
        confidence: verdict.confidence,
      },
      "playbook-audit: agent did NOT follow playbook discipline",
    );
  } else {
    logger.info(
      {
        agentId: input.agentId,
        agentName: input.agentName,
        followed: verdict.followed,
        confidence: verdict.confidence,
        chunks: verdict.chunksConsulted,
        ms: verdict.auditDurationMs,
      },
      "playbook-audit: complete",
    );
  }

  return verdict;
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}
