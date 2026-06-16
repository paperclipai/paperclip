import { Router } from "express";

const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_INPUT_CHARS = 12_000;
const MAX_OUTPUT_TOKENS = 1_500;

const BRAND_GUARDRAIL = [
  "You are working inside SINK DINK Media Company OS for SINK/DINK India.",
  "SINK/DINK means Single Income No Kids / Double Income No Kids.",
  "Target audience: Indian singles/couples/working couples with no kids, or people planning a no-kids/childfree/no-children lifestyle respectfully.",
  "This is NOT a parenting page, kids activity page, family craft page, or children education page.",
  "Do not create parenting tips, kids activities, child craft ideas, playtime ideas, or content written for parents with children.",
  "If the input mentions children, family pressure, or parents, convert it into a respectful SINK/DINK angle about personal choice, boundaries, planning, peace, finances, or lifestyle design.",
  "Never insult children, parents, families, religion, caste, or society.",
  "Never say kids are bad, parents are wrong, or families are backward.",
  "Allowed themes: social pressure, couple timeline, freedom, finances, mental peace, travel, career, lifestyle design, mutual respect, family-boundary conversation.",
  "Every output must include a QA Note with: Brand fit, Niche drift check, Safety note, Human approval needed.",
  "If you cannot keep the output SINK/DINK-focused, return: REJECTED_BY_BRAND_GUARDRAIL with a short reason.",
];

const DRIFT_PATTERNS = [
  "little ones",
  "kids activities",
  "kidsactivities",
  "creativekids",
  "craftideasforkids",
  "playtimefun",
  "parentingindia",
  "parenting tips",
  "child-safe",
  "parent and child",
  "child are",
  "child is",
  "children craft",
  "family craft",
  "familyfun",
  "boredom buster",
  "school project",
  "homework",
  "toddler",
  "baby care",
  "mom tips",
  "dad tips",
];

type BridgeRequest = {
  mode?: string;
  execute?: boolean;
  agent?: string;
  task?: string;
  input?: string;
  outputFormat?: string;
  riskLevel?: string;
  requiresApproval?: boolean;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
};

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function getGeminiApiKey(): string | null {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    null
  );
}

function redactSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function bridgeEnabled(): boolean {
  return process.env.PAPERCLIP_GEMINI_DIRECT_API === "true";
}

function executionAllowed(): boolean {
  return process.env.PAPERCLIP_GEMINI_DIRECT_EXECUTE === "true";
}

function buildPrompt(body: BridgeRequest): string {
  const agent = safeString(body.agent, "Manual Brain");
  const task = safeString(body.task, "Dry run task");
  const input = safeString(body.input).slice(0, MAX_INPUT_CHARS);
  const outputFormat = safeString(body.outputFormat, "Return structured JSON-like text with sections.");
  const riskLevel = safeString(body.riskLevel, "low");

  return [
    ...BRAND_GUARDRAIL,
    "",
    "Execution safety rules:",
    "This is a controlled Paperclip dry-run or approved bridge call.",
    "Do not publish, spend money, expose secrets, or perform external actions.",
    "Keep tone safe, respectful, non-hateful, and India-context aware.",
    "Avoid anti-child, anti-parent, caste, religion, political, or hateful framing.",
    "",
    `Agent: ${agent}`,
    `Task: ${task}`,
    `Risk level: ${riskLevel}`,
    "",
    "Input:",
    input,
    "",
    "Required output format:",
    outputFormat,
    "",
    "Final self-check before answering:",
    "1. Is this for SINK/DINK/no-kids audience, not parents/kids?",
    "2. Is it respectful toward families/parents/children?",
    "3. Does QA Note explicitly say Brand fit and Niche drift check?",
  ].join("\n");
}

function detectBrandDrift(output: string) {
  const lower = output.toLowerCase();
  const matches = DRIFT_PATTERNS.filter((pattern) => lower.includes(pattern));
  const hasSinkDinkSignal = [
    "sink",
    "dink",
    "no kids",
    "no-kids",
    "childfree",
    "child-free",
    "without kids",
    "couple timeline",
    "personal choice",
    "financial freedom",
    "mental peace",
  ].some((signal) => lower.includes(signal));

  return {
    driftDetected: matches.length > 0 || !hasSinkDinkSignal,
    matches,
    hasSinkDinkSignal,
  };
}

function simulatedOutput(body: BridgeRequest) {
  return {
    ok: true,
    simulated: true,
    provider: "gemini",
    model: safeString(body.model, process.env.PAPERCLIP_GEMINI_DIRECT_MODEL || DEFAULT_MODEL),
    agent: safeString(body.agent, "Manual Brain"),
    task: safeString(body.task, "Dry run task"),
    output: {
      status: "DRY_RUN_SIMULATION_ONLY",
      message: "Bridge route is installed. No external Gemini API call was made.",
      nextStep: "Set execute:true and PAPERCLIP_GEMINI_DIRECT_EXECUTE=true only after human approval.",
      safety: {
        publishing: "blocked",
        paidApi: "blocked unless approved",
        connectors: "blocked",
        secretsExposed: false,
      },
    },
    qaRequired: true,
    audit: {
      mode: safeString(body.mode, "dry_run"),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      secretExposed: false,
      reason: "execute flag or execution env not enabled",
    },
  };
}

