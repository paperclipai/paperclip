import { Router } from "express";

const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAMPAIGN_COUNT = 10;

const DEFAULT_TONE = "smart Hinglish, relatable, emotionally sharp, Instagram top-page style";
const DEFAULT_TOPIC = "SINK DINK India me family pressure aur personal freedom";
const APPROVAL_STATUS = "pending_human_approval";

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

type QaResult = {
  score: number;
  approvalStatus: string;
  publishingBlocked: boolean;
  checks: {
    hasHook: boolean;
    hasScript: boolean;
    scriptLineCount: number;
    hasCaption: boolean;
    hasHashtags: boolean;
    hasMp4: boolean;
    topicLooksClean: boolean;
    noBlockedLanguage: boolean;
  };
  notes: string[];
};

const FALLBACK_PACK_LIBRARY: Array<Omit<CampaignPack, "approvalStatus">> = [
  {
    title: "Good News Pressure",
    topic: "Good news kab doge pressure ka calm reply",
    hook: "Good news ka answer calendar se nahi, readiness se aata hai.",
    script: [
      "Good news kab doge? Ye sawaal cute lagta hai, par pressure real hota hai.",
      "Har couple ka timeline same nahi hota. Career, health, paisa aur peace bhi matter karta hai.",
      "Family ka respect alag cheez hai, apni marriage ka decision alag.",
      "Good news tabhi good hoti hai jab dono ready hon, sirf society ready na ho."
    ],
    caption: "Good news pressure ko calm mind se handle karna bhi relationship maturity hai.",
    hashtags: ["#SINKDINKIndia", "#GoodNewsPressure", "#ModernMarriage", "#IndianCouples", "#PersonalChoice"],
    visualStyle: "premium dark minimal Indian Instagram reel"
  },
  {
    title: "Financial Peace First",
    topic: "Indian couple ka financial peace before baby decision",
    hook: "Baby se pehle budget ka peace bhi zaroori hai.",
    script: [
      "Shaadi ke baad next question hota hai: baby kab?",
      "Par koi ye nahi poochta: emergency fund hai? mental peace hai? relationship stable hai?",
      "SINK DINK ka matlab anti-family nahi, responsible planning hai.",
      "Jab foundation strong hota hai, tab decision bhi healthy hota hai."
    ],
    caption: "Financial peace selfish nahi hota. Responsible marriage ka part hota hai.",
    hashtags: ["#SINKDINKIndia", "#FinancialPeace", "#DINKCouple", "#MoneyMindsetIndia", "#MarriagePlanning"],
    visualStyle: "clean finance-emotion hybrid reel"
  },
  {
    title: "Selfish Label",
    topic: "No kids by choice ko selfish samajhne wali society",
    hook: "Har no-kids choice selfish nahi hoti; kabhi-kabhi honest hoti hai.",
    script: [
      "No kids by choice sunte hi log bol dete hain: selfish.",
      "Par kya bina readiness ke parent banna selfless hai?",
      "Apni capacity samajhna, partner se honestly baat karna, future plan karna — ye maturity hai.",
      "Choice ko judge karne se pehle uske context ko samjho."
    ],
    caption: "Choice ko label karna easy hai. Context samajhna maturity hai.",
    hashtags: ["#NoKidsByChoice", "#SINKDINKIndia", "#ChildfreeIndia", "#ModernRelationships", "#LifeChoices"],
    visualStyle: "bold emotional opinion reel"
  },
  {
    title: "Marriage Timeline",
    topic: "Marriage me apna timeline choose karna wrong nahi hai",
    hook: "Shaadi ka timeline couple ka hota hai, public poll ka nahi.",
    script: [
      "Shaadi hui matlab next step automatic baby nahi hota.",
      "Har couple ka phase alag hota hai: growth, savings, travel, health, career.",
      "Apna timeline choose karna rebellion nahi, responsibility ho sakti hai.",
      "Relationship tab strong hota hai jab decision dono ka ho, pressure ka nahi."
    ],
    caption: "Apna timeline choose karna wrong nahi hai. Bas honest aur responsible hona zaroori hai.",
    hashtags: ["#SINKDINKIndia", "#MarriageTimeline", "#IndianMarriage", "#CoupleGoals", "#HealthyBoundaries"],
    visualStyle: "premium relationship advice reel"
  },
  {
    title: "Family Respect + Boundaries",
    topic: "Family pressure aur personal freedom ka balance",
    hook: "Family ko respect do, par apni life ka steering wheel bhi pakdo.",
    script: [
      "Indian families care karti hain, isliye pressure bhi karti hain.",
      "Par care aur control ke beech ek line hoti hai.",
      "SINK DINK couples family ko reject nahi karte, bas apni readiness ko ignore nahi karte.",
      "Respectful boundaries relationship aur family dono ko healthy rakhte hain."
    ],
    caption: "Respectful boundaries = family bhi important, relationship peace bhi important.",
    hashtags: ["#SINKDINKIndia", "#FamilyPressure", "#Boundaries", "#IndianCouples", "#PersonalFreedom"],
    visualStyle: "calm premium family-boundary reel"
  },
  {
    title: "Career And Couple Peace",
    topic: "Career growth ke phase me couple planning ka pressure",
    hook: "Career build karna family ke against jaana nahi hota.",
    script: [
      "Kuch couples pehle apna career aur stability build karna chahte hain.",
      "Iska matlab family se door hona nahi, future ko responsibly plan karna hai.",
      "Har season ka apna purpose hota hai: growth, savings, health, peace.",
      "Pressure se nahi, partnership se decision strong banta hai."
    ],
    caption: "Career phase ko guilt ke saath nahi, clarity ke saath live karo.",
    hashtags: ["#SINKDINKIndia", "#CareerCouple", "#IndianCouples", "#FuturePlanning", "#MarriageLife"],
    visualStyle: "modern career lifestyle reel"
  },
  {
    title: "Boundary Without Drama",
    topic: "Family ko respect dekar boundary set karna",
    hook: "Boundary ka matlab badtameezi nahi; clarity hoti hai.",
    script: [
      "Indian homes me pyaar ke saath opinions bhi aate hain.",
      "Par every opinion ko life decision banana zaroori nahi hota.",
      "Respectfully bolna: abhi hum ready nahi hain — mature answer hai.",
      "Peaceful boundary relationship ko bhi bachati hai, family bond ko bhi."
    ],
    caption: "Boundary drama nahi hoti. Boundary clarity hoti hai.",
    hashtags: ["#SINKDINKIndia", "#HealthyBoundaries", "#FamilyRespect", "#IndianFamily", "#CouplePeace"],
    visualStyle: "soft premium boundary reel"
  },
  {
    title: "Social Approval Trap",
    topic: "Couple peace over social approval",
    hook: "Sabko khush karte karte couple ka peace lose mat karo.",
    script: [
      "Society ko update chahiye, couple ko peace chahiye.",
      "Dono cheezein hamesha same direction me nahi chalti.",
      "Apne relationship ka pressure meter samajhna important hai.",
      "Approval ke peeche bhaagne se better hai clarity ke saath jeena."
    ],
    caption: "Social approval temporary hai. Couple peace daily life hai.",
    hashtags: ["#SINKDINKIndia", "#CouplePeace", "#SocialPressure", "#ModernRelationships", "#PersonalFreedom"],
    visualStyle: "sharp social commentary reel"
  },
  {
    title: "Honest Childfree Explanation",
    topic: "Childfree decision ka mature explanation",
    hook: "No kids decision loud nahi, honest bhi ho sakta hai.",
    script: [
      "Har no-kids choice rebellion nahi hoti.",
      "Kabhi ye self-awareness hoti hai: hum kya handle kar sakte hain aur kya nahi.",
      "Maturity ka matlab bas society follow karna nahi, honest decision lena bhi hai.",
      "Respectful choice ko insult samajhna zaroori nahi."
    ],
    caption: "Honest choice ko judgement nahi, understanding chahiye.",
    hashtags: ["#ChildfreeIndia", "#SINKDINKIndia", "#NoKidsByChoice", "#LifeDesign", "#MatureChoices"],
    visualStyle: "minimal reflective opinion reel"
  },
  {
    title: "Balanced SINK DINK Life",
    topic: "Indian SINK DINK lifestyle ka balanced view",
    hook: "SINK DINK lifestyle anti-family nahi; intentional life design hai.",
    script: [
      "SINK DINK ka matlab bas no kids nahi hota.",
      "Isme planning, partnership, savings, freedom aur responsibility sab aata hai.",
      "Har couple ka life design alag hota hai.",
      "Balanced choice tabhi banti hai jab dono partners clear hon."
    ],
    caption: "Intentional life design ko selfish label karna easy hai, samajhna mature hai.",
    hashtags: ["#SINKDINKIndia", "#IntentionalLiving", "#DINKLife", "#IndianLifestyle", "#CouplePlanning"],
    visualStyle: "premium lifestyle explainer reel"
  }
];

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

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanTopic(value: string, baseTopic: string, fallbackTopic: string): string {
  let topic = compactText(value || fallbackTopic);
  const base = compactText(baseTopic);
  if (topic.toLowerCase().startsWith(`${base.toLowerCase()}:`)) {
    topic = compactText(topic.slice(base.length + 1));
  }
  topic = topic.replace(/^SINK\s*DINK\s*India\s*[:\-–]\s*/i, "");
  topic = topic.replace(/^SINK\/DINK\s*India\s*[:\-–]\s*/i, "");
  topic = topic.replace(/^family pressure aur personal freedom\s*[:\-–]\s*/i, "Family pressure aur personal freedom ka balance");
  if (!topic || topic.length < 8) return fallbackTopic;
  return topic.length > 95 ? `${topic.slice(0, 92).trim()}...` : topic;
}

