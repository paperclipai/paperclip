import { Router } from "express";

const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAMPAIGN_COUNT = 10;

type CampaignPack = {
  title: string;
  topic: string;
  hook: string;
  script: string[];
  caption: string;
  hashtags: string[];
  visualStyle: string;
  approvalStatus: string;
};

function normalizeBaseUrl(rawUrl: string | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function getMediaWorkerUrl(): string | null {
  return normalizeBaseUrl(process.env.MEDIA_WORKER_URL ?? process.env.SINK_DINK_MEDIA_WORKER_URL);
}

function getGeminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || null;
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function parseString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function absoluteWorkerFileUrl(workerUrl: string, value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const url = value.trim();
  if (/^https?:\/\//i.test(url)) return url;
  return `${workerUrl}${url.startsWith("/") ? "" : "/"}${url}`;
}

function normalizeWorkerFiles(workerUrl: string, data: Record<string, unknown>): Array<Record<string, unknown>> {
  const files = Array.isArray(data.files) ? data.files : [];
  return files
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      ...item,
      absoluteUrl: absoluteWorkerFileUrl(workerUrl, item.url),
    }));
}

async function insertSupabaseRows(table: string, rows: Array<Record<string, unknown>>): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const supabaseUrl = normalizeBaseUrl(process.env.SUPABASE_URL);
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return { ok: true, skipped: true };

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (response.ok) return { ok: true };
  return { ok: false, error: await response.text() };
}

function fallbackCampaignPacks(baseTopic: string, count: number, tone: string): CampaignPack[] {
  const angles = [
    "family pressure aur personal freedom",
    "good news kab doge ka calm reply",
    "financial peace before baby decision",
    "no kids by choice ko selfish samajhne wali society",
    "marriage me apna timeline choose karna",
    "career aur relationship planning without pressure",
    "family ko respect, boundary ko protect",
    "couple peace over social approval",
    "childfree decision ka mature explanation",
    "Indian SINK DINK lifestyle ka balanced view",
  ];

  return angles.slice(0, count).map((angle, index) => ({
    title: `SINK DINK India Reel ${index + 1}`,
    topic: `${baseTopic}: ${angle}`,
    hook: index % 2 === 0
      ? "Good news kab doge? Har couple ka answer same nahi hota."
      : "Shaadi ke baad timeline couple ka hota hai, society ka nahi.",
    script: [
      "Good news kab doge? Ye sawaal simple lagta hai, par pressure bohot real hota hai.",
      "Har couple ka timeline alag hota hai. Career, health, money aur mental peace bhi life ka part hain.",
      "SINK DINK ka matlab selfish hona nahi. Matlab apni life choices responsibly plan karna.",
      "Family ko respect do, lekin apni marriage ka decision calm mind se lo. Approval se pehle peace zaroori hai.",
    ],
    caption: "Good news ka pressure real hai. Respect family ko bhi, peace apne relationship ko bhi. Human approval required.",
    hashtags: ["#SINKDINKIndia", "#NoKidsByChoice", "#ModernRelationships", "#IndianCouples", "#FinancialPeace"],
    visualStyle: `minimal premium Indian Instagram reel, bold text, ${tone}`,
    approvalStatus: "pending_human_approval",
  }));
}

function extractJsonArray(raw: string): unknown {
  const cleaned = raw
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .trim();
  const first = cleaned.indexOf("[");
  const last = cleaned.lastIndexOf("]");
  const slice = first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned;
  return JSON.parse(slice);
}