async function callGemini(body: BridgeRequest) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return {
      ok: false,
      provider: "gemini",
      errorType: "auth",
      safeMessage: "GEMINI_API_KEY or GOOGLE_API_KEY is missing in Render environment.",
      nextAction: "Add key in Render env and redeploy, or use simulation mode.",
      audit: { secretExposed: false, keyPreview: null },
    };
  }

  const model = safeString(body.model, process.env.PAPERCLIP_GEMINI_DIRECT_MODEL || DEFAULT_MODEL);
  const timeoutMs = Number(process.env.PAPERCLIP_GEMINI_DIRECT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const timeout = setTimeout(() => controller.abort(), Math.max(5_000, timeoutMs));

  try {
    const prompt = buildPrompt(body);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: typeof body.temperature === "number" ? body.temperature : 0.25,
          maxOutputTokens: typeof body.maxOutputTokens === "number"
            ? Math.min(Math.max(128, body.maxOutputTokens), MAX_OUTPUT_TOKENS)
            : MAX_OUTPUT_TOKENS,
        },
      }),
    });

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }

    if (!response.ok) {
      return {
        ok: false,
        provider: "gemini",
        model,
        status: response.status,
        errorType: response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "quota" : "server",
        safeMessage: typeof parsed === "string" ? parsed.slice(0, 500) : "Gemini API returned an error.",
        raw: parsed,
        nextAction: "Use simulation/fallback or verify Gemini API key, quota, model, and billing/free-tier status.",
        audit: {
          startedAt,
          completedAt: new Date().toISOString(),
          secretExposed: false,
          keyPreview: redactSecret(apiKey),
        },
      };
    }

    const candidates = (parsed as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates ?? [];
    const output = candidates
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n\n");

    const brandCheck = detectBrandDrift(output);
    if (brandCheck.driftDetected) {
      return {
        ok: false,
        simulated: false,
        provider: "gemini",
        model,
        agent: safeString(body.agent, "Manual Brain"),
        task: safeString(body.task, "Dry run task"),
        errorType: "brand_drift",
        safeMessage: "Gemini output failed SINK/DINK India brand guardrail. Output was not accepted.",
        brandCheck,
        rejectedOutputPreview: output.slice(0, 1_500),
        qaRequired: true,
        nextAction: "Regenerate with stronger SINK/DINK/no-kids framing or send to QA Director.",
        audit: {
          mode: safeString(body.mode, "dry_run"),
          startedAt,
          completedAt: new Date().toISOString(),
          secretExposed: false,
          keyPreview: redactSecret(apiKey),
        },
      };
    }

    return {
      ok: true,
      simulated: false,
      provider: "gemini",
      model,
      agent: safeString(body.agent, "Manual Brain"),
      task: safeString(body.task, "Dry run task"),
      output,
      qaRequired: true,
      brandCheck,
      audit: {
        mode: safeString(body.mode, "dry_run"),
        startedAt,
        completedAt: new Date().toISOString(),
        secretExposed: false,
        keyPreview: redactSecret(apiKey),
      },
    };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      provider: "gemini",
      model: safeString(body.model, process.env.PAPERCLIP_GEMINI_DIRECT_MODEL || DEFAULT_MODEL),
      errorType: isAbort ? "timeout" : "server",
      safeMessage: error instanceof Error ? error.message : "Unknown Gemini bridge error.",
      nextAction: "Use simulation/fallback or retry after checking Render logs.",
      audit: {
        startedAt,
        completedAt: new Date().toISOString(),
        secretExposed: false,
        keyPreview: redactSecret(apiKey),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function sinkDinkGeminiBridgeRoutes() {
  const router = Router();

  router.get("/sink-dink/gemini-bridge/status", (_req, res) => {
    const apiKey = getGeminiApiKey();
    res.json({
      ok: true,
      bridge: "sink-dink-gemini-direct-api",
      enabled: bridgeEnabled(),
      executionAllowed: executionAllowed(),
      defaultModel: process.env.PAPERCLIP_GEMINI_DIRECT_MODEL || DEFAULT_MODEL,
      hasGeminiKey: Boolean(apiKey),
      keyPreview: redactSecret(apiKey),
      safety: {
        defaultSimulation: true,
        requiresExecuteFlag: true,
        requiresExecutionEnv: true,
        secretsExposed: false,
      },
      brandGuardrail: {
        target: "SINK/DINK India no-kids audience",
        parentingContentBlocked: true,
        brandDriftDetector: true,
      },
    });
  });

  router.post("/sink-dink/gemini-bridge/run", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (!actorType) {
      res.status(403).json({ error: "authenticated_actor_required" });
      return;
    }

    const body = (req.body ?? {}) as BridgeRequest;
    const execute = body.execute === true;

    if (!bridgeEnabled() || !execute || !executionAllowed()) {
      res.json(simulatedOutput(body));
      return;
    }

    const result = await callGemini(body);
    const status = result.ok ? 200 : result.errorType === "brand_drift" ? 422 : 502;
    res.status(status).json(result);
  });

  return router;
}