function cleanHook(value: string, fallbackHook: string): string {
  const hook = compactText(value || fallbackHook).replace(/^hook\s*[:\-–]\s*/i, "");
  if (!hook || hook.length < 12) return fallbackHook;
  return hook.length > 130 ? `${hook.slice(0, 127).trim()}...` : hook;
}

function ensureHashtags(value: string[], fallback: string[]): string[] {
  const seen = new Set<string>();
  const tags = [...value, ...fallback, "#SINKDINKIndia"]
    .map((tag) => compactText(tag).replace(/\s+/g, ""))
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
  return tags.length > 0 ? tags : ["#SINKDINKIndia"];
}

function fallbackCampaignPacks(_baseTopic: string, count: number, tone: string): CampaignPack[] {
  return Array.from({ length: count }, (_item, index) => {
    const pack = FALLBACK_PACK_LIBRARY[index % FALLBACK_PACK_LIBRARY.length];
    return {
      ...pack,
      visualStyle: `${pack.visualStyle}, ${tone}`,
      approvalStatus: APPROVAL_STATUS,
    };
  });
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

function validateCampaignPacks(value: unknown, fallback: CampaignPack[], baseTopic: string, count: number): CampaignPack[] {
  if (!Array.isArray(value)) return fallback.slice(0, count);

  const hooks = new Set<string>();
  const topics = new Set<string>();
  const packs: CampaignPack[] = [];

  value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .slice(0, count)
    .forEach((item, index) => {
      const fallbackPack = fallback[index] ?? fallback[index % fallback.length] ?? fallback[0];
      const script = Array.isArray(item.script)
        ? item.script
            .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
            .map(compactText)
            .slice(0, 6)
        : fallbackPack?.script ?? [];

      let topic = cleanTopic(parseString(item.topic, fallbackPack?.topic ?? DEFAULT_TOPIC), baseTopic, fallbackPack?.topic ?? DEFAULT_TOPIC);
      let hook = cleanHook(parseString(item.hook, fallbackPack?.hook ?? "Good news ka answer calendar se nahi, readiness se aata hai."), fallbackPack?.hook ?? "Good news ka answer calendar se nahi, readiness se aata hai.");

      const topicKey = topic.toLowerCase();
      const hookKey = hook.toLowerCase();
      if (topics.has(topicKey)) topic = fallbackPack?.topic ?? `${DEFAULT_TOPIC} ${index + 1}`;
      if (hooks.has(hookKey)) hook = fallbackPack?.hook ?? `SINK DINK choice ka answer pressure se nahi, clarity se aata hai ${index + 1}.`;

      topics.add(topic.toLowerCase());
      hooks.add(hook.toLowerCase());

      packs.push({
        title: parseString(item.title, fallbackPack?.title ?? `SINK DINK India Reel ${index + 1}`),
        topic,
        hook,
        script: script.length > 0 ? script : fallbackPack?.script ?? [],
        caption: parseString(item.caption, fallbackPack?.caption ?? "Human approval required."),
        hashtags: ensureHashtags(
          Array.isArray(item.hashtags) ? item.hashtags.filter((tag): tag is string => typeof tag === "string") : [],
          fallbackPack?.hashtags ?? ["#SINKDINKIndia"]
        ),
        visualStyle: parseString(item.visualStyle, fallbackPack?.visualStyle ?? "minimal premium Indian Instagram reel"),
        approvalStatus: APPROVAL_STATUS,
      });
    });

  if (packs.length < count) {
    for (let index = packs.length; index < count; index += 1) {
      const fallbackPack = fallback[index] ?? fallback[index % fallback.length];
      packs.push(fallbackPack);
    }
  }

  return packs.filter((pack) => pack.script.length > 0).slice(0, count);
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

function containsBlockedLanguage(pack: CampaignPack): boolean {
  const text = [pack.title, pack.topic, pack.hook, pack.caption, ...pack.script].join(" ").toLowerCase();
  const blocked = ["anti child", "hate kids", "parents are useless", "religion", "caste war", "medical advice", "legal advice"];
  return blocked.some((word) => text.includes(word));
}

function buildQaResult(pack: CampaignPack, files: Array<Record<string, unknown>>, workerOk: boolean): QaResult {
  const hasMp4 = files.some((file) => file.file === "final_reel.mp4" && typeof file.absoluteUrl === "string");
  const checks = {
    hasHook: pack.hook.trim().length >= 12,
    hasScript: pack.script.length >= 4,
    scriptLineCount: pack.script.length,
    hasCaption: pack.caption.trim().length >= 20,
    hasHashtags: pack.hashtags.length >= 3,
    hasMp4: workerOk && hasMp4,
    topicLooksClean: !pack.topic.includes(":") && pack.topic.length <= 95,
    noBlockedLanguage: !containsBlockedLanguage(pack),
  };

  const score = Math.round([
    checks.hasHook,
    checks.hasScript,
    checks.hasCaption,
    checks.hasHashtags,
    checks.hasMp4,
    checks.topicLooksClean,
    checks.noBlockedLanguage,
  ].filter(Boolean).length / 7 * 100);

  const notes: string[] = [];
  if (!checks.topicLooksClean) notes.push("topic_needs_cleanup");
  if (!checks.hasMp4) notes.push("mp4_missing_or_worker_failed");
  if (!checks.noBlockedLanguage) notes.push("blocked_language_review_required");
  if (score < 90) notes.push("manual_quality_review_required");
  if (notes.length === 0) notes.push("ready_for_human_review");

  return {
    score,
    approvalStatus: APPROVAL_STATUS,
    publishingBlocked: true,
    checks,
    notes,
  };
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
    "Create premium Instagram reel content packs for Indian SINK/DINK audience.",
    "SINK/DINK = Single Income No Kids / Double Income No Kids. Respectful no-kids/childfree/couple timeline niche.",
    "Do not create parenting tips, kids activities, anti-child hate, anti-family hate, caste/religion/political attacks, or medical/legal claims.",
    "Tone must be emotionally sharp, respectful, smart Hinglish, relatable, Instagram top-page style.",
    `Base topic for context only: ${input.topic}`,
    `Count exactly: ${input.count}`,
    `Tone: ${input.tone}`,
    "Return ONLY valid JSON array. No markdown. No explanation.",
    "Important quality rules:",
    "- Every topic must be concise, clean, unique, and must NOT repeat or prefix the base topic.",
    "- Every hook must be unique, non-repeated, and emotionally sharp.",
    "- Each script must be 4 short Hinglish lines, suitable for 20-30 sec reel.",
    "- Each caption must be short, premium, and approval-safe.",
    "Each object must have exactly: title, topic, hook, script(array of 4 short Hinglish lines), caption, hashtags(array), visualStyle.",
  ].join("\n");

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.45, maxOutputTokens: 3500, responseMimeType: "application/json" },
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

    const packs = validateCampaignPacks(extractJsonArray(output), fallback, input.topic, input.count);
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
      agentsRunMode: "paused_human_approval",
      humanApprovalRequired: true,
      publishingBlocked: true,
      qualityGates: ["unique_hooks", "clean_topics", "qa_score", "mp4_required", "manual_approval"],
    });
  });

  router.post("/sink-dink/ai-campaign/create", async (req, res) => {
    const workerUrl = getMediaWorkerUrl();
    if (!workerUrl) {
      res.status(503).json({ ok: false, error: "MEDIA_WORKER_URL is not configured" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const topic = parseString(body.topic, DEFAULT_TOPIC);
    const count = Math.min(MAX_CAMPAIGN_COUNT, Math.max(1, Math.floor(parsePositiveNumber(body.count, 5))));
    const tone = parseString(body.tone, DEFAULT_TONE);
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
        const qa = buildQaResult(pack, files, workerResponse.ok);

        const supabaseJobs = jobId
          ? await insertSupabaseRows("sink_dink_jobs", [{
              job_id: jobId,
              source: "paperclip-ai-campaign",
              worker: "huggingface",
              topic: pack.topic,
              status: typeof workerPayload.status === "string" ? workerPayload.status : "created",
              files,
              qa: {
                ...qa,
                workerHttpStatus: workerResponse.status,
                batchId,
                batchIndex: index + 1,
                aiProvider: campaign.provider,
                fallbackUsed: campaign.fallbackUsed,
                agentsRunMode: "paused_human_approval",
              },
              approval_status: APPROVAL_STATUS,
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
                hook: pack.hook,
                tone,
                durationSec,
                workerUrl,
                workerHttpStatus: workerResponse.status,
                aiProvider: campaign.provider,
                fallbackUsed: campaign.fallbackUsed,
                fallbackReason: campaign.reason,
                qaScore: qa.score,
                approvalStatus: APPROVAL_STATUS,
                agentsRunMode: "paused_human_approval",
                humanApprovalRequired: true,
                publishingBlocked: true,
              },
            }])
          : { ok: true, skipped: true };

        results.push({
          ok: workerResponse.ok,
          batchId,
          batchIndex: index + 1,
          topic: pack.topic,
          hook: pack.hook,
          title: pack.title,
          jobId,
          status: workerPayload.status ?? null,
          videoCreated: workerPayload.videoCreated ?? null,
          qaScore: qa.score,
          qa,
          approvalStatus: APPROVAL_STATUS,
          publishingBlocked: true,
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
          approvalStatus: APPROVAL_STATUS,
          publishingBlocked: true,
        });
      }
    }

    const successCount = results.filter((item) => item.ok === true).length;
    const failedCount = results.filter((item) => item.ok !== true).length;
    const averageQaScore = results.length > 0
      ? Math.round(results.reduce((sum, item) => sum + (typeof item.qaScore === "number" ? item.qaScore : 0), 0) / results.length)
      : 0;

    await insertSupabaseRows("sink_dink_audit_log", [{
      event_type: "ai_campaign_create_summary",
      job_id: batchId,
      actor: "paperclip-ai-campaign",
      details: {
        batchId,
        requestedTopic: topic,
        requestedCount: count,
        successCount,
        failedCount,
        averageQaScore,
        tone,
        durationSec,
        aiProvider: campaign.provider,
        fallbackUsed: campaign.fallbackUsed,
        fallbackReason: campaign.reason,
        agentsRunMode: "paused_human_approval",
        humanApprovalRequired: true,
        publishingBlocked: true,
      },
    }]);

    res.json({
      ok: results.every((item) => item.ok === true),
      service: "sink-dink-ai-campaign",
      mode: "ai-campaign-create-v2-quality-gated",
      batchId,
      ai: {
        provider: campaign.provider,
        model: campaign.model,
        fallbackUsed: campaign.fallbackUsed,
        reason: campaign.reason,
      },
      count,
      successCount,
      failedCount,
      averageQaScore,
      results,
      agentsRunMode: "paused_human_approval",
      humanApprovalRequired: true,
      publishingBlocked: true,
    });
  });

  return router;
}