function validateCampaignPacks(value: unknown, fallback: CampaignPack[]): CampaignPack[] {
  if (!Array.isArray(value)) return fallback;
  const packs = value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item, index) => ({
      title: parseString(item.title, fallback[index]?.title ?? `SINK DINK India Reel ${index + 1}`),
      topic: parseString(item.topic, fallback[index]?.topic ?? "SINK DINK India"),
      hook: parseString(item.hook, fallback[index]?.hook ?? "Good news kab doge? Har couple ka answer same nahi hota."),
      script: Array.isArray(item.script)
        ? item.script.filter((line): line is string => typeof line === "string" && line.trim().length > 0).slice(0, 6)
        : fallback[index]?.script ?? fallback[0]?.script ?? [],
      caption: parseString(item.caption, fallback[index]?.caption ?? "Human approval required."),
      hashtags: Array.isArray(item.hashtags)
        ? item.hashtags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).slice(0, 8)
        : fallback[index]?.hashtags ?? fallback[0]?.hashtags ?? [],
      visualStyle: parseString(item.visualStyle, fallback[index]?.visualStyle ?? "minimal premium Indian Instagram reel"),
      approvalStatus: "pending_human_approval",
    }))
    .filter((pack) => pack.script.length > 0);

  return packs.length > 0 ? packs : fallback;
}

async function generateCampaignPacks(input: {
  topic: string;
  count: number;
  tone: string;
}): Promise<{ ok: boolean; provider: string; model?: string; fallbackUsed: boolean; reason?: string; packs: CampaignPack[] }> {
  const fallback = fallbackCampaignPacks(input.topic, input.count, input.tone);
  const apiKey = getGeminiApiKey();
  if (!apiKey || process.env.PAPERCLIP_GEMINI_DIRECT_API !== "true" || process.env.PAPERCLIP_GEMINI_DIRECT_EXECUTE !== "true") {
    return { ok: true, provider: "fallback", fallbackUsed: true, reason: "gemini_not_enabled", packs: fallback };
  }

  const model = process.env.PAPERCLIP_GEMINI_DIRECT_MODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.PAPERCLIP_GEMINI_DIRECT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));

  const prompt = [
    "You are the CEO + Strategy Director + Content Director for SINK DINK India.",
    "Create top-level Instagram reel content packs for Indian SINK/DINK audience.",
    "SINK/DINK = Single Income No Kids / Double Income No Kids. Respectful no-kids/childfree/couple timeline niche.",
    "Do not create parenting tips, kids activities, anti-child hate, anti-family hate, caste/religion/political attacks, or medical/legal claims.",
    "Tone must be emotionally sharp, respectful, smart Hinglish, relatable, Instagram top-page style.",
    `Base topic: ${input.topic}`,
    `Count: ${input.count}`,
    `Tone: ${input.tone}`,
    "Return ONLY valid JSON array. No markdown.",
    "Each object must have: title, topic, hook, script(array of 4 short Hinglish lines), caption, hashtags(array), visualStyle.",
  ].join("\n");

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 3000 },
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      return { ok: true, provider: "gemini", model, fallbackUsed: true, reason: `gemini_http_${response.status}`, packs: fallback };
    }

    const parsed = JSON.parse(raw) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const output = (parsed.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n");

    const packs = validateCampaignPacks(extractJsonArray(output), fallback).slice(0, input.count);
    return { ok: true, provider: "gemini", model, fallbackUsed: false, packs };
  } catch (error) {
    return {
      ok: true,
      provider: "gemini",
      model,
      fallbackUsed: true,
      reason: error instanceof Error ? error.message : "gemini_failed",
      packs: fallback,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function sinkDinkAiCampaignRoutes() {
  const router = Router();

  router.get("/sink-dink/ai-campaign/status", (_req, res) => {
    res.json({
      ok: true,
      service: "sink-dink-ai-campaign",
      workerUrlConfigured: Boolean(getMediaWorkerUrl()),
      geminiConfigured: Boolean(getGeminiApiKey()),
      geminiEnabled: process.env.PAPERCLIP_GEMINI_DIRECT_API === "true",
      geminiExecutionAllowed: process.env.PAPERCLIP_GEMINI_DIRECT_EXECUTE === "true",
      supabaseConfigured: Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
      humanApprovalRequired: true,
      publishingBlocked: true,
    });
  });

  router.post("/sink-dink/ai-campaign/create", async (req, res) => {
    const workerUrl = getMediaWorkerUrl();
    if (!workerUrl) {
      res.status(503).json({ ok: false, error: "MEDIA_WORKER_URL is not configured" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const topic = parseString(body.topic, "SINK DINK India me family pressure aur personal freedom");
    const count = Math.min(MAX_CAMPAIGN_COUNT, Math.max(1, Math.floor(parsePositiveNumber(body.count, 5))));
    const tone = parseString(body.tone, "smart Hinglish, relatable, emotionally sharp, Instagram top-page style");
    const durationSec = parsePositiveNumber(body.durationSec, 25);
    const batchId = `ai-batch-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

    const campaign = await generateCampaignPacks({ topic, count, tone });
    const results: Array<Record<string, unknown>> = [];

    for (const [index, pack] of campaign.packs.slice(0, count).entries()) {
      try {
        const workerResponse = await fetch(`${workerUrl}/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: pack.topic,
            tone,
            durationSec,
            mediaPack: pack,
          }),
        });

        const workerPayload = await workerResponse.json().catch(async () => ({
          raw: await workerResponse.text().catch(() => ""),
        })) as Record<string, unknown>;
        const jobId = typeof workerPayload.jobId === "string" ? workerPayload.jobId : null;
        const files = normalizeWorkerFiles(workerUrl, workerPayload);

        const supabaseJobs = jobId
          ? await insertSupabaseRows("sink_dink_jobs", [{
              job_id: jobId,
              source: "paperclip-ai-campaign",
              worker: "huggingface",
              topic: pack.topic,
              status: typeof workerPayload.status === "string" ? workerPayload.status : "created",
              files,
              qa: {
                workerHttpStatus: workerResponse.status,
                batchId,
                batchIndex: index + 1,
                aiProvider: campaign.provider,
                fallbackUsed: campaign.fallbackUsed,
              },
              approval_status: "pending_human_approval",
            }])
          : { ok: true, skipped: true };

        const supabaseAudit = jobId
          ? await insertSupabaseRows("sink_dink_audit_log", [{
              event_type: "ai_campaign_item_create",
              job_id: jobId,
              actor: "paperclip-ai-campaign",
              details: {
                batchId,
                batchIndex: index + 1,
                batchSize: count,
                topic: pack.topic,
                tone,
                durationSec,
                workerUrl,
                workerHttpStatus: workerResponse.status,
                aiProvider: campaign.provider,
                fallbackUsed: campaign.fallbackUsed,
              },
            }])
          : { ok: true, skipped: true };

        results.push({
          ok: workerResponse.ok,
          batchId,
          batchIndex: index + 1,
          topic: pack.topic,
          hook: pack.hook,
          jobId,
          status: workerPayload.status ?? null,
          videoCreated: workerPayload.videoCreated ?? null,
          files,
          mp4: files.find((file) => file.file === "final_reel.mp4")?.absoluteUrl ?? null,
          supabase: { jobs: supabaseJobs, audit: supabaseAudit },
        });
      } catch (error) {
        results.push({
          ok: false,
          batchId,
          batchIndex: index + 1,
          topic: pack.topic,
          error: error instanceof Error ? error.message : "ai_campaign_item_failed",
        });
      }
    }

    await insertSupabaseRows("sink_dink_audit_log", [{
      event_type: "ai_campaign_create_summary",
      job_id: batchId,
      actor: "paperclip-ai-campaign",
      details: {
        batchId,
        requestedTopic: topic,
        requestedCount: count,
        successCount: results.filter((item) => item.ok === true).length,
        failedCount: results.filter((item) => item.ok !== true).length,
        tone,
        durationSec,
        aiProvider: campaign.provider,
        fallbackUsed: campaign.fallbackUsed,
        fallbackReason: campaign.reason,
      },
    }]);

    res.json({
      ok: results.every((item) => item.ok === true),
      service: "sink-dink-ai-campaign",
      mode: "ai-campaign-create",
      batchId,
      ai: {
        provider: campaign.provider,
        model: campaign.model,
        fallbackUsed: campaign.fallbackUsed,
        reason: campaign.reason,
      },
      count,
      successCount: results.filter((item) => item.ok === true).length,
      failedCount: results.filter((item) => item.ok !== true).length,
      results,
      humanApprovalRequired: true,
      publishingBlocked: true,
    });
  });

  return router;
}
